/**
 * Fetching an `ADD <url>` safely from the client.
 *
 * `ADD` used to run `curl` inside the guest. Moving the fetch to the client
 * matched Docker (which downloads on the builder) and removed the need for curl
 * in the image — but it also moved the request onto the machine RUNNING the
 * SDK, which is a very different network position. A CI runner building an
 * untrusted repository can reach its own cloud metadata service, loopback admin
 * APIs and anything else on its private network. An unrestricted fetch there is
 * a server-side request forgery primitive with the Dockerfile author holding
 * the trigger, and the same Dockerfile's `RUN` has egress to send the answer on.
 *
 * So this module makes that fetch boring:
 *
 * - Only `http` and `https`, checked on every hop rather than only on the URL
 *   the caller wrote.
 * - Every hop's host is resolved and refused if it lands on loopback,
 *   link-local (169.254/16 — cloud metadata), private, reserved or unspecified
 *   space. Checking the literal is not enough: a hostname can simply resolve to
 *   169.254.169.254, and a public URL can redirect to it.
 * - A timeout and a size ceiling, so a slow or endless body cannot hang or
 *   exhaust the build.
 *
 * None of this defends the guest, which the Dockerfile author already controls.
 * It defends the operator.
 */

import dns from "node:dns/promises";
import net from "node:net";

/** Give up on a URL that will not answer. */
export const DEFAULT_TIMEOUT_MS = 30_000;
/** Refuse a body larger than this, counted as it arrives. */
export const MAX_BYTES = 512 * 1024 * 1024;
/** A redirect chain longer than this is a loop or an attack, not a CDN. */
export const MAX_REDIRECTS = 5;

/** A URL this SDK will not fetch, with the reason named. */
export class UrlFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UrlFetchError";
  }
}

function isPrivateV4(address: string): boolean {
  const [a, b] = address.split(".").map(Number);
  if (a === undefined || b === undefined) return false;
  return (
    a === 0 || // unspecified
    a === 10 || // private
    a === 127 || // loopback
    (a === 169 && b === 254) || // link-local, incl. cloud metadata
    (a === 172 && b >= 16 && b <= 31) || // private
    (a === 192 && b === 168) || // private
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    a >= 224 // multicast and reserved
  );
}

function isPrivateV6(address: string): boolean {
  const lower = address.toLowerCase().split("%")[0]!;
  if (lower === "::" || lower === "::1") return true;
  // Any IPv4 address embedded in an IPv6 one gets the v4 rules.
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateV4(mapped[1]!);
  return (
    lower.startsWith("fe80") || // link-local
    lower.startsWith("fc") || // unique-local
    lower.startsWith("fd") ||
    lower.startsWith("ff") // multicast
  );
}

function isNonPublic(address: string): boolean {
  const family = net.isIP(address);
  if (family === 4) return isPrivateV4(address);
  if (family === 6) return isPrivateV6(address);
  return false;
}

/**
 * Resolve `host` and refuse anything that is not public.
 *
 * Resolution is the point. A hostname is not safe just because it looks
 * public: DNS is attacker-controlled for a URL the attacker wrote, so the
 * address it actually resolves to is the only thing worth checking. Every
 * address in the answer is checked, because a name can resolve to several and
 * we cannot control which one the connection picks.
 */
async function refuseInternalAddress(host: string): Promise<void> {
  let addresses: string[];
  if (net.isIP(host)) {
    addresses = [host];
  } else {
    try {
      addresses = (await dns.lookup(host, { all: true })).map((entry) => entry.address);
    } catch (error) {
      throw new UrlFetchError(`cannot resolve ${host}: ${String(error)}`);
    }
  }
  for (const address of addresses) {
    if (isNonPublic(address)) {
      throw new UrlFetchError(
        `refusing to fetch from ${host} (${address}): it resolves to a non-public ` +
          "address. ADD downloads run on the machine building the Dockerfile, so a " +
          "URL pointing at loopback, link-local (cloud metadata) or private space " +
          "would read that machine's internal network on the Dockerfile author's behalf.",
      );
    }
  }
}

async function check(url: string): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new UrlFetchError(`not a valid URL: ${url}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new UrlFetchError(
      `refusing to fetch ${parsed.protocol}: only http and https are supported for ADD`,
    );
  }
  await refuseInternalAddress(parsed.hostname);
  return parsed;
}

/** Download `url`, vetting every redirect hop. Throws {@link UrlFetchError}. */
export async function fetchUrl(
  url: string,
  options: { timeoutMs?: number; maxBytes?: number } = {},
): Promise<Uint8Array> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? MAX_BYTES;
  let current = url;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    await check(current);

    let response: Response;
    try {
      response = await fetch(current, {
        redirect: "manual", // every hop is vetted here, not by the runtime
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new UrlFetchError(`${current}: ${String(error)}`);
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new UrlFetchError(`${current}: redirect with no Location`);
      current = new URL(location, current).toString();
      continue;
    }
    if (!response.ok) {
      throw new UrlFetchError(`${current}: HTTP ${response.status} ${response.statusText}`);
    }

    const declared = Number(response.headers.get("content-length") ?? "0");
    if (declared > maxBytes) {
      throw new UrlFetchError(`${current}: response exceeds the ${maxBytes} byte limit for ADD`);
    }
    const body = new Uint8Array(await response.arrayBuffer());
    if (body.byteLength > maxBytes) {
      throw new UrlFetchError(`${current}: response exceeds the ${maxBytes} byte limit for ADD`);
    }
    return body;
  }

  throw new UrlFetchError(`${url}: more than ${MAX_REDIRECTS} redirects`);
}

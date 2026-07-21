export interface Http2TransportResponse {
  status: number;
  ok: boolean;
  text: string;
}

type Http2Module = typeof import("node:http2");
type Http2Session = ReturnType<Http2Module["connect"]>;

const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
const BUN_RUNTIME = Boolean((globalThis as unknown as {
  process?: { versions?: { bun?: string } };
}).process?.versions?.bun);

// One HTTP/2 session per origin; concurrent requests multiplex over it as streams.
// `confirmed` flips on the first response so the caller can fall back to fetch if the
// origin turns out not to speak HTTP/2.
export class Http2Connection {
  confirmed = false;
  private streams = 0;
  private readonly session: Http2Session;

  constructor(
    http2: Http2Module,
    origin: string,
    private readonly requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  ) {
    this.session = http2.connect(origin);
    this.session.on("error", () => {});
  }

  get closed(): boolean {
    return this.session.closed || this.session.destroyed;
  }

  request(
    method: string,
    path: string,
    headers: Record<string, string>,
    body?: string,
  ): Promise<Http2TransportResponse> {
    // Ref the socket only while requests are in flight, so a pending request keeps
    // the process alive but an idle connection still lets it exit.
    if (this.streams === 0) this.session.ref();
    this.streams++;
    return new Promise<Http2TransportResponse>((resolve, reject) => {
      const stream = this.session.request({ ...headers, ":method": method, ":path": path });
      let status = 0;
      let text = "";
      stream.setEncoding("utf8");

      if (!BUN_RUNTIME) {
        stream.setTimeout(this.requestTimeoutMs, () => {
          stream.destroy(new Error("HTTP/2 request timed out"));
        });
        stream.on("response", (responseHeaders) => {
          this.confirmed = true;
          status = Number(responseHeaders[":status"]) || 0;
        });
        stream.on("data", (chunk: string) => { text += chunk; });
        stream.on("end", () => resolve({ status, ok: status >= 200 && status < 300, text }));
        stream.on("error", reject);
        stream.end(body);
        return;
      }

      // The session socket is shared by every multiplexed stream, so installing
      // per-stream timeout listeners on that socket retains completed streams.
      // Keep Bun's inactivity tracking local to the request instead.
      let settled = false;
      let lastActivityAt = performance.now();
      let timeout: ReturnType<typeof setTimeout>;
      const resolveOnce = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve({ status, ok: status >= 200 && status < 300, text });
      };
      const rejectOnce = (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(error);
      };
      const armTimeout = (delayMs: number) => {
        timeout = setTimeout(checkTimeout, delayMs);
        timeout.unref();
      };
      const checkTimeout = () => {
        if (settled) return;
        const remainingMs = this.requestTimeoutMs - (performance.now() - lastActivityAt);
        if (remainingMs > 0) {
          armTimeout(remainingMs);
          return;
        }
        const error = new Error("HTTP/2 request timed out");
        stream.destroy(error);
        rejectOnce(error);
      };
      const markActivity = () => {
        lastActivityAt = performance.now();
      };

      stream.on("response", (responseHeaders) => {
        markActivity();
        this.confirmed = true;
        status = Number(responseHeaders[":status"]) || 0;
      });
      stream.on("headers", markActivity);
      stream.on("trailers", markActivity);
      stream.on("data", (chunk: string) => {
        markActivity();
        text += chunk;
      });
      stream.once("end", resolveOnce);
      stream.once("error", rejectOnce);
      armTimeout(this.requestTimeoutMs);
      try {
        stream.end(body);
      } catch (error) {
        rejectOnce(error);
      }
    }).finally(() => {
      if (--this.streams === 0) this.session.unref();
    });
  }
}

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";

const port = Number.parseInt(process.env.PORT ?? "8080", 10);
const root = resolve(process.env.APP_DIST_DIR ?? "/workspace/react-policy/dist");
const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

async function resolveAsset(pathname) {
  const requested = resolve(root, `.${pathname}`);
  if (requested !== root && !requested.startsWith(`${root}${sep}`)) {
    return null;
  }

  try {
    const details = await stat(requested);
    return details.isDirectory() ? resolve(requested, "index.html") : requested;
  } catch {
    return resolve(root, "index.html");
  }
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://localhost");

  if (url.pathname === "/healthz") {
    response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    response.end("ok\n");
    return;
  }

  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    response.writeHead(400);
    response.end("bad request\n");
    return;
  }

  const asset = await resolveAsset(pathname);
  if (!asset) {
    response.writeHead(403);
    response.end("forbidden\n");
    return;
  }

  try {
    const details = await stat(asset);
    if (!details.isFile()) {
      throw new Error("not a file");
    }

    response.writeHead(200, {
      "cache-control": asset.endsWith("index.html")
        ? "no-cache"
        : "public, max-age=31536000, immutable",
      "content-length": details.size,
      "content-type": contentTypes[extname(asset)] ?? "application/octet-stream",
    });
    createReadStream(asset).pipe(response);
  } catch {
    response.writeHead(404);
    response.end("not found\n");
  }
});

server.listen(port, "0.0.0.0", () => {
  console.log(`React demo listening on http://0.0.0.0:${port}`);
});

import { createServer, request as proxyRequest } from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { resolve, extname } from "node:path";
const root = resolve("apps/web/dist");
const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};
const apiPort = Number(process.env.API_PORT ?? 3001);
const port = Number(process.env.APP_PORT ?? 4173);
const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  if (url.pathname.startsWith("/v1/") || url.pathname === "/health") {
    const headers = { ...req.headers, host: `127.0.0.1:${apiPort}` };
    delete headers["x-forwarded-for"];
    delete headers["x-forwarded-host"];
    delete headers["x-forwarded-proto"];
    const upstream = proxyRequest(
      {
        hostname: "127.0.0.1",
        port: apiPort,
        method: req.method,
        path: req.url,
        headers,
      },
      (response) => {
        res.writeHead(response.statusCode ?? 502, response.headers);
        response.pipe(res);
      },
    );
    upstream.setTimeout(30000, () =>
      upstream.destroy(new Error("upstream timeout")),
    );
    upstream.on("error", () => {
      if (!res.headersSent) {
        res.writeHead(502, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        });
        res.end(
          JSON.stringify({
            error: {
              code: "service_unavailable",
              message:
                "Suica Pay is temporarily unavailable. Please try again shortly.",
            },
          }),
        );
      } else res.destroy();
    });
    req.pipe(upstream);
    return;
  }
  if (!["GET", "HEAD"].includes(req.method ?? "")) {
    res.writeHead(405);
    res.end();
    return;
  }
  try {
    const pathname = decodeURIComponent(url.pathname);
    if (
      pathname.includes("\0") ||
      pathname.split("/").some((v) => v.startsWith("."))
    ) {
      res.writeHead(404);
      res.end();
      return;
    }
    let file = resolve(root, "." + pathname);
    if (file !== root && !file.startsWith(root + "/")) {
      res.writeHead(404);
      res.end();
      return;
    }
    const info = await stat(file).catch(() => null);
    if (!info?.isFile()) {
      if (extname(pathname) || pathname.startsWith("/assets/")) {
        res.writeHead(404);
        res.end();
        return;
      }
      file = resolve(root, "index.html");
    }
    const extension = extname(file);
    res.setHeader(
      "Content-Type",
      mime[extension] ?? "application/octet-stream",
    );
    res.setHeader(
      "Cache-Control",
      pathname.startsWith("/assets/")
        ? "public, max-age=31536000, immutable"
        : "no-store",
    );
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    const stream = createReadStream(file);
    stream.on("error", () => {
      if (!res.headersSent) res.writeHead(503);
      res.end("Suica Pay is temporarily unavailable.");
    });
    stream.pipe(res);
  } catch {
    if (!res.headersSent) res.writeHead(400);
    res.end();
  }
});
server.listen(port, "127.0.0.1", () =>
  console.log(`Suica Pay app gateway listening on http://127.0.0.1:${port}`),
);
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => server.close());

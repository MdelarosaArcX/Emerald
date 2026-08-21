#!/usr/bin/env node
"use strict";

// Production stand-in for `vite dev` for the two Vue frontends.
//
// In development each frontend is served by Vite, which does two jobs at once: hand out the app's
// files, and proxy the API/media/websocket paths to that frontend's backend so the browser only
// ever talks to one origin. A `vite build` produces only the first half, so serving `dist/` from a
// plain static host silently breaks every /api call (they 404 against the static host instead of
// reaching the backend) and every socket.io connection. This script is the missing half: the same
// static-plus-proxy shape Vite provided, with no dependencies beyond Node itself so it can run
// from the installed tree without an npm install of its own.
//
// Configured entirely through the environment so one copy serves both frontends:
//   SERVE_PORT       port to listen on                        (required)
//   SERVE_ROOT       directory holding index.html             (required)
//   SERVE_HOST       bind address                             (default 0.0.0.0)
//   PROXY_TARGET     origin backend requests are forwarded to (optional)
//   PROXY_PREFIXES   comma-separated path prefixes to forward (optional)

const http = require("node:http");
const net = require("node:net");
const fs = require("node:fs");
const path = require("node:path");
const { URL } = require("node:url");

const port = Number(process.env.SERVE_PORT);
const root = process.env.SERVE_ROOT;
const host = process.env.SERVE_HOST || "0.0.0.0";
const proxyTarget = process.env.PROXY_TARGET || "";
const proxyPrefixes = (process.env.PROXY_PREFIXES || "")
  .split(",")
  .map((p) => p.trim())
  .filter(Boolean);

if (!Number.isInteger(port) || port <= 0) {
  console.error("[static-server] SERVE_PORT must be a port number.");
  process.exit(1);
}
if (!root || !fs.existsSync(path.join(root, "index.html"))) {
  console.error("[static-server] SERVE_ROOT '" + root + "' does not contain an index.html.");
  process.exit(1);
}

const target = proxyTarget ? new URL(proxyTarget) : null;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json; charset=utf-8",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".m3u8": "application/vnd.apple.mpegurl",
  ".ts": "video/mp2t",
  ".wasm": "application/wasm",
};

function shouldProxy(pathname) {
  return proxyPrefixes.some(
    (prefix) => pathname === prefix || pathname.startsWith(prefix.endsWith("/") ? prefix : prefix + "/")
  );
}

// Keeps a request for "/../../backend/.env" from escaping SERVE_ROOT. Resolve first, then confirm
// the result is still inside the root — string-level checks on the raw URL miss encoded traversal.
function resolveWithinRoot(pathname) {
  const decoded = decodeURIComponent(pathname);
  const resolved = path.resolve(root, "." + path.posix.normalize(decoded));
  const rootWithSep = path.resolve(root) + path.sep;
  if (resolved !== path.resolve(root) && !resolved.startsWith(rootWithSep)) {
    return null;
  }
  return resolved;
}

function proxyRequest(req, res) {
  const proxied = http.request(
    {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (target.protocol === "https:" ? 443 : 80),
      method: req.method,
      path: req.url,
      headers: Object.assign({}, req.headers, { host: target.host }),
    },
    (upstream) => {
      res.writeHead(upstream.statusCode || 502, upstream.headers);
      upstream.pipe(res);
    }
  );

  proxied.on("error", (err) => {
    // The backend being down is the normal case while the suite is still starting up, so answer
    // with a 502 the frontend can retry rather than tearing this server down.
    console.error("[static-server] proxy error for " + req.method + " " + req.url + ": " + err.message);
    if (!res.headersSent) {
      res.writeHead(502, { "content-type": "application/json; charset=utf-8" });
    }
    res.end(JSON.stringify({ error: "Backend unavailable", detail: err.message }));
  });

  req.pipe(proxied);
}

function serveFile(filePath, req, res) {
  const stat = fs.statSync(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const headers = {
    "content-type": MIME[ext] || "application/octet-stream",
    "content-length": stat.size,
    "last-modified": stat.mtime.toUTCString(),
    // Vite fingerprints everything under /assets, so those files are safe to cache hard; index.html
    // and anything else must be revalidated or an upgraded install keeps serving the old bundle.
    "cache-control": req.url.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache",
    "accept-ranges": "bytes",
  };

  const range = req.headers.range;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (match) {
      const start = match[1] ? Number(match[1]) : 0;
      const end = match[2] ? Number(match[2]) : stat.size - 1;
      if (start <= end && end < stat.size) {
        res.writeHead(206, Object.assign({}, headers, {
          "content-length": end - start + 1,
          "content-range": "bytes " + start + "-" + end + "/" + stat.size,
        }));
        if (req.method === "HEAD") return res.end();
        return fs.createReadStream(filePath, { start, end }).pipe(res);
      }
    }
  }

  res.writeHead(200, headers);
  if (req.method === "HEAD") return res.end();
  fs.createReadStream(filePath).pipe(res);
}

const server = http.createServer((req, res) => {
  let pathname;
  try {
    pathname = new URL(req.url, "http://" + (req.headers.host || "localhost")).pathname;
  } catch {
    res.writeHead(400).end("Bad request");
    return;
  }

  if (target && shouldProxy(pathname)) {
    return proxyRequest(req, res);
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { allow: "GET, HEAD" }).end("Method not allowed");
    return;
  }

  const resolved = resolveWithinRoot(pathname);
  if (!resolved) {
    res.writeHead(403).end("Forbidden");
    return;
  }

  let filePath = resolved;
  if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
    filePath = path.join(filePath, "index.html");
  }

  // SPA fallback: vue-router owns every path that isn't a real file, so a deep link like
  // /projects/42 must return index.html rather than 404.
  if (!fs.existsSync(filePath)) {
    filePath = path.join(root, "index.html");
  }

  try {
    serveFile(filePath, req, res);
  } catch (err) {
    console.error("[static-server] failed to serve " + pathname + ": " + err.message);
    if (!res.headersSent) res.writeHead(500);
    res.end("Internal server error");
  }
});

// socket.io upgrades to a WebSocket after its initial polling handshake. http.createServer does not
// forward 'upgrade' through the normal request handler, so it has to be relayed at the socket level.
server.on("upgrade", (req, clientSocket, head) => {
  let pathname;
  try {
    pathname = new URL(req.url, "http://" + (req.headers.host || "localhost")).pathname;
  } catch {
    return clientSocket.destroy();
  }
  if (!target || !shouldProxy(pathname)) {
    return clientSocket.destroy();
  }

  const upstream = net.connect(Number(target.port) || 80, target.hostname, () => {
    const headerLines = Object.entries(req.headers)
      .map(([key, value]) =>
        Array.isArray(value) ? value.map((v) => key + ": " + v).join("\r\n") : key + ": " + value
      )
      .join("\r\n");
    upstream.write(req.method + " " + req.url + " HTTP/1.1\r\n" + headerLines + "\r\n\r\n");
    if (head && head.length) upstream.write(head);
    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);
  });

  const drop = (err) => {
    if (err) console.error("[static-server] websocket proxy error: " + err.message);
    upstream.destroy();
    clientSocket.destroy();
  };
  upstream.on("error", drop);
  clientSocket.on("error", drop);
});

server.on("error", (err) => {
  console.error("[static-server] listen failed on " + host + ":" + port + ": " + err.message);
  process.exit(1);
});

server.listen(port, host, () => {
  console.log("[static-server] serving " + root + " on http://" + host + ":" + port);
  if (target) {
    console.log("[static-server] proxying " + proxyPrefixes.join(", ") + " -> " + target.origin);
  }
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}

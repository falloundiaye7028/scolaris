import http from "node:http";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const files = {
  "/amy-assistant.js": ["amy-assistant.js", "text/javascript; charset=utf-8"],
  "/amy-assistant.css": ["amy-assistant.css", "text/css; charset=utf-8"],
  "/": ["index.html", "text/html; charset=utf-8"],
  "/connexion": ["connexion.html", "text/html; charset=utf-8"],
  "/inscription-ecole": ["inscription-ecole.html", "text/html; charset=utf-8"],
  "/confirmer-inscription": ["confirmer-inscription.html", "text/html; charset=utf-8"],
  "/connexion-parent": ["connexion-parent.html", "text/html; charset=utf-8"],
  "/confidentialite": ["confidentialite.html", "text/html; charset=utf-8"],
  "/mentions-legales": ["mentions-legales.html", "text/html; charset=utf-8"],
  "/conditions-utilisation": ["conditions-utilisation.html", "text/html; charset=utf-8"],
  "/protection-donnees": ["protection-donnees.html", "text/html; charset=utf-8"],
  "/public.css": ["public.css", "text/css; charset=utf-8"],
  "/demo.css": ["demo.css", "text/css; charset=utf-8"],
  "/demo-scolaris-pay.mp4": ["demo-scolaris-pay.mp4", "video/mp4"],
  "/demo-scolaris-pay-poster.png": ["demo-scolaris-pay-poster.png", "image/png"],
  "/login.js": ["login.js", "text/javascript; charset=utf-8"],
  "/registration.js": ["registration.js", "text/javascript; charset=utf-8"],
  "/registration-confirm.js": ["registration-confirm.js", "text/javascript; charset=utf-8"],
  "/parent-login.js": ["parent-login.js", "text/javascript; charset=utf-8"],
  "/security.js": ["security.js", "text/javascript; charset=utf-8"],
  "/brand.css": ["brand.css", "text/css; charset=utf-8"],
  "/brand-icon.png": ["brand-icon.png", "image/png"],
  "/banniere-scolaris-pay.png": ["banniere-scolaris-pay.png", "image/png"],
  "/robots.txt": ["robots.txt", "text/plain; charset=utf-8"],
  "/sitemap.xml": ["sitemap.xml", "application/xml; charset=utf-8"],
  "/og-scolaris-pay.png": ["og-scolaris-pay.png", "image/png"],
  "/.well-known/security.txt": [".well-known/security.txt", "text/plain; charset=utf-8"],
};

export function createWebServer({ apiPort = Number(process.env.SCOLARIS_API_PORT || 3000) } = {}) {
 return http.createServer(async (req, res) => {
  try {
  const pathname = new URL(req.url, "http://localhost").pathname;
  if (pathname === "/app" || pathname === "/api" || pathname.startsWith("/api/")) {
    const upstream = http.request({ hostname: "127.0.0.1", port: apiPort, path: req.url, method: req.method,
      headers: { ...req.headers, "x-forwarded-host": req.headers.host, "x-forwarded-proto": "http" } }, response => {
      res.writeHead(response.statusCode, response.headers);
      response.pipe(res);
    });
    upstream.on("error", () => { if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "API locale indisponible. Démarrez npm --prefix api run dev." })); });
    req.pipe(upstream);
    return;
  }
  if (!["GET", "HEAD"].includes(req.method)) { res.writeHead(405, { allow: "GET, HEAD" }); return res.end(); }
  const entry = Object.hasOwn(files, pathname) ? files[pathname] : null;
  if (!entry) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    return res.end("Page introuvable");
  }
  const [name, contentType] = entry;
  const body = await readFile(new URL(`./${name}`, import.meta.url));
  res.writeHead(200, { "content-type": contentType, "x-content-type-options": "nosniff" });
  res.end(req.method === "HEAD" ? undefined : body);
  } catch { res.writeHead(500, { "content-type": "text/plain; charset=utf-8" }); res.end("Page indisponible"); }
 });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  createWebServer().listen(5173, "127.0.0.1", () => console.log("SCOLARIS Web : http://127.0.0.1:5173"));
}

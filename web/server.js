import http from "node:http";
import { readFile } from "node:fs/promises";

const files = {
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
};

http.createServer(async (req, res) => {
  const pathname = new URL(req.url, "http://localhost").pathname;
  const entry = files[pathname];
  if (!entry) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    return res.end("Page introuvable");
  }
  const [name, contentType] = entry;
  const body = await readFile(new URL(`./${name}`, import.meta.url));
  res.writeHead(200, { "content-type": contentType, "x-content-type-options": "nosniff" });
  res.end(body);
}).listen(5173, "127.0.0.1", () => console.log("SCOLARIS Web : http://127.0.0.1:5173"));

import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import {
  clearSessionCookie,
  hasPermission,
  isAllowedBrowserOrigin,
  hasSpreadsheetFormula,
  isOpaqueSessionToken,
  loginAttemptKeys,
  newOpaqueToken,
  pagination,
  parseCookies,
  permissionFor,
  quoteCsv,
  sessionCookie,
  validateJsonValue,
} from "../src/security.js";

test("le cookie de session n'est pas accessible au JavaScript", () => {
  const cookie = sessionCookie("secret-token");
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Path=\//);
  assert.doesNotMatch(clearSessionCookie(), /Max-Age=[1-9]/);
});

test("les identifiants de session sont opaques et aléatoires", () => {
  const first = newOpaqueToken();
  const second = newOpaqueToken();
  assert.equal(isOpaqueSessionToken(first), true);
  assert.equal(first.length, 43);
  assert.notEqual(first, second);
  assert.doesNotMatch(first, /\./);
});

test("la limitation distingue compte, adresse et appareil", () => {
  const req = { headers: { "x-forwarded-for": "192.0.2.4", "user-agent": "Test Browser" }, socket: {} };
  const keys = loginAttemptKeys(req, "USER@EXAMPLE.TEST", "test-secret");
  assert.match(keys.account, /^account:/);
  assert.match(keys.address, /^address:/);
  assert.match(keys.device, /^device:/);
  assert.match(keys.combined, /^combined:/);
  assert.equal(Object.keys(keys).length, 4);
});

test("la pagination impose des bornes strictes", () => {
  assert.deepEqual(pagination(new URLSearchParams("limit=20&offset=40")), { limit: 20, offset: 40 });
  assert.throws(() => pagination(new URLSearchParams("limit=201")), /invalid_body/);
  assert.throws(() => pagination(new URLSearchParams("offset=-1")), /invalid_body/);
});

test("les formules de tableur importées sont refusées", () => {
  for (const value of ["=1+1", " +cmd", "\tmalveillant", "\rmalveillant", "@SUM(A1)"]) assert.equal(hasSpreadsheetFormula(value), true);
  assert.equal(hasSpreadsheetFormula("Awa Ndiaye"), false);
});

test("le parseur de cookies ne confond pas les valeurs", () => {
  assert.deepEqual(parseCookies("a=1; scolaris_session=abc%3Ddef"), { a: "1", scolaris_session: "abc=def" });
});

test("les exports neutralisent les formules CSV", () => {
  for (const value of ["=1+1", "+cmd", "-2+3", "@SUM(A1)", "\tmalveillant", "\rmalveillant"]) {
    assert.match(quoteCsv(value), /^"'/);
  }
  assert.equal(quoteCsv("texte, normal"), '"texte, normal"');
  assert.equal(quoteCsv('a"b'), '"a""b"');
});

test("la validation JSON refuse les charges dangereuses", () => {
  assert.throws(() => validateJsonValue({ value: "a\0b" }), /invalid_body/);
  assert.throws(() => validateJsonValue({ ["__proto__"]: "x" }), /invalid_body/);
  assert.doesNotThrow(() => validateJsonValue({ name: "<script>alert(1)</script>", special: "O'Reilly & école" }));
});

test("les origines navigateur étrangères sont refusées", () => {
  const same = { headers: { origin: "https://www.scolarispay.online", host: "www.scolarispay.online", "x-forwarded-proto": "https" } };
  const foreign = { headers: { origin: "https://evil.example", host: "www.scolarispay.online", "x-forwarded-proto": "https" } };
  assert.equal(isAllowedBrowserOrigin(same), true);
  assert.equal(isAllowedBrowserOrigin(foreign), false);
});

test("les rôles scolaires sont appliqués côté serveur", () => {
  assert.equal(hasPermission("owner", "payments.write"), true);
  assert.equal(hasPermission("accountant", "payments.write"), true);
  assert.equal(hasPermission("teacher", "payments.write"), false);
  assert.equal(hasPermission("teacher", "billing.read"), false);
  assert.equal(hasPermission("unknown", "students.read"), false);
  assert.equal(permissionFor("POST", "/api/students"), "students.write");
  assert.equal(permissionFor("GET", "/api/exports/students.csv"), "exports.read");
});

test("l'échappement central neutralise scripts, attributs et caractères spéciaux", async () => {
  const source = await readFile(new URL("../../web/security.js", import.meta.url), "utf8");
  const context = { window: {} };
  vm.runInNewContext(source, context);
  const escapeHtml = context.window.ScolarisSecurity.escapeHtml;
  assert.equal(escapeHtml('<script>alert("x")</script>'), "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
  assert.equal(escapeHtml('" onerror="alert(1)'), "&quot; onerror=&quot;alert(1)");
  assert.equal(escapeHtml("École & O'Reilly"), "École &amp; O&#39;Reilly");
});

test("le HTML public ne contient aucune interface ou donnée privée", async () => {
  const publicHtml = await readFile(new URL("../../web/index.html", import.meta.url), "utf8");
  const privateHtml = await readFile(new URL("../src/private-app.html", import.meta.url), "utf8");
  assert.doesNotMatch(publicHtml, /id="app"|class="side"|data-view="students"|Moussa Fall|École Démo/i);
  assert.doesNotMatch(privateHtml, /localStorage|sessionStorage|Bearer \+|scolaris_token/);
  assert.match(privateHtml, /noindex,nofollow,noarchive/);
});

test("l'inscription publique annonce le prix fixe sans proposer de paiement en ligne", async () => {
  const [home, registration, registrationScript] = await Promise.all([
    readFile(new URL("../../web/index.html", import.meta.url), "utf8"),
    readFile(new URL("../../web/inscription-ecole.html", import.meta.url), "utf8"),
    readFile(new URL("../../web/registration.js", import.meta.url), "utf8"),
  ]);
  assert.match(home, /50[\s  ]*000 FCFA/i);
  assert.match(home, /aucun paiement en ligne/i);
  assert.match(registration, /50[\s  ]*000 FCFA/i);
  assert.match(registration, /conditions|confidentialité/i);
  assert.match(registrationScript, /registration-challenge/);
  assert.match(registrationScript, /data\.available === false/);
  assert.match(registration + registrationScript, /school-registrations/);
  assert.doesNotMatch(home + registration + registrationScript, /Stripe|PayPal|checkout|paymentIntent/i);
});

test("l'application privée n'utilise plus d'attribut d'événement inline et sa CSP verrouille le script", async () => {
  const privateHtml = await readFile(new URL("../src/private-app.html", import.meta.url), "utf8");
  const server = await readFile(new URL("../src/server.js", import.meta.url), "utf8");
  const vercel = await readFile(new URL("../../vercel.json", import.meta.url), "utf8");
  assert.doesNotMatch(privateHtml, /\s(?:onclick|onchange|oninput)\s*=/i);
  const script = privateHtml.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  assert.doesNotThrow(() => new vm.Script(script));
  assert.doesNotMatch(script, /document\.write|\beval\s*\(|new Function/);
  const handlers = script.match(/const actionHandlers=\{([^}]+)\}/)?.[1].split(",").map((name) => name.trim()) || [];
  for (const handler of handlers) assert.match(script, new RegExp(`(?:async\\s+)?function\\s+${handler}\\s*\\(`), `action sans fonction: ${handler}`);
  const referencedHandlers = [...script.matchAll(/data-(?:action|change|input)="([A-Za-z][A-Za-z0-9]*)\(/g)].map((match) => match[1]);
  for (const handler of referencedHandlers) assert.ok(handlers.includes(handler), `action non enregistrée: ${handler}`);
  assert.doesNotMatch(script, /data-action="paymentModal\(\)"[^>]*disabled|disabled[^>]*data-action="paymentModal\(\)"/);
  assert.match(script, /function paymentModal\(\)[^{]*\{[\s\S]*?navigate\('students'\)[\s\S]*?navigate\('invoices'\)/);
  const hash = crypto.createHash("sha256").update(script).digest("base64");
  assert.match(server, new RegExp(hash.replace(/[+/?=]/g, "\\$&")));
  assert.match(vercel, new RegExp(hash.replace(/[+/?=]/g, "\\$&")));
  assert.doesNotMatch(server.match(/content-security-policy[^\n]+/)?.[0] || "", /script-src[^;]*unsafe-inline/);
});

test("le formulaire de connexion utilise POST et les attributs d'accessibilité attendus", async () => {
  const html = await readFile(new URL("../../web/connexion.html", import.meta.url), "utf8");
  assert.match(html, /<form[^>]+method="post"[^>]+action="\/api\/auth\/login"/);
  assert.match(html, /label for="email"/);
  assert.match(html, /id="email"[^>]+autocomplete="email"/);
  assert.match(html, /label for="password"/);
  assert.match(html, /id="password"[^>]+autocomplete="current-password"/);
});

test("le portail parent rend les données uniquement avec des nœuds texte", async () => {
  const script = await readFile(new URL("../../web/parent-login.js", import.meta.url), "utf8");
  assert.match(script, /textContent = text/);
  assert.match(script, /replaceChildren\(\)/);
  assert.doesNotMatch(script, /innerHTML|document\.write/);
});

test("le référencement n'expose aucune route privée et utilise le PNG social attendu", async () => {
  const [robots, sitemap, index, securityText, image] = await Promise.all([
    readFile(new URL("../../web/robots.txt", import.meta.url), "utf8"),
    readFile(new URL("../../web/sitemap.xml", import.meta.url), "utf8"),
    readFile(new URL("../../web/index.html", import.meta.url), "utf8"),
    readFile(new URL("../../web/.well-known/security.txt", import.meta.url), "utf8"),
    readFile(new URL("../../web/og-scolaris-pay.png", import.meta.url)),
  ]);
  assert.match(robots, /Disallow: \/app/);
  assert.match(robots, /Disallow: \/admin/);
  assert.match(robots, /Disallow: \/connexion/);
  assert.match(robots, /Disallow: \/api\//);
  assert.doesNotMatch(sitemap, /connexion|\/app|\/admin|\/api\//);
  assert.match(index, /twitter:card[^>]+summary_large_image/);
  assert.match(index, /og-scolaris-pay\.png/);
  assert.equal(image.readUInt32BE(16), 1200);
  assert.equal(image.readUInt32BE(20), 630);
  assert.match(securityText, /^Contact:/m);
  assert.match(securityText, /^Expires:/m);
  assert.match(securityText, /^Canonical:/m);
});

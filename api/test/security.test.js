import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import {
  clearSessionCookie,
  hasPermission,
  isAllowedBrowserOrigin,
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

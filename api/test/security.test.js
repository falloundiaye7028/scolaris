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
  assert.throws(() => validateJsonValue({ value: "a".repeat(10_001) }), /invalid_body/);
  assert.doesNotThrow(() => validateJsonValue({ base64: "a".repeat(10_001) }, 0, { maxStringLength: 20_000 }));
  assert.throws(() => validateJsonValue({ base64: "a\0b" }, 0, { maxStringLength: 20_000 }), /invalid_body/);
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
  assert.equal(hasPermission("owner", "fee_definitions.write"), true);
  assert.equal(hasPermission("director", "fee_adjustments.write"), true);
  assert.equal(hasPermission("owner", "uniform_delivery.write"), true);
  assert.equal(hasPermission("accountant", "fee_definitions.write"), false);
  assert.equal(hasPermission("accountant", "fee_adjustments.write"), false);
  assert.equal(hasPermission("teacher", "payments.write"), false);
  assert.equal(hasPermission("teacher", "billing.read"), false);
  assert.equal(hasPermission("teacher", "timetable.read"), true);
  assert.equal(hasPermission("teacher", "lesson_sessions.read"), true);
  assert.equal(hasPermission("teacher", "timetable.manage"), false);
  assert.equal(hasPermission("director", "rooms.manage"), true);
  assert.equal(hasPermission("owner", "attendance.reports"), true);
  assert.equal(hasPermission("teacher", "attendance.mark"), true);
  assert.equal(hasPermission("teacher", "attendance.update"), true);
  assert.equal(hasPermission("teacher", "attendance.reports"), false);
  assert.equal(hasPermission("accountant", "attendance.read"), false);
  assert.equal(hasPermission("owner", "assessments.lock"), true);
  assert.equal(hasPermission("director", "grading_settings.manage"), true);
  assert.equal(hasPermission("teacher", "grades.enter"), true);
  assert.equal(hasPermission("teacher", "assessments.lock"), false);
  assert.equal(hasPermission("accountant", "grades.read"), false);
  assert.equal(hasPermission("unknown", "students.read"), false);
  assert.equal(permissionFor("POST", "/api/students"), "students.write");
  assert.equal(permissionFor("POST", "/api/fee-definitions"), "fee_definitions.write");
  assert.equal(permissionFor("POST", "/api/fee-assignments/123/adjust"), "fee_adjustments.write");
  assert.equal(permissionFor("PUT", "/api/uniform-assignments/123/delivery"), "uniform_delivery.write");
  assert.equal(permissionFor("POST", "/api/student-fee-payments"), "payments.write");
  assert.equal(permissionFor("GET", "/api/students/123/statement"), "billing.read");
  assert.equal(permissionFor("GET", "/api/exports/students.csv"), "exports.read");
  assert.equal(permissionFor("GET", "/api/timetable-entries"), "timetable.read");
  assert.equal(permissionFor("POST", "/api/timetable-entries"), "timetable.manage");
  assert.equal(permissionFor("DELETE", "/api/rooms/123"), "rooms.manage");
  assert.equal(permissionFor("GET", "/api/lesson-sessions"), "lesson_sessions.read");
  assert.equal(permissionFor("PUT", "/api/lesson-sessions/123"), "lesson_sessions.manage");
  assert.equal(permissionFor("GET", "/api/assessments"), "assessments.read");
  assert.equal(permissionFor("POST", "/api/assessments"), "assessments.create");
  assert.equal(permissionFor("POST", "/api/assessments/123/grades"), "grades.enter");
  assert.equal(permissionFor("POST", "/api/assessments/123/lock"), "assessments.lock");
  assert.equal(permissionFor("GET", "/api/grade-reports.csv"), "grade_reports.export");
  assert.equal(permissionFor("PUT", "/api/teaching-assignments/123/coefficient"), "grading_settings.manage");
  assert.equal(permissionFor("GET", "/api/attendance/sessions"), "attendance.read");
  assert.equal(permissionFor("POST", "/api/attendance/sessions/123/records"), "attendance.mark");
  assert.equal(permissionFor("POST", "/api/attendance/justifications"), "attendance.justify");
  assert.equal(permissionFor("GET", "/api/attendance/reports"), "attendance.reports");
});

test("l'interface M3 conserve des actions textuelles et une disposition mobile", async () => {
  const privateHtml = await readFile(new URL("../src/private-app.html", import.meta.url), "utf8");
  assert.match(privateHtml, /data-view="attendance"/);
  assert.match(privateHtml, /Marquer tous présents/);
  assert.match(privateHtml, /Enregistrer l’appel/);
  assert.match(privateHtml, /attendance-actions/);
  assert.match(privateHtml, /@media\(max-width:620px\)[\s\S]*attendance-student/);
  assert.match(privateHtml, /Présent[\s\S]*Absent[\s\S]*Retard[\s\S]*Justifié/);
});

test("l'interface M4 couvre évaluations, notes, moyennes et mobile", async () => {
  const privateHtml = await readFile(new URL("../src/private-app.html", import.meta.url), "utf8");
  assert.match(privateHtml, /data-view="grades"/);
  assert.match(privateHtml, /Notes &amp; évaluations/);
  assert.match(privateHtml, /Créer une évaluation/);
  assert.match(privateHtml, /Enregistrer les notes/);
  assert.match(privateHtml, /Publier/);
  assert.match(privateHtml, /Verrouiller/);
  assert.match(privateHtml, /Rapports et moyennes/);
  assert.match(privateHtml, /releve-notes\.csv/);
  assert.match(privateHtml, /@media\(max-width:620px\)[\s\S]*grade-student/);
  assert.match(privateHtml, /Absent[\s\S]*Absence justifiée[\s\S]*Dispensé[\s\S]*En attente/);
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

test("la démonstration vidéo est accessible, différée et sans lecture automatique", async () => {
  const [publicHtml, webServer] = await Promise.all([
    readFile(new URL("../../web/index.html", import.meta.url), "utf8"),
    readFile(new URL("../../web/server.js", import.meta.url), "utf8"),
  ]);
  assert.match(publicHtml, /id="demonstration"/);
  assert.match(publicHtml, /<video[^>]+controls[^>]+playsinline[^>]+preload="metadata"/);
  assert.match(publicHtml, /poster="\/demo-scolaris-pay-poster\.png"/);
  assert.match(publicHtml, /<video[^>]+width="1280" height="720"/);
  assert.match(publicHtml, /<source src="\/demo-scolaris-pay\.mp4" type="video\/mp4">/);
  assert.match(publicHtml, /<figcaption[^>]+id="demonstration-caption"/);
  assert.doesNotMatch(publicHtml, /<video[^>]+autoplay/);
  assert.match(webServer, /"\/demo-scolaris-pay\.mp4": \["demo-scolaris-pay\.mp4", "video\/mp4"\]/);
});

test("la bannière d'accueil est responsive, différée et présentée comme une démonstration", async () => {
  const [publicHtml, webServer, banner] = await Promise.all([
    readFile(new URL("../../web/index.html", import.meta.url), "utf8"),
    readFile(new URL("../../web/server.js", import.meta.url), "utf8"),
    readFile(new URL("../../web/banniere-scolaris-pay.png", import.meta.url)),
  ]);
  assert.match(publicHtml, /<figure class="home-banner">/);
  assert.match(publicHtml, /src="\/banniere-scolaris-pay\.png"[^>]+width="1942" height="809"[^>]+loading="lazy"/);
  assert.match(publicHtml, /class="home-banner-brand brand"[^>]+aria-hidden="true"/);
  assert.match(publicHtml, /statistiques affichés sont fictifs/i);
  assert.match(webServer, /"\/banniere-scolaris-pay\.png": \["banniere-scolaris-pay\.png", "image\/png"\]/);
  assert.equal(banner.readUInt32BE(16), 1942);
  assert.equal(banner.readUInt32BE(20), 809);
});

test("l'inscription publique annonce le prix fixe sans proposer de paiement en ligne", async () => {
  const [home, registration, registrationScript, server] = await Promise.all([
    readFile(new URL("../../web/index.html", import.meta.url), "utf8"),
    readFile(new URL("../../web/inscription-ecole.html", import.meta.url), "utf8"),
    readFile(new URL("../../web/registration.js", import.meta.url), "utf8"),
    readFile(new URL("../src/server.js", import.meta.url), "utf8"),
  ]);
  assert.match(home, /50[\s  ]*000 FCFA/i);
  assert.match(home, /aucun paiement en ligne/i);
  assert.match(registration, /50[\s  ]*000 FCFA/i);
  assert.match(registration, /conditions|confidentialité/i);
  assert.match(registrationScript, /registration-challenge/);
  assert.match(registrationScript, /data\.available === false/);
  assert.match(registration + registrationScript, /school-registrations/);
  assert.match(server, /https:\/\/api\.resend\.com\/emails/);
  assert.doesNotMatch(registration + registrationScript, /RESEND_API_KEY|re_[A-Za-z0-9_-]{20,}/);
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

test("l'interface financière couvre les frais annuels, les versements et la remise des tenues", async () => {
  const privateHtml = await readFile(new URL("../src/private-app.html", import.meta.url), "utf8");
  assert.match(privateHtml, /Frais d’inscription/);
  assert.match(privateHtml, /Tenue scolaire/);
  assert.match(privateHtml, /Tous les élèves actifs de l’année/);
  assert.match(privateHtml, /Confirmer la création collective/);
  assert.match(privateHtml, /Montant du versement/);
  assert.match(privateHtml, /uniformDeliveryModal/);
  assert.match(privateHtml, /Rapports séparés par catégorie/);
  assert.match(privateHtml, /academicYearModal/);
  assert.match(privateHtml, /enrollmentModal/);
});

test("l'interface M2 propose les vues classe et enseignant avec un agenda mobile", async () => {
  const privateHtml = await readFile(new URL("../src/private-app.html", import.meta.url), "utf8");
  assert.match(privateHtml, /data-view="timetable"/);
  assert.match(privateHtml, /Vue classe/);
  assert.match(privateHtml, /Vue enseignant/);
  assert.match(privateHtml, /Affectation pédagogique/);
  assert.match(privateHtml, /schedule-agenda/);
  const mobileCss = privateHtml.match(/@media\(max-width:620px\)\{([^}]|\}(?!\s*@media))*$/m)?.[0] || privateHtml;
  assert.match(mobileCss, /\.schedule-week\{display:none\}/);
  assert.match(mobileCss, /\.schedule-agenda\{display:grid/);
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

test("le référencement n'expose aucune route privée et utilise la nouvelle identité visuelle", async () => {
  const [robots, sitemap, index, securityText, image, brandIcon, brandCss, privateHtml] = await Promise.all([
    readFile(new URL("../../web/robots.txt", import.meta.url), "utf8"),
    readFile(new URL("../../web/sitemap.xml", import.meta.url), "utf8"),
    readFile(new URL("../../web/index.html", import.meta.url), "utf8"),
    readFile(new URL("../../web/.well-known/security.txt", import.meta.url), "utf8"),
    readFile(new URL("../../web/og-scolaris-pay.png", import.meta.url)),
    readFile(new URL("../../web/brand-icon.png", import.meta.url)),
    readFile(new URL("../../web/brand.css", import.meta.url), "utf8"),
    readFile(new URL("../src/private-app.html", import.meta.url), "utf8"),
  ]);
  assert.match(robots, /Disallow: \/app/);
  assert.match(robots, /Disallow: \/admin/);
  assert.match(robots, /Disallow: \/connexion/);
  assert.match(robots, /Disallow: \/api\//);
  assert.doesNotMatch(sitemap, /connexion|\/app|\/admin|\/api\//);
  assert.match(index, /twitter:card[^>]+summary_large_image/);
  assert.match(index, /og-scolaris-pay\.png/);
  assert.match(index, /href="\/brand-icon\.png" type="image\/png"/);
  assert.match(index, /href="\/brand\.css"/);
  assert.match(privateHtml, /src="\/brand-icon\.png"/);
  assert.doesNotMatch(index + privateHtml, /brand\.svg/);
  assert.match(brandCss, /#0d1b3d/i);
  assert.match(brandCss, /#28a745/i);
  assert.equal(image.readUInt32BE(16), 1200);
  assert.equal(image.readUInt32BE(20), 630);
  assert.equal(brandIcon.readUInt32BE(16), 260);
  assert.equal(brandIcon.readUInt32BE(20), 260);
  assert.match(securityText, /^Contact:/m);
  assert.match(securityText, /^Expires:/m);
  assert.match(securityText, /^Canonical:/m);
});

test("toutes les pages publiques utilisent le nouveau logo et son favicon", async () => {
  const pages = [
    "index.html",
    "connexion.html",
    "inscription-ecole.html",
    "confirmer-inscription.html",
    "connexion-parent.html",
    "confidentialite.html",
    "mentions-legales.html",
    "conditions-utilisation.html",
    "protection-donnees.html",
  ];
  for (const page of pages) {
    const html = await readFile(new URL(`../../web/${page}`, import.meta.url), "utf8");
    assert.match(html, /href="\/brand-icon\.png" type="image\/png"/);
    assert.match(html, /rel="apple-touch-icon" href="\/brand-icon\.png"/);
    assert.match(html, /href="\/brand\.css"/);
    assert.doesNotMatch(html, /brand\.svg/);
  }
});

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const server = await readFile(new URL("../src/server.js", import.meta.url), "utf8");
const academicService = await readFile(new URL("../src/academic-service.js", import.meta.url), "utf8");
const timetableService = await readFile(new URL("../src/timetable-service.js", import.meta.url), "utf8");
const authService = await readFile(new URL("../src/auth-service.js", import.meta.url), "utf8");
const vercel = JSON.parse(await readFile(new URL("../../vercel.json", import.meta.url), "utf8"));

test("l'API n'accepte plus de Bearer frontend ni de CORS universel", () => {
  assert.doesNotMatch(server, /authorization\?\.replace\(\/\^Bearer/);
  assert.doesNotMatch(server, /access-control-allow-origin['"]\s*:\s*['"]\*/i);
  assert.match(authService, /parseCookies\(req\.headers\.cookie\)/);
});

test("déconnexion, expiration absolue et inactivité sont effectives côté serveur", () => {
  assert.match(authService, /UPDATE sessions SET revoked_at=now\(\)/);
  assert.match(authService, /s\.expires_at>now\(\) AND s\.absolute_expires_at>now\(\)/);
  assert.match(authService, /LEAST\(absolute_expires_at,now\(\)\+interval '30 minutes'\)/);
  assert.match(authService, /token_hash/);
  assert.match(authService, /clearSessionCookie/);
});

test("le super-administrateur est explicite et les relations tenant sont vérifiées", () => {
  assert.doesNotMatch(server, /SELECT id FROM users ORDER BY created_at,id LIMIT 1/);
  assert.match(server, /is_platform_admin/);
  assert.match(academicService, /EXISTS\(SELECT 1 FROM classes WHERE id=\$3 AND academic_year_id=\$4 AND school_id=\$1\)/);
  assert.match(server, /WHERE id=\$1 AND school_id=\$2 FOR UPDATE/);
});

test("le domaine académique est isolé et l'année courante est transactionnelle", () => {
  assert.match(server, /createAcademicRouter/);
  assert.match(server, /academic-schema\.sql/);
  assert.match(academicService, /pg_advisory_xact_lock/);
  assert.match(academicService, /academic_year\.current_changed/);
  assert.match(academicService, /GET \/api\/enrollments/);
  assert.match(academicService, /UPDATE students AS student[\s\S]+year\.is_current=true/);
});

test("M2 sérialise les calendriers et explique les conflits", () => {
  assert.match(server, /createTimetableRouter/);
  assert.match(server, /timetable-schema\.sql/);
  assert.match(timetableService, /pg_advisory_xact_lock/);
  assert.match(timetableService, /entry\.start_time<\$7::time AND entry\.end_time>\$6::time/);
  assert.match(timetableService, /enseigne déjà en/);
  assert.match(timetableService, /est déjà occupée/);
  assert.match(timetableService, /possède déjà un cours/);
  assert.match(timetableService, /days > 62/);
});

test("l'abonnement plateforme est administré uniquement par les routes privilégiées", () => {
  assert.match(server, /requirePlatformSecurity\(me\)/);
  assert.match(server, /POST \/api\/platform\/subscription-payments\/preview/);
  assert.match(server, /POST \/api\/platform\/subscription-payments/);
  assert.match(server, /amount_received_xof/);
  assert.match(server, /platform_subscription_payment\.confirmed/);
  assert.match(server, /platform_subscription_payment\.cancelled/);
  assert.match(server, /GET \/api\/school\/subscription/);
  assert.match(server, /student_fee_payments/);
  assert.doesNotMatch(server, /stripe|paypal|checkout\.sessions|paymentIntent/i);
});

test("les routes privées ne sont ni publiques, ni indexables, ni mises en cache", () => {
  const appRewrite = vercel.rewrites.find((entry) => entry.source === "/app");
  const appHeaders = vercel.headers.find((entry) => entry.source === "/app");
  assert.equal(vercel.installCommand, "npm ci --prefix api");
  assert.equal(vercel.outputDirectory, "web");
  assert.equal(appRewrite?.destination, "/api/private/app");
  assert.match(server, /\['\/app','\/api\/private\/app'\]\.includes\(url\.pathname\)/);
  assert.match(JSON.stringify(appHeaders), /noindex, nofollow, noarchive/);
  assert.match(JSON.stringify(appHeaders), /private, no-store/);
});

test("Vercel applique les en-têtes transverses demandés", () => {
  const serialized = JSON.stringify(vercel.headers);
  for (const header of ["Strict-Transport-Security", "Cross-Origin-Opener-Policy", "Cross-Origin-Resource-Policy", "X-Content-Type-Options", "Referrer-Policy", "Permissions-Policy", "X-Frame-Options"]) {
    assert.match(serialized, new RegExp(header));
  }
});

test("l'import vérifie taille, extension et signature Excel", () => {
  assert.match(server, /3\*1024\*1024/);
  assert.match(server, /buffer\[0\]!==0x50\|\|buffer\[1\]!==0x4b/);
  assert.match(server, /Maximum 1 000 élèves par import/);
  assert.match(server, /vbaProject/);
  assert.match(server, /Les formules Excel ne sont pas autorisées/);
});

test("les réponses privées imposent des en-têtes de sécurité et aucun cache", () => {
  for (const header of ["strict-transport-security", "cross-origin-opener-policy", "cross-origin-resource-policy", "x-frame-options", "pragma", "x-robots-tag"]) {
    assert.match(server, new RegExp(header));
  }
  assert.match(server, /no-store, private/);
});

test("les exports sont bornés, réauthentifiés et journalisés", () => {
  assert.match(server, /LIMIT 5001/);
  assert.match(server, /requireRecentAuthentication\(me\)/);
  assert.match(server, /students\.exported/);
  assert.match(server, /payments\.exported/);
});

test("la MFA privilégiée est appliquée côté serveur et consommée une seule fois", () => {
  assert.match(server, /mfaEnrollmentRequired&&!me\.mfaEnabled/);
  assert.match(server, /POST \/api\/students\/import[\s\S]{0,120}requireRecentAuthentication\(me\)/);
  assert.match(server, /POST \/api\/payments[\s\S]{0,120}requireRecentAuthentication\(me\)/);
  assert.match(authService, /UPDATE mfa_challenges SET consumed_at=now\(\).*RETURNING id/);
  assert.match(authService, /if \(!consumed\.rowCount\) throw new Error\("invalid_mfa"\)/);
  assert.match(authService, /disableMfa = async \(req, me, password\)/);
});

test("les réponses SQL publiques sélectionnent explicitement leurs champs", () => {
  assert.doesNotMatch(server, /SELECT \*/);
  assert.doesNotMatch(server, /RETURNING \*/);
});

test("les codes parent ne sont jamais placés dans une URL", () => {
  assert.match(server, /POST \/api\/parent\/access/);
  assert.match(server, /Les codes d’accès ne sont plus acceptés dans les URL/);
  assert.doesNotMatch(server, /path:`\/parent\/\$\{token\}`/);
});

test("la connexion PostgreSQL conserve la vérification TLS stricte", () => {
  assert.match(server, /sslmode', 'verify-full'/);
  assert.doesNotMatch(server, /rejectUnauthorized\s*:\s*false/);
});

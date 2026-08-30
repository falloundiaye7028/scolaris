import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const server = await readFile(new URL("../src/server.js", import.meta.url), "utf8");
const vercel = JSON.parse(await readFile(new URL("../../vercel.json", import.meta.url), "utf8"));

test("l'API n'accepte plus de Bearer frontend ni de CORS universel", () => {
  assert.doesNotMatch(server, /authorization\?\.replace\(\/\^Bearer/);
  assert.doesNotMatch(server, /access-control-allow-origin['"]\s*:\s*['"]\*/i);
  assert.match(server, /parseCookies\(req\.headers\.cookie\)/);
});

test("déconnexion, expiration et renouvellement sont effectifs côté serveur", () => {
  assert.match(server, /UPDATE sessions SET revoked_at=now\(\)/);
  assert.match(server, /s\.expires_at>now\(\)/);
  assert.match(server, /UPDATE sessions SET expires_at=\$1,last_seen_at=now\(\)/);
  assert.match(server, /clearSessionCookie/);
});

test("le super-administrateur est explicite et les relations tenant sont vérifiées", () => {
  assert.doesNotMatch(server, /SELECT id FROM users ORDER BY created_at,id LIMIT 1/);
  assert.match(server, /is_platform_admin/);
  assert.match(server, /EXISTS\(SELECT 1 FROM classes WHERE id=\$3 AND academic_year_id=\$4 AND school_id=\$1\)/);
  assert.match(server, /WHERE id=\$1 AND school_id=\$2 FOR UPDATE/);
});

test("les routes privées ne sont ni publiques, ni indexables, ni mises en cache", () => {
  const appRewrite = vercel.rewrites.find((entry) => entry.source === "/app");
  const appHeaders = vercel.headers.find((entry) => entry.source === "/app");
  assert.equal(vercel.outputDirectory, "web");
  assert.equal(appRewrite?.destination, "/api/private/app");
  assert.match(JSON.stringify(appHeaders), /noindex, nofollow, noarchive/);
  assert.match(JSON.stringify(appHeaders), /private, no-store/);
});

test("l'import vérifie taille, extension et signature Excel", () => {
  assert.match(server, /3\*1024\*1024/);
  assert.match(server, /buffer\[0\]!==0x50\|\|buffer\[1\]!==0x4b/);
  assert.match(server, /Maximum 1 000 élèves par import/);
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

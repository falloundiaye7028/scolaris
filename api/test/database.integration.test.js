import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import test from "node:test";

const databaseUrl = process.env.TEST_DATABASE_URL;
const totp = (secret) => {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const character of secret) bits += alphabet.indexOf(character).toString(2).padStart(5, "0");
  const bytes = [];
  for (let index = 0; index + 8 <= bits.length; index += 8) bytes.push(Number.parseInt(bits.slice(index, index + 8), 2));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const digest = crypto.createHmac("sha1", Buffer.from(bytes)).update(counter).digest();
  const offset = digest.at(-1) & 0x0f;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, "0");
};

test("connexion, limitation, sessions, RBAC et isolation multi-établissements", { skip: !databaseUrl }, async (context) => {
  const databaseName = new URL(databaseUrl).pathname.replace(/^\//, "");
  assert.match(databaseName, /test/i, "TEST_DATABASE_URL doit cibler une base dont le nom contient 'test'");

  process.env.DATABASE_URL = databaseUrl;
  process.env.JWT_SECRET = "integration-test-secret-at-least-32-characters";
  process.env.MFA_ENCRYPTION_KEY = Buffer.alloc(32, 11).toString("base64");
  process.env.MFA_ENFORCEMENT = "off";
  process.env.VERCEL = "1";
  process.env.VERCEL_ENV = "preview";
  const [{ default: handler, closeDatabase }, { default: pg }, { default: bcrypt }] = await Promise.all([
    import(`../src/server.js?integration=${Date.now()}`),
    import("pg"),
    import("bcryptjs"),
  ]);
  const admin = new pg.Client({ connectionString: databaseUrl });
  await admin.connect();
  context.after(async () => admin.end());
  context.after(async () => closeDatabase());
  await admin.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");

  const server = http.createServer(handler);
  await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const request = async (path, options = {}) => fetch(`${baseUrl}${path}`, { ...options, headers: { origin: baseUrl, "x-forwarded-proto": "http", ...(options.headers || {}) } });

  await request("/api/health");
  assert.equal((await request("/app")).status, 401);
  const passwordHash = await bcrypt.hash("MotDePasse#2026", 12);
  const schools = await admin.query("INSERT INTO schools(name,slug,subscription_due_date) VALUES('École A','ecole-a',CURRENT_DATE+30),('École B','ecole-b',CURRENT_DATE+30) RETURNING id");
  const [schoolA, schoolB] = schools.rows.map((row) => row.id);
  await admin.query("INSERT INTO users(school_id,name,email,password_hash,role) VALUES($1,'Direction A','direction-a@example.test',$3,'owner'),($1,'Enseignant A','teacher-a@example.test',$3,'teacher'),($2,'Direction B','direction-b@example.test',$3,'owner')", [schoolA, schoolB, passwordHash]);
  const weakLegacyPassword = "Ancien1!";
  const weakLegacyHash = await bcrypt.hash(weakLegacyPassword, 12);
  await admin.query("INSERT INTO users(school_id,name,email,password_hash,role) VALUES($1,'Compte historique','legacy@example.test',$2,'teacher')", [schoolA, weakLegacyHash]);
  const students = await admin.query("INSERT INTO students(school_id,matricule,first_name,last_name) VALUES($1,'A-001','Awa','A'),($2,'B-001','Binta','B') RETURNING id,school_id", [schoolA, schoolB]);

  const legacyLogin = await request("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "legacy@example.test", password: weakLegacyPassword }) });
  assert.equal(legacyLogin.status, 200);
  const migratedLegacyHash = (await admin.query("SELECT password_hash FROM users WHERE email='legacy@example.test'")).rows[0].password_hash;
  assert.match(migratedLegacyHash, /^\$argon2id\$/);

  const invalid = await request("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "absent@example.test", password: "incorrect" }) });
  assert.equal(invalid.status, 401);
  const invalidMessage = (await invalid.json()).error;
  assert.doesNotMatch(invalidMessage, /absent|existe/i);
  const knownInvalid = await request("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "direction-a@example.test", password: "incorrect" }) });
  assert.equal(knownInvalid.status, 401);
  assert.equal((await knownInvalid.json()).error, invalidMessage);

  for (let attempt = 0; attempt < 4; attempt += 1) await request("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "bruteforce@example.test", password: "incorrect" }) });
  await request("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "bruteforce@example.test", password: "incorrect" }) });
  const limited = await request("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "bruteforce@example.test", password: "incorrect" }) });
  assert.equal(limited.status, 429);

  const login = await request("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "direction-a@example.test", password: "MotDePasse#2026" }) });
  assert.equal(login.status, 200);
  const setCookie = login.headers.get("set-cookie");
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /Secure/);
  assert.match(setCookie, /SameSite=Lax/);
  assert.match(setCookie, /Path=\//);
  const cookie = setCookie.split(";")[0];
  assert.ok(cookie.startsWith("scolaris_session="));
  const rawToken = decodeURIComponent(cookie.split("=")[1]);
  assert.equal(rawToken.length, 43);
  assert.doesNotMatch(rawToken, /\./);
  const storedSession = (await admin.query("SELECT token_hash,expires_at,absolute_expires_at FROM sessions WHERE user_id=(SELECT id FROM users WHERE email='direction-a@example.test') ORDER BY created_at DESC LIMIT 1")).rows[0];
  assert.notEqual(storedSession.token_hash, rawToken);
  assert.ok(new Date(storedSession.expires_at) < new Date(storedSession.absolute_expires_at));

  const privateApp = await request("/app", { headers: { cookie } });
  assert.equal(privateApp.status, 200);
  assert.match(privateApp.headers.get("content-type"), /^text\/html/);
  assert.match(privateApp.headers.get("cache-control"), /private/);
  assert.match(privateApp.headers.get("cache-control"), /no-store/);
  assert.equal(privateApp.headers.get("pragma"), "no-cache");
  assert.equal(privateApp.headers.get("cross-origin-opener-policy"), "same-origin");
  assert.match(privateApp.headers.get("x-robots-tag"), /noindex/);
  assert.match(await privateApp.text(), /SCOLARIS PAY/);

  const ownStudents = await request("/api/students", { headers: { cookie } });
  assert.equal(ownStudents.status, 200);
  const ownStudentRows = await ownStudents.json();
  assert.deepEqual(ownStudentRows.map((student) => student.matricule), ["A-001"]);
  assert.equal("school_id" in ownStudentRows[0], false);
  assert.equal("password_hash" in ownStudentRows[0], false);
  assert.equal((await request("/api/students?limit=201", { headers: { cookie } })).status, 400);
  const schoolBStudent = students.rows.find((row) => row.school_id === schoolB).id;
  const crossTenant = await request(`/api/students/${schoolBStudent}`, { method: "PUT", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ matricule: "B-001", firstName: "Intrus", lastName: "Test" }) });
  assert.equal(crossTenant.status, 404);

  const csrf = await request("/api/students", { method: "POST", headers: { cookie, origin: "https://evil.example", "content-type": "application/json" }, body: JSON.stringify({ firstName: "CSRF", lastName: "Refusé" }) });
  assert.equal(csrf.status, 403);
  assert.equal((await request("/api/students", { method: "POST", headers: { cookie, "content-type": "text/plain" }, body: "{}" })).status, 415);

  const xssStudent = await request("/api/students", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ firstName: "<script>alert(1)</script>", lastName: "O'Reilly" }) });
  assert.equal(xssStudent.status, 201);
  assert.equal((await xssStudent.json()).first_name, "<script>alert(1)</script>");
  const formulaCsv = Buffer.from("prénom,nom\n=HYPERLINK(\"https://evil.example\"),Test", "utf8").toString("base64");
  const maliciousImport = await request("/api/students/import", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ fileName: "eleves.csv", mimeType: "text/csv", fileBase64: formulaCsv, preview: true }) });
  assert.equal(maliciousImport.status, 400);

  const teacherLogin = await request("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "teacher-a@example.test", password: "MotDePasse#2026" }) });
  const teacherCookie = teacherLogin.headers.get("set-cookie").split(";")[0];
  assert.equal((await request("/api/invoices", { headers: { cookie: teacherCookie } })).status, 403);
  assert.equal((await request("/api/exports/students.csv", { headers: { cookie: teacherCookie } })).status, 403);

  const expiredLogin = await request("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "direction-b@example.test", password: "MotDePasse#2026" }) });
  const expiredCookie = expiredLogin.headers.get("set-cookie").split(";")[0];
  await admin.query("UPDATE sessions SET expires_at=now()+interval '1 hour',absolute_expires_at=now()-interval '1 minute' WHERE user_id=(SELECT id FROM users WHERE email='direction-b@example.test')");
  assert.equal((await request("/api/me", { headers: { cookie: expiredCookie } })).status, 401);

  await admin.query("UPDATE users SET is_active=false,disabled_at=now() WHERE email='teacher-a@example.test'");
  assert.equal((await request("/api/students", { headers: { cookie: teacherCookie } })).status, 401);

  const resetKnown = await request("/api/auth/password-reset/request", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "direction-a@example.test" }) });
  const resetUnknown = await request("/api/auth/password-reset/request", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "unknown@example.test" }) });
  assert.equal(resetKnown.status, 202);
  assert.equal(resetUnknown.status, 202);
  assert.deepEqual(await resetKnown.json(), await resetUnknown.json());

  assert.equal((await request("/api/auth/logout", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: "{}" })).status, 200);
  assert.equal((await request("/api/me", { headers: { cookie } })).status, 401);

  const sessionCookies = [];
  for (let index = 0; index < 6; index += 1) {
    const response = await request("/api/auth/login", { method: "POST", headers: { "content-type": "application/json", "user-agent": `Session Test ${index}` }, body: JSON.stringify({ email: "direction-a@example.test", password: "MotDePasse#2026" }) });
    assert.equal(response.status, 200);
    sessionCookies.push(response.headers.get("set-cookie").split(";")[0]);
  }
  const activeSessions = Number((await admin.query("SELECT count(*) total FROM sessions WHERE user_id=(SELECT id FROM users WHERE email='direction-a@example.test') AND revoked_at IS NULL AND expires_at>now() AND absolute_expires_at>now()")).rows[0].total);
  assert.equal(activeSessions, 5);
  assert.equal((await request("/api/me", { headers: { cookie: sessionCookies[0], "user-agent": "Session Test 0" } })).status, 401);

  const currentCookie = sessionCookies.at(-1);
  assert.equal((await request("/api/auth/reauthenticate", { method: "POST", headers: { cookie: currentCookie, "user-agent": "Session Test 5", "content-type": "application/json" }, body: JSON.stringify({ password: "MotDePasse#2026" }) })).status, 200);
  const mfaSetup = await request("/api/auth/mfa/setup", { method: "POST", headers: { cookie: currentCookie, "user-agent": "Session Test 5", "content-type": "application/json" }, body: "{}" });
  assert.equal(mfaSetup.status, 200);
  const provisioning = new URL((await mfaSetup.json()).provisioningUri);
  const mfaSecret = provisioning.searchParams.get("secret");
  assert.ok(mfaSecret);
  const mfaConfirm = await request("/api/auth/mfa/confirm", { method: "POST", headers: { cookie: currentCookie, "user-agent": "Session Test 5", "content-type": "application/json" }, body: JSON.stringify({ code: totp(mfaSecret) }) });
  assert.equal(mfaConfirm.status, 200);
  const recoveryCodes = (await mfaConfirm.json()).recoveryCodes;
  assert.equal(recoveryCodes.length, 10);
  const challenged = await request("/api/auth/login", { method: "POST", headers: { "content-type": "application/json", "user-agent": "MFA Test" }, body: JSON.stringify({ email: "direction-a@example.test", password: "MotDePasse#2026" }) });
  assert.equal(challenged.status, 202);
  const challengeCookie = challenged.headers.get("set-cookie").split(";")[0];
  const completed = await request("/api/auth/mfa", { method: "POST", headers: { cookie: challengeCookie, "content-type": "application/json", "user-agent": "MFA Test" }, body: JSON.stringify({ code: recoveryCodes[0] }) });
  assert.equal(completed.status, 200);
  assert.equal((await request("/api/auth/mfa", { method: "POST", headers: { cookie: challengeCookie, "content-type": "application/json", "user-agent": "MFA Test" }, body: JSON.stringify({ code: recoveryCodes[0] }) })).status, 401);
  assert.equal((await request("/api/auth/mfa", { method: "DELETE", headers: { cookie: currentCookie, "user-agent": "Session Test 5", "content-type": "application/json" }, body: JSON.stringify({ password: "MotDePasse#2026" }) })).status, 200);
  const changed = await request("/api/auth/password/change", { method: "POST", headers: { cookie: currentCookie, "user-agent": "Session Test 5", "content-type": "application/json" }, body: JSON.stringify({ currentPassword: "MotDePasse#2026", newPassword: "NouveauMotDePasse2026!" }) });
  assert.equal(changed.status, 200);
  const changedCookie = changed.headers.get("set-cookie").split(";")[0];
  assert.equal((await request("/api/me", { headers: { cookie: currentCookie, "user-agent": "Session Test 5" } })).status, 401);
  assert.equal((await request("/api/me", { headers: { cookie: changedCookie, "user-agent": "Session Test 5" } })).status, 200);
  assert.equal((await request("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "direction-a@example.test", password: "MotDePasse#2026" }) })).status, 401);
  assert.equal((await request("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "direction-a@example.test", password: "NouveauMotDePasse2026!" }) })).status, 200);
  const leakedLogs = Number((await admin.query("SELECT count(*) total FROM security_events WHERE metadata::text ILIKE ANY(ARRAY['%MotDePasse%','%NouveauMotDePasse%','%scolaris_session%','%direction-a@example.test%'])")).rows[0].total);
  assert.equal(leakedLogs, 0);
});

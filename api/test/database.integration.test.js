import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

const databaseUrl = process.env.TEST_DATABASE_URL;

test("connexion, limitation, sessions, RBAC et isolation multi-établissements", { skip: !databaseUrl }, async (context) => {
  const databaseName = new URL(databaseUrl).pathname.replace(/^\//, "");
  assert.match(databaseName, /test/i, "TEST_DATABASE_URL doit cibler une base dont le nom contient 'test'");

  process.env.DATABASE_URL = databaseUrl;
  process.env.JWT_SECRET = "integration-test-secret-at-least-32-characters";
  process.env.VERCEL = "1";
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
  const students = await admin.query("INSERT INTO students(school_id,matricule,first_name,last_name) VALUES($1,'A-001','Awa','A'),($2,'B-001','Binta','B') RETURNING id,school_id", [schoolA, schoolB]);

  const invalid = await request("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "absent@example.test", password: "incorrect" }) });
  assert.equal(invalid.status, 401);
  assert.doesNotMatch((await invalid.json()).error, /absent|existe/i);

  for (let attempt = 0; attempt < 4; attempt += 1) await request("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "bruteforce@example.test", password: "incorrect" }) });
  await request("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "bruteforce@example.test", password: "incorrect" }) });
  const limited = await request("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "bruteforce@example.test", password: "incorrect" }) });
  assert.equal(limited.status, 429);

  const login = await request("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "direction-a@example.test", password: "MotDePasse#2026" }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie").split(";")[0];
  assert.ok(cookie.startsWith("scolaris_session="));

  const privateApp = await request("/app", { headers: { cookie } });
  assert.equal(privateApp.status, 200);
  assert.match(privateApp.headers.get("content-type"), /^text\/html/);
  assert.match(await privateApp.text(), /SCOLARIS PAY/);

  const ownStudents = await request("/api/students", { headers: { cookie } });
  assert.equal(ownStudents.status, 200);
  assert.deepEqual((await ownStudents.json()).map((student) => student.matricule), ["A-001"]);
  const schoolBStudent = students.rows.find((row) => row.school_id === schoolB).id;
  const crossTenant = await request(`/api/students/${schoolBStudent}`, { method: "PUT", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ matricule: "B-001", firstName: "Intrus", lastName: "Test" }) });
  assert.equal(crossTenant.status, 404);

  const teacherLogin = await request("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "teacher-a@example.test", password: "MotDePasse#2026" }) });
  const teacherCookie = teacherLogin.headers.get("set-cookie").split(";")[0];
  assert.equal((await request("/api/invoices", { headers: { cookie: teacherCookie } })).status, 403);

  const expiredLogin = await request("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "direction-b@example.test", password: "MotDePasse#2026" }) });
  const expiredCookie = expiredLogin.headers.get("set-cookie").split(";")[0];
  await admin.query("UPDATE sessions SET expires_at=now()-interval '1 minute' WHERE user_id=(SELECT id FROM users WHERE email='direction-b@example.test')");
  assert.equal((await request("/api/me", { headers: { cookie: expiredCookie } })).status, 401);

  assert.equal((await request("/api/auth/logout", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: "{}" })).status, 200);
  assert.equal((await request("/api/me", { headers: { cookie } })).status, 401);
});

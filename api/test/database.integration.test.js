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
  process.env.CRON_SECRET = "integration-cron-secret";
  delete process.env.SCHOOL_REGISTRATION_WEBHOOK_URL;
  process.env.RESEND_API_KEY = "re_integration_test_only";
  process.env.RESEND_FROM_EMAIL = "SCOLARIS PAY <noreply@mail.scolarispay.online>";
  process.env.PUBLIC_APP_URL = "https://preview.scolarispay.test";
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
  const originalFetch = globalThis.fetch;
  const sentEmails = [];
  globalThis.fetch = async (input, options = {}) => {
    if (String(input) === "https://api.resend.com/emails") {
      sentEmails.push({ headers: options.headers, ...JSON.parse(options.body) });
      return new Response(JSON.stringify({ id: "email-integration-test" }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return originalFetch(input, options);
  };
  context.after(() => { globalThis.fetch = originalFetch; });
  const request = async (path, options = {}) => originalFetch(`${baseUrl}${path}`, { ...options, headers: { origin: baseUrl, "x-forwarded-proto": "http", ...(options.headers || {}) } });

  await request("/api/health");
  assert.equal((await request("/app")).status, 401);
  const passwordHash = await bcrypt.hash("MotDePasse#2026", 12);
  const schools = await admin.query("INSERT INTO schools(name,slug,subscription_due_date) VALUES('École A','ecole-a',CURRENT_DATE+30),('École B','ecole-b',CURRENT_DATE+30) RETURNING id");
  const [schoolA, schoolB] = schools.rows.map((row) => row.id);
  await admin.query("INSERT INTO users(school_id,name,email,password_hash,role) VALUES($1,'Direction A','direction-a@example.test',$3,'owner'),($1,'Caisse A','caisse-a@example.test',$3,'accountant'),($1,'Enseignant A','teacher-a@example.test',$3,'teacher'),($2,'Direction B','direction-b@example.test',$3,'owner')", [schoolA, schoolB, passwordHash]);
  const platformSchool = (await admin.query("INSERT INTO schools(name,slug,subscription_status,professional_email,email_verified_at) VALUES('Administration SCOLARIS','administration-scolaris','active','platform@example.test',now()) RETURNING id")).rows[0].id;
  await admin.query("INSERT INTO users(school_id,name,email,password_hash,role,is_platform_admin,email_verified_at) VALUES($1,'Administrateur plateforme','platform@example.test',$2,'owner',true,now())", [platformSchool, passwordHash]);
  await admin.query("INSERT INTO school_subscriptions(school_id,status,is_exempt,started_at,current_period_start,current_period_end,paid_until,grace_period_end) VALUES($1,'active',false,now(),now(),now()+interval '30 days',now()+interval '30 days',now()+interval '37 days'),($2,'active',false,now(),now(),now()+interval '30 days',now()+interval '30 days',now()+interval '37 days'),($3,'active',true,now(),now(),now()+interval '100 years',now()+interval '100 years',now()+interval '100 years')", [schoolA, schoolB, platformSchool]);
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

  const schoolAStudent = students.rows.find((row) => row.school_id === schoolA).id;
  const dueDate = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  const invoiceResponse = await request("/api/invoices", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ studentId: schoolAStudent, label: "Mensualité test", amountMinor: 10_000, currency: "XOF", dueDate, feeType: "tuition" }) });
  assert.equal(invoiceResponse.status, 201);
  const invoice = await invoiceResponse.json();
  const paymentResponse = await request("/api/payments", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ invoiceId: invoice.id, amountMinor: 4_000, currency: "XOF", method: "Wave", reference: "PAY-TEST-001" }) });
  assert.equal(paymentResponse.status, 201);
  const payment = await paymentResponse.json();
  assert.equal(payment.invoiceStatus, "partial");
  assert.match(payment.receipt.number, /^SCP-/);
  const receipts = await request("/api/receipts", { headers: { cookie } });
  assert.equal(receipts.status, 200);
  assert.ok((await receipts.json()).some((receipt) => receipt.id === payment.receipt.id));
  const excessivePayment = await request("/api/payments", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ invoiceId: invoice.id, amountMinor: 7_000, currency: "XOF", method: "Espèces" }) });
  assert.equal(excessivePayment.status, 400);

  const currentYearResponse = await request("/api/academic-years", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ label: "2026-2027", startsOn: "2026-09-01", endsOn: "2027-07-31", isCurrent: true }) });
  assert.equal(currentYearResponse.status, 201);
  const currentYear = await currentYearResponse.json();
  const nextYearResponse = await request("/api/academic-years", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ label: "2027-2028", startsOn: "2027-09-01", endsOn: "2028-07-31" }) });
  assert.equal(nextYearResponse.status, 201);
  const nextYear = await nextYearResponse.json();
  const currentClassResponse = await request("/api/classes", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ academicYearId: currentYear.id, name: "6e A", level: "6e" }) });
  assert.equal(currentClassResponse.status, 201);
  const currentClass = await currentClassResponse.json();
  const nextClassResponse = await request("/api/classes", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ academicYearId: nextYear.id, name: "5e A", level: "5e" }) });
  assert.equal(nextClassResponse.status, 201);
  const nextClass = await nextClassResponse.json();
  const secondStudentResponse = await request("/api/students", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ firstName: "=Alerte", lastName: "CSV", guardianName: "Parent CSV" }) });
  assert.equal(secondStudentResponse.status, 201);
  const secondStudent = await secondStudentResponse.json();
  for (const studentId of [schoolAStudent, secondStudent.id]) {
    assert.equal((await request("/api/enrollments", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ studentId, classId: currentClass.id, academicYearId: currentYear.id }) })).status, 201);
  }
  assert.equal((await request("/api/enrollments", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ studentId: schoolAStudent, classId: nextClass.id, academicYearId: nextYear.id }) })).status, 201);

  const academicStudents = await (await request("/api/students", { headers: { cookie } })).json();
  assert.equal(academicStudents.find((student) => student.id === schoolAStudent).class_name, "6e A");
  const academicEnrollments = await (await request(`/api/enrollments?studentId=${schoolAStudent}`, { headers: { cookie } })).json();
  assert.equal(academicEnrollments.length, 2);
  assert.deepEqual(new Set(academicEnrollments.map((enrollment) => enrollment.academic_year)), new Set(["2026-2027", "2027-2028"]));

  const switchToNextYear = await request(`/api/academic-years/${nextYear.id}/current`, { method: "PUT", headers: { cookie, "content-type": "application/json" }, body: "{}" });
  assert.equal(switchToNextYear.status, 200);
  const yearsAfterSwitch = await (await request("/api/academic-years", { headers: { cookie } })).json();
  assert.deepEqual(yearsAfterSwitch.filter((year) => year.is_current).map((year) => year.id), [nextYear.id]);
  const studentsInNextYear = await (await request("/api/students", { headers: { cookie } })).json();
  assert.equal(studentsInNextYear.find((student) => student.id === schoolAStudent).class_name, "5e A");
  assert.equal((await request(`/api/academic-years/${currentYear.id}/current`, { method: "PUT", headers: { cookie, "content-type": "application/json" }, body: "{}" })).status, 200);
  const studentsBackInCurrentYear = await (await request("/api/students", { headers: { cookie } })).json();
  assert.equal(studentsBackInCurrentYear.find((student) => student.id === schoolAStudent).class_name, "6e A");

  await assert.rejects(
    admin.query("INSERT INTO academic_years(school_id,label,starts_on,ends_on,is_current) VALUES($1,'Année courante concurrente','2025-09-01','2026-07-31',true)", [schoolA]),
    (error) => error.code === "23505",
  );
  const schoolBYear = (await admin.query("INSERT INTO academic_years(school_id,label,starts_on,ends_on) VALUES($1,'2026-2027','2026-09-01','2027-07-31') RETURNING id", [schoolB])).rows[0];
  await assert.rejects(
    admin.query("INSERT INTO classes(school_id,academic_year_id,name) VALUES($1,$2,'Classe étrangère')", [schoolA, schoolBYear.id]),
    (error) => error.code === "23503",
  );
  const schoolBClass = (await admin.query("INSERT INTO classes(school_id,academic_year_id,name) VALUES($1,$2,'Classe B') RETURNING id", [schoolB, schoolBYear.id])).rows[0];
  await assert.rejects(
    admin.query("INSERT INTO enrollments(school_id,student_id,class_id,academic_year_id) VALUES($1,$2,$3,$4)", [schoolA, schoolAStudent, schoolBClass.id, schoolBYear.id]),
    (error) => error.code === "23503",
  );
  const schoolBGuardian = (await admin.query("INSERT INTO guardians(school_id,full_name) VALUES($1,'Responsable B') RETURNING id", [schoolB])).rows[0];
  await assert.rejects(
    admin.query("INSERT INTO student_guardians(school_id,student_id,guardian_id,relationship) VALUES($1,$2,$3,'parent')", [schoolA, schoolAStudent, schoolBGuardian.id]),
    (error) => error.code === "23503",
  );

  const primaryGuardian = await (await request("/api/guardians", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ fullName: "Responsable principal", phone: "+221770000001" }) })).json();
  const secondaryGuardian = await (await request("/api/guardians", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ fullName: "Responsable secondaire", phone: "+221770000002" }) })).json();
  assert.equal((await request("/api/student-guardians", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ studentId: schoolAStudent, guardianId: primaryGuardian.id, relationship: "mère", isPrimary: true }) })).status, 201);
  assert.equal((await request("/api/student-guardians", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ studentId: schoolAStudent, guardianId: secondaryGuardian.id, relationship: "père", isPrimary: true }) })).status, 201);
  const guardianLinks = await (await request(`/api/student-guardians?studentId=${schoolAStudent}`, { headers: { cookie } })).json();
  assert.equal(guardianLinks.filter((link) => link.is_primary).length, 1);
  assert.equal(guardianLinks.find((link) => link.is_primary).guardian_id, secondaryGuardian.id);

  // M2 — emploi du temps, affectations, conflits et séances matérialisées à la demande.
  const teacherA = (await admin.query("SELECT id FROM users WHERE email='teacher-a@example.test'")).rows[0];
  const teacherA2 = (await admin.query("INSERT INTO users(school_id,name,email,password_hash,role) VALUES($1,'Mme Fall','teacher-a2@example.test',$2,'teacher') RETURNING id", [schoolA, passwordHash])).rows[0];
  const teacherB = (await admin.query("INSERT INTO users(school_id,name,email,password_hash,role) VALUES($1,'Enseignant B','teacher-b@example.test',$2,'teacher') RETURNING id", [schoolB, passwordHash])).rows[0];
  const secondClass = await (await request("/api/classes", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ academicYearId: currentYear.id, name: "6e B", level: "6e" }) })).json();
  const math = await (await request("/api/subjects", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ name: "Mathématiques", code: "MATH" }) })).json();
  const french = await (await request("/api/subjects", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ name: "Français", code: "FR" }) })).json();
  const science = await (await request("/api/subjects", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ name: "Sciences", code: "SCI" }) })).json();
  const room = await (await request("/api/rooms", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ name: "Salle 12", code: "S12", capacity: 40 }) })).json();
  const inactiveRoom = await (await request("/api/rooms", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ name: "Laboratoire fermé", code: "LAB-X" }) })).json();
  assert.equal((await request(`/api/rooms/${inactiveRoom.id}`, { method: "DELETE", headers: { cookie } })).status, 200);
  const assignment = await (await request("/api/teaching-assignments", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ academicYearId: currentYear.id, teacherId: teacherA.id, classId: currentClass.id, subjectId: math.id }) })).json();
  const teacherConflictAssignment = await (await request("/api/teaching-assignments", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ academicYearId: currentYear.id, teacherId: teacherA.id, classId: secondClass.id, subjectId: french.id }) })).json();
  const classConflictAssignment = await (await request("/api/teaching-assignments", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ academicYearId: currentYear.id, teacherId: teacherA2.id, classId: currentClass.id, subjectId: french.id }) })).json();
  const roomConflictAssignment = await (await request("/api/teaching-assignments", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ academicYearId: currentYear.id, teacherId: teacherA2.id, classId: secondClass.id, subjectId: science.id }) })).json();
  const entryPayload = { academicYearId: currentYear.id, teachingAssignmentId: assignment.id, roomId: room.id, weekday: 1, startTime: "08:00", endTime: "10:00", effectiveFrom: "2026-09-01", effectiveTo: "2027-07-31" };
  const firstEntryResponse = await request("/api/timetable-entries", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(entryPayload) });
  assert.equal(firstEntryResponse.status, 201);
  const firstEntry = await firstEntryResponse.json();
  const teacherConflict = await request("/api/timetable-entries", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ ...entryPayload, teachingAssignmentId: teacherConflictAssignment.id, roomId: null, startTime: "09:00", endTime: "11:00" }) });
  assert.equal(teacherConflict.status, 409);
  assert.match((await teacherConflict.json()).error, /enseigne déjà/);
  const classConflict = await request("/api/timetable-entries", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ ...entryPayload, teachingAssignmentId: classConflictAssignment.id, roomId: null, startTime: "08:30", endTime: "09:30" }) });
  assert.equal(classConflict.status, 409);
  assert.match((await classConflict.json()).error, /classe 6e A/);
  const roomConflict = await request("/api/timetable-entries", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ ...entryPayload, teachingAssignmentId: roomConflictAssignment.id, startTime: "08:30", endTime: "09:30" }) });
  assert.equal(roomConflict.status, 409);
  assert.match((await roomConflict.json()).error, /Salle 12 est déjà occupée/);
  const adjacentEntry = await request("/api/timetable-entries", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ ...entryPayload, startTime: "10:00", endTime: "11:00" }) });
  assert.equal(adjacentEntry.status, 201);
  assert.equal((await request("/api/timetable-entries", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ ...entryPayload, startTime: "11:00", endTime: "11:00" }) })).status, 400);
  assert.equal((await request("/api/timetable-entries", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ ...entryPayload, roomId: inactiveRoom.id, startTime: "11:00", endTime: "12:00" }) })).status, 409);
  const inactiveAssignment = await (await request("/api/teaching-assignments", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ academicYearId: currentYear.id, teacherId: teacherA2.id, classId: secondClass.id, subjectId: french.id }) })).json();
  assert.equal((await request(`/api/teaching-assignments/${inactiveAssignment.id}`, { method: "DELETE", headers: { cookie } })).status, 200);
  assert.equal((await request("/api/timetable-entries", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ ...entryPayload, teachingAssignmentId: inactiveAssignment.id, roomId: null, startTime: "11:00", endTime: "12:00" }) })).status, 404);
  assert.equal((await request("/api/teaching-assignments", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ academicYearId: currentYear.id, teacherId: teacherA.id, classId: nextClass.id, subjectId: math.id }) })).status, 404);
  const schoolBRoom = (await admin.query("INSERT INTO rooms(school_id,name,code) VALUES($1,'Salle B','SB') RETURNING id", [schoolB])).rows[0];
  assert.equal((await request("/api/timetable-entries", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ ...entryPayload, roomId: schoolBRoom.id, startTime: "11:00", endTime: "12:00" }) })).status, 404);
  await assert.rejects(
    admin.query("INSERT INTO teaching_assignments(school_id,academic_year_id,teacher_id,class_id,subject_id) VALUES($1,$2,$3,$4,$5)", [schoolA, currentYear.id, teacherB.id, currentClass.id, math.id]),
    (error) => error.code === "23503" || /requires a teacher/.test(error.message),
  );
  const generateSessions = await request("/api/lesson-sessions/generate", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ academicYearId: currentYear.id, from: "2026-09-07", to: "2026-09-07" }) });
  assert.equal(generateSessions.status, 201);
  assert.equal((await generateSessions.json()).created, 2);
  const generatedSessions = await (await request("/api/lesson-sessions?from=2026-09-07&to=2026-09-07", { headers: { cookie } })).json();
  assert.equal(generatedSessions.length, 2);
  const firstSession = generatedSessions.find((session) => session.timetable_entry_id === firstEntry.id);
  const conflictingMove = await request(`/api/lesson-sessions/${firstSession.id}`, { method: "PUT", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ action: "reschedule", sessionDate: "2026-09-07", startTime: "09:30", endTime: "10:30", roomId: room.id }) });
  assert.equal(conflictingMove.status, 409);
  assert.equal((await request(`/api/lesson-sessions/${firstSession.id}`, { method: "PUT", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ action: "reschedule", sessionDate: "2026-09-07", startTime: "11:00", endTime: "12:00", roomId: room.id, title: "Mathématiques déplacées" }) })).status, 200);
  assert.equal((await request(`/api/lesson-sessions/${firstSession.id}`, { method: "PUT", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ action: "cancel", notes: "Séance annulée par la direction" }) })).status, 200);
  const m2TeacherLogin = await request("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "teacher-a@example.test", password: "MotDePasse#2026" }) });
  const m2TeacherCookie = m2TeacherLogin.headers.get("set-cookie").split(";")[0];
  const ownSchedule = await request("/api/timetable-entries", { headers: { cookie: m2TeacherCookie } });
  assert.equal(ownSchedule.status, 200);
  assert.ok((await ownSchedule.json()).every((entry) => entry.teacher_id === teacherA.id));
  assert.equal((await request("/api/timetable-entries", { method: "POST", headers: { cookie: m2TeacherCookie, "content-type": "application/json" }, body: JSON.stringify(entryPayload) })).status, 403);

  const registrationDefinition = { academicYearId: currentYear.id, classId: currentClass.id, name: "Inscription annuelle", feeType: "registration", amountXof: 25_000, isMandatory: true };
  const registrationPreview = await request("/api/fee-assignments/preview", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ definition: registrationDefinition, scope: "class", classId: currentClass.id, dueDate: "2026-09-15" }) });
  assert.equal(registrationPreview.status, 200);
  assert.deepEqual(await registrationPreview.json(), { feeType: "registration", feeTypeLabel: "Frais d’inscription", academicYearId: currentYear.id, scope: "class", studentCount: 2, amountUnitXof: 25_000, amountTotalXof: 50_000, dueDate: "2026-09-15", classIds: [currentClass.id], studentIds: [] });
  const registrationBulkPayload = { definition: registrationDefinition, scope: "class", classId: currentClass.id, dueDate: "2026-09-15", confirmed: true };
  const registrationBulk = await request("/api/fee-assignments/bulk", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(registrationBulkPayload) });
  assert.equal(registrationBulk.status, 201);
  const registrationCreated = await registrationBulk.json();
  assert.equal(registrationCreated.created, 2);
  const duplicateRegistrationFees = await request("/api/fee-assignments/bulk", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(registrationBulkPayload) });
  assert.equal(duplicateRegistrationFees.status, 201);
  assert.equal((await duplicateRegistrationFees.json()).skippedDuplicates, 2);

  const nextRegistration = await request("/api/fee-assignments/bulk", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ definition: { ...registrationDefinition, academicYearId: nextYear.id, classId: nextClass.id }, scope: "student", studentId: schoolAStudent, dueDate: "2027-09-15", confirmed: true }) });
  assert.equal(nextRegistration.status, 201);
  const nextRegistrationData = await nextRegistration.json();
  assert.equal(nextRegistrationData.created, 1);

  const uniformBulk = await request("/api/fee-assignments/bulk", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ definition: { academicYearId: currentYear.id, classId: currentClass.id, name: "Tenue complète 2026", feeType: "uniform", amountXof: 30_000, isMandatory: false }, scope: "class", classId: currentClass.id, dueDate: "2026-10-01", uniformItem: { itemType: "Uniforme complet", size: "M", quantity: 1, unitPriceXof: 30_000 }, confirmed: true }) });
  assert.equal(uniformBulk.status, 201);
  const uniformCreated = await uniformBulk.json();
  assert.equal(uniformCreated.created, 2);

  const schoolAInvoices = await request(`/api/invoices?academicYearId=${currentYear.id}`, { headers: { cookie } });
  assert.equal(schoolAInvoices.status, 200);
  const currentInvoices = await schoolAInvoices.json();
  const registrationInvoice = currentInvoices.find((item) => item.student_id === schoolAStudent && item.fee_type === "registration");
  const uniformInvoice = currentInvoices.find((item) => item.student_id === schoolAStudent && item.fee_type === "uniform");
  const exemptUniformInvoice = currentInvoices.find((item) => item.student_id === secondStudent.id && item.fee_type === "uniform");
  assert.ok(registrationInvoice && uniformInvoice && exemptUniformInvoice);
  assert.equal(uniformInvoice.delivery_status, "to_prepare");

  const discount = await request(`/api/fee-assignments/${uniformInvoice.id}/adjust`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ action: "discount", discountXof: 5_000, reason: "Remise sociale validée par la direction" }) });
  assert.equal(discount.status, 200);
  assert.equal((await discount.json()).discountXof, 5_000);
  const exemption = await request(`/api/fee-assignments/${exemptUniformInvoice.id}/adjust`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ action: "exempt", reason: "Exonération sociale validée par la direction" }) });
  assert.equal(exemption.status, 200);
  assert.equal((await exemption.json()).financialStatus, "exempted");

  const partialRegistration = await request("/api/student-fee-payments", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ allocations: [{ invoiceId: registrationInvoice.id, amountXof: 10_000 }], method: "Wave", reference: "FRAIS-TEST-001" }) });
  assert.equal(partialRegistration.status, 201);
  const partialRegistrationData = await partialRegistration.json();
  assert.equal(partialRegistrationData.financialStatus, "partially_paid");
  const splitPayment = await request("/api/student-fee-payments", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ allocations: [{ invoiceId: registrationInvoice.id, amountXof: 15_000 }, { invoiceId: uniformInvoice.id, amountXof: 10_000 }], method: "Espèces", reference: "FRAIS-TEST-002" }) });
  assert.equal(splitPayment.status, 201);
  const splitPaymentData = await splitPayment.json();
  assert.equal(splitPaymentData.allocations.length, 2);
  const finalUniformPayment = await request("/api/student-fee-payments", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ allocations: [{ invoiceId: uniformInvoice.id, amountXof: 15_000 }], method: "Virement", reference: "FRAIS-TEST-003" }) });
  assert.equal(finalUniformPayment.status, 201);
  assert.equal((await finalUniformPayment.json()).financialStatus, "paid");
  assert.equal((await request("/api/student-fee-payments", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ allocations: [{ invoiceId: uniformInvoice.id, amountXof: 1 }], method: "Espèces", reference: "FRAIS-TEST-OVER" }) })).status, 400);

  const paidUniformBeforeDelivery = (await (await request(`/api/invoices?studentId=${schoolAStudent}&feeType=uniform`, { headers: { cookie } })).json())[0];
  assert.equal(paidUniformBeforeDelivery.financial_status, "paid");
  assert.equal(paidUniformBeforeDelivery.delivery_status, "to_prepare");
  const delivered = await request(`/api/uniform-assignments/${uniformInvoice.id}/delivery`, { method: "PUT", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ deliveryStatus: "delivered", deliveryNote: "Remise au parent contre signature" }) });
  assert.equal(delivered.status, 200);
  assert.equal((await delivered.json()).delivery_status, "delivered");

  const cancelNextRegistration = await request(`/api/fee-assignments/${nextRegistrationData.invoiceIds[0]}/adjust`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ action: "cancel", reason: "Inscription reportée dans un autre établissement" }) });
  assert.equal(cancelNextRegistration.status, 200);
  assert.equal((await cancelNextRegistration.json()).financialStatus, "cancelled");

  const enhancedReceipts = await (await request("/api/receipts", { headers: { cookie } })).json();
  const splitReceipt = enhancedReceipts.find((item) => item.id === splitPaymentData.receipt.id);
  assert.equal(splitReceipt.school_name, "École A");
  assert.equal(splitReceipt.matricule, "A-001");
  assert.equal(splitReceipt.allocations.length, 2);
  assert.equal(splitReceipt.recorded_by_name, "Direction A");
  assert.ok(splitReceipt.allocations.some((item) => item.category === "Tenue scolaire" && item.itemType === "Uniforme complet"));
  assert.ok(splitReceipt.allocations.every((item) => item.academicYear === "2026-2027"));
  const partialReceipt = enhancedReceipts.find((item) => item.id === partialRegistrationData.receipt.id);
  assert.equal(Number(partialReceipt.allocations[0].totalPaidXof), 10_000);
  assert.equal(Number(partialReceipt.allocations[0].balanceXof), 15_000);

  const registrationReport = await request(`/api/reports/fees?feeType=registration&academicYearId=${currentYear.id}`, { headers: { cookie } });
  assert.equal(registrationReport.status, 200);
  const registrationReportData = await registrationReport.json();
  assert.equal(Number(registrationReportData.expected_xof), 50_000);
  assert.equal(Number(registrationReportData.paid_xof), 25_000);
  assert.equal(registrationReportData.paid_students, 1);
  assert.equal(registrationReportData.unpaid_count, 1);
  const uniformReport = await request(`/api/reports/fees?feeType=uniform&academicYearId=${currentYear.id}`, { headers: { cookie } });
  assert.equal(uniformReport.status, 200);
  const uniformReportData = await uniformReport.json();
  assert.equal(Number(uniformReportData.expected_xof), 25_000);
  assert.equal(Number(uniformReportData.paid_xof), 25_000);
  assert.equal(uniformReportData.exempted_count, 1);
  assert.equal(uniformReportData.delivery.delivered, 1);
  assert.ok(uniformReportData.delivery.details.some((item) => item.itemType === "Uniforme complet" && item.size === "M"));
  const feeExport = await request(`/api/exports/fees.csv?feeType=uniform&academicYearId=${currentYear.id}`, { headers: { cookie } });
  assert.equal(feeExport.status, 200);
  const feeExportText = await feeExport.text();
  assert.match(feeExportText, /Tenue scolaire/);
  assert.match(feeExportText, /'=Alerte/);
  const statement = await request(`/api/students/${schoolAStudent}/statement`, { headers: { cookie } });
  assert.equal(statement.status, 200);
  const statementData = await statement.json();
  assert.equal(statementData.summary.registration.balanceXof, 0);
  assert.equal(statementData.summary.uniform.deliveryStatuses[0], "delivered");
  const invalidDeliveryReversal = await request(`/api/uniform-assignments/${uniformInvoice.id}/delivery`, { method: "PUT", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ deliveryStatus: "available", deliveryNote: "Erreur" }) });
  assert.equal(invalidDeliveryReversal.status, 400);
  const correctedDelivery = await request(`/api/uniform-assignments/${uniformInvoice.id}/delivery`, { method: "PUT", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ deliveryStatus: "available", deliveryNote: "Remise annulée après vérification du bordereau" }) });
  assert.equal(correctedDelivery.status, 200);
  assert.equal((await correctedDelivery.json()).delivery_status, "available");
  assert.equal(Number((await admin.query("SELECT count(*)::int total FROM uniform_delivery_events WHERE school_id=$1 AND invoice_id=$2", [schoolA, uniformInvoice.id])).rows[0].total), 2);
  assert.equal(Number((await admin.query("SELECT count(*)::int total FROM platform_subscription_payments WHERE school_id=$1", [schoolA])).rows[0].total), 0);

  const accountantLogin = await request("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "caisse-a@example.test", password: "MotDePasse#2026" }) });
  assert.equal(accountantLogin.status, 200);
  const accountantCookie = accountantLogin.headers.get("set-cookie").split(";")[0];
  assert.equal((await request("/api/fee-definitions", { method: "POST", headers: { cookie: accountantCookie, "content-type": "application/json" }, body: JSON.stringify(registrationDefinition) })).status, 403);
  const secondRegistrationInvoice = currentInvoices.find((item) => item.student_id === secondStudent.id && item.fee_type === "registration");
  const accountantPayment = await request("/api/student-fee-payments", { method: "POST", headers: { cookie: accountantCookie, "content-type": "application/json" }, body: JSON.stringify({ allocations: [{ invoiceId: secondRegistrationInvoice.id, amountXof: 1_000 }], method: "Espèces", reference: "CAISSE-TEST-001" }) });
  assert.equal(accountantPayment.status, 201);
  const accountantPaymentData = await accountantPayment.json();
  const cancelledStudentPayment = await request(`/api/student-payments/${accountantPaymentData.paymentBatch.id}/cancel`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ reason: "Erreur de saisie confirmée par le responsable" }) });
  assert.equal(cancelledStudentPayment.status, 200);
  assert.equal((await cancelledStudentPayment.json()).status, "cancelled");

  const schoolBLoginForFees = await request("/api/auth/login", { method: "POST", headers: { "content-type": "application/json", "user-agent": "School B Fee Isolation" }, body: JSON.stringify({ email: "direction-b@example.test", password: "MotDePasse#2026" }) });
  const schoolBFeeCookie = schoolBLoginForFees.headers.get("set-cookie").split(";")[0];
  assert.equal((await request("/api/student-fee-payments", { method: "POST", headers: { cookie: schoolBFeeCookie, "content-type": "application/json", "user-agent": "School B Fee Isolation" }, body: JSON.stringify({ allocations: [{ invoiceId: registrationInvoice.id, amountXof: 1 }], method: "Espèces", reference: "ISOLATION-TEST" }) })).status, 404);

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
  assert.deepEqual(ownStudentRows.map((student) => student.matricule).sort(), ["A-001", secondStudent.matricule].sort());
  assert.equal("school_id" in ownStudentRows[0], false);
  assert.equal("password_hash" in ownStudentRows[0], false);
  assert.equal((await request("/api/students?limit=201", { headers: { cookie } })).status, 400);
  const schoolBStudent = students.rows.find((row) => row.school_id === schoolB).id;
  const crossTenant = await request(`/api/students/${schoolBStudent}`, { method: "PUT", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ matricule: "B-001", firstName: "Intrus", lastName: "Test" }) });
  assert.equal(crossTenant.status, 404);

  const platformHeaders = { "content-type": "application/json", "user-agent": "Platform Integration Test" };
  const platformLogin = await request("/api/auth/login", { method: "POST", headers: platformHeaders, body: JSON.stringify({ email: "platform@example.test", password: "MotDePasse#2026" }) });
  assert.equal(platformLogin.status, 200);
  const platformCookie = platformLogin.headers.get("set-cookie").split(";")[0];
  assert.equal((await request("/api/platform/clients", { headers: { cookie: platformCookie, "user-agent": "Platform Integration Test" } })).status, 428);
  const platformMfaSetup = await request("/api/auth/mfa/setup", { method: "POST", headers: { ...platformHeaders, cookie: platformCookie }, body: "{}" });
  assert.equal(platformMfaSetup.status, 200);
  const platformMfaSecret = new URL((await platformMfaSetup.json()).provisioningUri).searchParams.get("secret");
  const platformMfaConfirm = await request("/api/auth/mfa/confirm", { method: "POST", headers: { ...platformHeaders, cookie: platformCookie }, body: JSON.stringify({ code: totp(platformMfaSecret) }) });
  assert.equal(platformMfaConfirm.status, 200);

  const registrationChallengeResponse = await request("/api/public/registration-challenge");
  assert.equal(registrationChallengeResponse.status, 200);
  const registrationChallenge = (await registrationChallengeResponse.json()).challenge;
  await new Promise((resolve) => setTimeout(resolve, 1_550));
  const registrationPayload = {
    challenge: registrationChallenge,
    website: "",
    schoolName: "École Inscription Test",
    schoolType: "private",
    country: "Sénégal",
    city: "Dakar",
    address: "10 avenue des Écoles",
    schoolPhone: "+221 77 111 22 33",
    professionalEmail: "contact-inscription@example.test",
    approximateStudentCount: 350,
    ninea: "009999999",
    rccm: "SN.DKR.2026.A.9999",
    firstName: "Aminata",
    lastName: "Sarr",
    representativeTitle: "Directrice",
    representativePhone: "+221 76 444 55 66",
    responsibleEmail: "direction-inscription@example.test",
    password: "MotDePasseInscription2026!",
    passwordConfirmation: "MotDePasseInscription2026!",
    acceptTerms: true,
    acknowledgePrivacy: true,
    confirmRepresentation: true,
  };
  const registration = await request("/api/public/school-registrations", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(registrationPayload) });
  assert.equal(registration.status, 202);
  assert.doesNotMatch((await registration.json()).message, /créé|existe|doublon/i);
  const duplicateRegistration = await request("/api/public/school-registrations", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(registrationPayload) });
  assert.equal(duplicateRegistration.status, 202);
  assert.equal((await admin.query("SELECT count(*)::int total FROM users WHERE email='direction-inscription@example.test'")).rows[0].total, 1);
  const invalidRegistration = await request("/api/public/school-registrations", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...registrationPayload, schoolName: "École Invalide", professionalEmail: "invalide-pro@example.test", responsibleEmail: "invalide@example.test", schoolPhone: "123" }) });
  assert.equal(invalidRegistration.status, 400);
  const confirmationNotification = sentEmails.find((item) => item.subject === "Confirmez votre inscription à SCOLARIS PAY");
  assert.deepEqual(confirmationNotification?.to, ["direction-inscription@example.test"]);
  assert.equal(confirmationNotification?.from, "SCOLARIS PAY <noreply@mail.scolarispay.online>");
  assert.match(confirmationNotification?.headers?.authorization || "", /^Bearer re_/);
  assert.ok(confirmationNotification?.headers?.["Idempotency-Key"]);
  const confirmationUrl = new URL(confirmationNotification.text.match(/https:\/\/[^\s]+/)?.[0]);
  const confirmationToken = new URLSearchParams(confirmationUrl.hash.slice(1)).get("token");
  const confirmation = await request("/api/public/school-registration/confirm", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: confirmationToken }) });
  assert.equal(confirmation.status, 200);
  assert.equal((await request("/api/public/school-registration/confirm", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: confirmationToken }) })).status, 400);
  const registeredSchool = (await admin.query("SELECT id,subscription_status,email_verified_at FROM schools WHERE professional_email='contact-inscription@example.test'")).rows[0];
  assert.equal(registeredSchool.subscription_status, "pending_review");
  assert.ok(registeredSchool.email_verified_at);
  assert.equal((await admin.query("SELECT count(*)::int total FROM users WHERE school_id=$1", [registeredSchool.id])).rows[0].total, 1);

  const pendingLogin = await request("/api/auth/login", { method: "POST", headers: { "content-type": "application/json", "user-agent": "Registered School Test" }, body: JSON.stringify({ email: "direction-inscription@example.test", password: registrationPayload.password }) });
  assert.equal(pendingLogin.status, 200);
  const registeredCookie = pendingLogin.headers.get("set-cookie").split(";")[0];
  const pendingSubscription = await request("/api/school/subscription", { headers: { cookie: registeredCookie, "user-agent": "Registered School Test" } });
  assert.equal(pendingSubscription.status, 200);
  assert.equal((await pendingSubscription.json()).monthlyPriceXof, 50_000);
  assert.equal((await request("/api/students", { headers: { cookie: registeredCookie, "user-agent": "Registered School Test" } })).status, 403);
  const registrationUpdate = await request("/api/school/registration", { method: "PUT", headers: { cookie: registeredCookie, "user-agent": "Registered School Test", "content-type": "application/json" }, body: JSON.stringify({ schoolType: "private", country: "Sénégal", city: "Rufisque", address: "10 avenue des Écoles", schoolPhone: "+221771112233", approximateStudentCount: 360, ninea: "009999999", rccm: "SN.DKR.2026.A.9999", representativeTitle: "Directrice", representativePhone: "+221764445566" }) });
  assert.equal(registrationUpdate.status, 200);
  assert.equal((await admin.query("SELECT city FROM schools WHERE id=$1", [registeredSchool.id])).rows[0].city, "Rufisque");

  const platformAuthHeaders = { ...platformHeaders, cookie: platformCookie };
  const approve = await request(`/api/platform/clients/${registeredSchool.id}/review`, { method: "PUT", headers: platformAuthHeaders, body: JSON.stringify({ action: "approve" }) });
  assert.equal(approve.status, 200);
  const preview = await request("/api/platform/subscription-payments/preview", { method: "POST", headers: platformAuthHeaders, body: JSON.stringify({ schoolId: registeredSchool.id, amountExpectedXof: 1, amountReceivedXof: 50_000, paymentMethod: "wave", paidAt: "2026-08-30" }) });
  assert.equal(preview.status, 200);
  assert.equal((await preview.json()).amountExpectedXof, 50_000);
  const underpayment = await request("/api/platform/subscription-payments", { method: "POST", headers: platformAuthHeaders, body: JSON.stringify({ schoolId: registeredSchool.id, amountReceivedXof: 49_999, paymentMethod: "wave", paidAt: "2026-08-30" }) });
  assert.equal(underpayment.status, 400);
  const firstSubscriptionPayment = await request("/api/platform/subscription-payments", { method: "POST", headers: platformAuthHeaders, body: JSON.stringify({ schoolId: registeredSchool.id, amountExpectedXof: 1, amountReceivedXof: 50_000, paymentMethod: "wave", externalReference: "ABN-TEST-001", paidAt: "2026-08-30", proof: { name: "preuve.pdf", contentType: "application/pdf", base64: Buffer.from("%PDF-1.4\n% test\n").toString("base64") } }) });
  assert.equal(firstSubscriptionPayment.status, 201);
  const firstPayment = await firstSubscriptionPayment.json();
  assert.equal(Number(firstPayment.amount_expected_xof), 50_000);
  assert.equal((await request("/api/students", { headers: { cookie: registeredCookie, "user-agent": "Registered School Test" } })).status, 200);
  assert.equal((await request("/api/platform/subscription-payments", { method: "POST", headers: { ...platformHeaders, cookie: registeredCookie, "user-agent": "Registered School Test" }, body: JSON.stringify({ schoolId: registeredSchool.id, amountReceivedXof: 50_000, paymentMethod: "cash" }) })).status, 403);

  const secondSubscriptionPayment = await request("/api/platform/subscription-payments", { method: "POST", headers: platformAuthHeaders, body: JSON.stringify({ schoolId: registeredSchool.id, amountReceivedXof: 50_000, paymentMethod: "cash", externalReference: "ABN-TEST-002", paidAt: "2026-08-30" }) });
  assert.equal(secondSubscriptionPayment.status, 201);
  const secondPayment = await secondSubscriptionPayment.json();
  assert.equal(new Date(secondPayment.payment_period_start).getTime(), new Date(firstPayment.payment_period_end).getTime() + 1);
  const periodPayments = await request("/api/platform/subscription-payments?from=2026-08-01&to=2026-09-01", { headers: { cookie: platformCookie, "user-agent": "Platform Integration Test" } });
  assert.equal(periodPayments.status, 200);
  assert.ok((await periodPayments.json()).length >= 2);
  assert.equal((await request("/api/platform/subscription-payments?from=2026-09-01&to=2026-08-01", { headers: { cookie: platformCookie, "user-agent": "Platform Integration Test" } })).status, 400);
  assert.equal((await request(`/api/platform/clients/${registeredSchool.id}/subscription`, { method: "PUT", headers: platformAuthHeaders, body: JSON.stringify({ action: "suspend" }) })).status, 200);
  assert.equal((await request(`/api/platform/clients/${registeredSchool.id}/subscription`, { method: "PUT", headers: platformAuthHeaders, body: JSON.stringify({ action: "reactivate" }) })).status, 200);

  await admin.query("UPDATE school_subscriptions SET status='active',paid_until=now()+interval '2 days',grace_period_end=now()+interval '9 days' WHERE school_id=$1", [schoolA]);
  await admin.query("UPDATE school_subscriptions SET status='active',paid_until=now()-interval '1 day',grace_period_end=now()+interval '6 days' WHERE school_id=$1", [registeredSchool.id]);
  await admin.query("UPDATE schools SET subscription_status='active' WHERE id=$1", [registeredSchool.id]);
  assert.equal((await request("/api/cron/subscriptions", { headers: { authorization: "Bearer integration-cron-secret" } })).status, 200);
  assert.equal((await admin.query("SELECT count(*)::int total FROM subscription_notifications WHERE school_id=$1 AND event_type='expiry_reminder'", [schoolA])).rows[0].total, 1);
  assert.equal((await admin.query("SELECT subscription_status FROM schools WHERE id=$1", [registeredSchool.id])).rows[0].subscription_status, "grace_period");
  assert.equal((await request("/api/students", { method: "POST", headers: { cookie: registeredCookie, "user-agent": "Registered School Test", "content-type": "application/json" }, body: JSON.stringify({ firstName: "Lecture", lastName: "Seule" }) })).status, 403);
  await admin.query("UPDATE school_subscriptions SET grace_period_end=now()+interval '1 day' WHERE school_id=$1", [registeredSchool.id]);
  assert.equal((await request("/api/cron/subscriptions", { headers: { authorization: "Bearer integration-cron-secret" } })).status, 200);
  assert.equal((await admin.query("SELECT count(*)::int total FROM subscription_notifications WHERE school_id=$1 AND event_type='suspension_warning'", [registeredSchool.id])).rows[0].total, 1);
  await admin.query("UPDATE school_subscriptions SET grace_period_end=now()-interval '1 second' WHERE school_id=$1", [registeredSchool.id]);
  assert.equal((await request("/api/cron/subscriptions", { headers: { authorization: "Bearer integration-cron-secret" } })).status, 200);
  assert.equal((await admin.query("SELECT subscription_status FROM schools WHERE id=$1", [registeredSchool.id])).rows[0].subscription_status, "suspended");
  assert.equal((await request("/api/students", { headers: { cookie: registeredCookie, "user-agent": "Registered School Test" } })).status, 200);
  assert.equal((await request("/api/exports/students.csv", { headers: { cookie: registeredCookie, "user-agent": "Registered School Test" } })).status, 403);

  const restorationPayment = await request("/api/platform/subscription-payments", { method: "POST", headers: platformAuthHeaders, body: JSON.stringify({ schoolId: registeredSchool.id, amountReceivedXof: 50_000, paymentMethod: "bank_transfer", externalReference: "ABN-TEST-003", paidAt: "2026-08-30" }) });
  assert.equal(restorationPayment.status, 201);
  const restoration = await restorationPayment.json();
  assert.equal((await admin.query("SELECT subscription_status FROM schools WHERE id=$1", [registeredSchool.id])).rows[0].subscription_status, "active");
  const cancelPayment = await request(`/api/platform/subscription-payments/${restoration.id}/cancel`, { method: "POST", headers: platformAuthHeaders, body: JSON.stringify({ reason: "Erreur de saisie constatée lors du contrôle" }) });
  assert.equal(cancelPayment.status, 200);
  assert.equal((await admin.query("SELECT status FROM platform_subscription_payments WHERE id=$1", [restoration.id])).rows[0].status, "cancelled");
  assert.ok(Number((await admin.query("SELECT count(*) total FROM audit_logs WHERE action IN ('school.approved','platform_subscription_payment.confirmed','platform_subscription_payment.cancelled') AND metadata->>'clientSchoolId'=$1::text OR entity_id=$1", [registeredSchool.id])).rows[0].total) >= 1);

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

  const legacyResetLogin = await request("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "legacy@example.test", password: weakLegacyPassword }) });
  const legacyResetCookie = legacyResetLogin.headers.get("set-cookie").split(";")[0];
  const resetKnown = await request("/api/auth/password-reset/request", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "legacy@example.test" }) });
  const resetUnknown = await request("/api/auth/password-reset/request", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "unknown@example.test" }) });
  assert.equal(resetKnown.status, 202);
  assert.equal(resetUnknown.status, 202);
  assert.deepEqual(await resetKnown.json(), await resetUnknown.json());
  const resetEmail = sentEmails.find((email) => email.subject === "Réinitialisez votre mot de passe SCOLARIS PAY" && email.to.includes("legacy@example.test"));
  assert.ok(resetEmail);
  const resetLink = resetEmail.text.match(/https:\/\/[^\s]+/)?.[0];
  assert.ok(resetLink);
  const resetUrl = new URL(resetLink);
  assert.equal(resetUrl.origin, "https://preview.scolarispay.test");
  assert.equal(resetUrl.pathname, "/reinitialiser-mot-de-passe");
  assert.equal(resetUrl.search, "");
  const resetToken = new URLSearchParams(resetUrl.hash.slice(1)).get("token");
  assert.equal(resetToken?.length, 43);
  const resetConfirmation = await request("/api/auth/password-reset/confirm", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: resetToken, password: "CompteRecupere2026!" }) });
  assert.equal(resetConfirmation.status, 200);
  assert.equal((await request("/api/me", { headers: { cookie: legacyResetCookie } })).status, 401);
  assert.equal((await request("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "legacy@example.test", password: weakLegacyPassword }) })).status, 401);
  assert.equal((await request("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "legacy@example.test", password: "CompteRecupere2026!" }) })).status, 200);
  assert.equal((await request("/api/auth/password-reset/confirm", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: resetToken, password: "AutreMotDePasse2026!" }) })).status, 400);

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

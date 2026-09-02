import pg from "pg";
import { hashPassword } from "../src/auth-security.js";
import { assertPreviewSeedAllowed } from "./preview-seed-guard.mjs";

assertPreviewSeedAllowed();

const databaseUrl = process.env.DATABASE_URL;
const adminPassword = process.env.SCOLARIS_M4_PREVIEW_ADMIN_PASSWORD;
const teacherPassword = process.env.SCOLARIS_M4_PREVIEW_TEACHER_PASSWORD;
if (!databaseUrl || !adminPassword || !teacherPassword) throw new Error("PREVIEW_SEED_INPUT_MISSING");

const parsedDatabaseUrl = new URL(databaseUrl);
if (["prefer", "require", "verify-ca"].includes(parsedDatabaseUrl.searchParams.get("sslmode"))) {
  parsedDatabaseUrl.searchParams.set("sslmode", "verify-full");
}

const pool = new pg.Pool({ connectionString: parsedDatabaseUrl.toString(), max: 2, connectionTimeoutMillis: 5_000 });
const client = await pool.connect();

async function upsertSchool({ name, slug, email }) {
  return (await client.query(
    `INSERT INTO schools(name,slug,currency,subscription_status,school_type,country,professional_email,email_verified_at)
     VALUES($1,$2,'XOF','active','demo','SN',$3,now())
     ON CONFLICT(slug) DO UPDATE SET name=excluded.name,subscription_status='active',professional_email=excluded.professional_email,email_verified_at=now()
     RETURNING id`,
    [name, slug, email],
  )).rows[0].id;
}

async function upsertUser({ schoolId, name, email, passwordHash, role }) {
  return (await client.query(
    `INSERT INTO users(school_id,name,email,password_hash,role,is_active,email_verified_at)
     VALUES($1,$2,$3,$4,$5,true,now())
     ON CONFLICT(email) DO UPDATE SET school_id=excluded.school_id,name=excluded.name,password_hash=excluded.password_hash,
       role=excluded.role,is_active=true,disabled_at=NULL,email_verified_at=now(),password_changed_at=now()
     RETURNING id`,
    [schoolId, name, email, passwordHash, role],
  )).rows[0].id;
}

async function upsertSubscription(schoolId) {
  await client.query(
    `INSERT INTO school_subscriptions(school_id,status,is_exempt,started_at,current_period_start,current_period_end,paid_until,grace_period_end)
     VALUES($1,'active',true,now(),now(),now()+interval '365 days',now()+interval '365 days',now()+interval '372 days')
     ON CONFLICT(school_id) DO UPDATE SET status='active',is_exempt=true,suspended_at=NULL,cancelled_at=NULL,
       paid_until=excluded.paid_until,grace_period_end=excluded.grace_period_end,updated_at=now()`,
    [schoolId],
  );
}

async function seedPrimarySchool(adminHash, teacherHash) {
  const schoolId = await upsertSchool({ name: "École Démonstration M4", slug: "ecole-demonstration-m4", email: "ecole.m4@example.test" });
  const adminId = await upsertUser({ schoolId, name: "Administration Démonstration", email: "admin.m4@example.test", passwordHash: adminHash, role: "owner" });
  const teacherId = await upsertUser({ schoolId, name: "Enseignant Démonstration", email: "teacher.m4@example.test", passwordHash: teacherHash, role: "teacher" });
  await upsertUser({ schoolId, name: "Comptabilité Démonstration", email: "accountant.m4@example.test", passwordHash: adminHash, role: "accountant" });
  await upsertSubscription(schoolId);

  await client.query("UPDATE academic_years SET is_current=false,updated_at=now() WHERE school_id=$1 AND label<>$2 AND is_current=true", [schoolId, "2026-2027 Démonstration"]);
  const yearId = (await client.query(
    `INSERT INTO academic_years(school_id,label,starts_on,ends_on,is_current)
     VALUES($1,'2026-2027 Démonstration','2026-09-01','2027-06-30',true)
     ON CONFLICT(school_id,label) DO UPDATE SET starts_on=excluded.starts_on,ends_on=excluded.ends_on,is_current=true,updated_at=now()
     RETURNING id`,
    [schoolId],
  )).rows[0].id;
  const classId = (await client.query(
    `INSERT INTO classes(school_id,academic_year_id,name,level,capacity)
     VALUES($1,$2,'6e Démonstration A','6e',30)
     ON CONFLICT(school_id,academic_year_id,name) DO UPDATE SET level=excluded.level,capacity=excluded.capacity,updated_at=now()
     RETURNING id`,
    [schoolId, yearId],
  )).rows[0].id;
  const periodId = (await client.query(
    `INSERT INTO academic_periods(school_id,academic_year_id,name,kind,position,starts_on,ends_on)
     VALUES($1,$2,'Trimestre Démonstration 1','trimester',1,'2026-09-01','2026-12-20')
     ON CONFLICT(school_id,academic_year_id,kind,position) DO UPDATE SET name=excluded.name,starts_on=excluded.starts_on,ends_on=excluded.ends_on,updated_at=now()
     RETURNING id`,
    [schoolId, yearId],
  )).rows[0].id;

  const subjects = [
    ["Mathématiques Démo", "M4-MATH"],
    ["Français Démo", "M4-FR"],
    ["Sciences Démo", "M4-SCI"],
  ];
  const assignmentIds = [];
  for (const [name, code] of subjects) {
    const subjectId = (await client.query(
      `INSERT INTO subjects(school_id,name,code,active) VALUES($1,$2,$3,true)
       ON CONFLICT(school_id,lower(code)) WHERE code IS NOT NULL DO UPDATE SET name=excluded.name,active=true,updated_at=now()
       RETURNING id`,
      [schoolId, name, code],
    )).rows[0].id;
    const assignmentId = (await client.query(
      `INSERT INTO teaching_assignments(school_id,academic_year_id,teacher_id,class_id,subject_id,status,subject_coefficient)
       VALUES($1,$2,$3,$4,$5,'active',1)
       ON CONFLICT(school_id,academic_year_id,teacher_id,class_id,subject_id) DO UPDATE SET status='active',updated_at=now()
       RETURNING id`,
      [schoolId, yearId, teacherId, classId, subjectId],
    )).rows[0].id;
    await client.query(
      `INSERT INTO subject_coefficient_versions(school_id,academic_year_id,class_id,subject_id,coefficient,version,changed_by)
       VALUES($1,$2,$3,$4,1,1,$5) ON CONFLICT(school_id,academic_year_id,class_id,subject_id,version) DO NOTHING`,
      [schoolId, yearId, classId, subjectId, adminId],
    );
    assignmentIds.push(assignmentId);
  }

  for (let index = 1; index <= 12; index += 1) {
    const suffix = String(index).padStart(3, "0");
    const studentId = (await client.query(
      `INSERT INTO students(school_id,matricule,first_name,last_name,class_name,status)
       VALUES($1,$2,'Élève',$3,'6e Démonstration A','active')
       ON CONFLICT(school_id,matricule) DO UPDATE SET first_name=excluded.first_name,last_name=excluded.last_name,class_name=excluded.class_name,status='active'
       RETURNING id`,
      [schoolId, `M4-DEMO-${suffix}`, `Démo ${suffix}`],
    )).rows[0].id;
    await client.query(
      `INSERT INTO enrollments(school_id,student_id,class_id,academic_year_id,status,enrolled_at)
       VALUES($1,$2,$3,$4,'active','2026-09-01')
       ON CONFLICT(student_id,academic_year_id) DO UPDATE SET school_id=excluded.school_id,class_id=excluded.class_id,status='active',enrolled_at=excluded.enrolled_at,updated_at=now()`,
      [schoolId, studentId, classId, yearId],
    );
  }

  await client.query(
    `INSERT INTO grading_settings(school_id,scale_max,rounding_precision,absence_policy,missing_grade_policy,updated_by)
     VALUES($1,20,2,'exclude','exclude',$2)
     ON CONFLICT(school_id) DO UPDATE SET scale_max=20,rounding_precision=2,absence_policy='exclude',missing_grade_policy='exclude',updated_by=excluded.updated_by,updated_at=now()`,
    [schoolId, adminId],
  );
  await client.query(
    `INSERT INTO grading_policy_versions(school_id,academic_year_id,version,scale_max,rounding_precision,absence_policy,missing_grade_policy,changed_by)
     VALUES($1,$2,1,20,2,'exclude','exclude',$3) ON CONFLICT(school_id,academic_year_id,version) DO NOTHING`,
    [schoolId, yearId, adminId],
  );
  const typeId = (await client.query(
    `INSERT INTO assessment_types(school_id,code,name,active) VALUES($1,'m4_demo','Évaluation Démonstration',true)
     ON CONFLICT(school_id,code) DO UPDATE SET name=excluded.name,active=true,updated_at=now() RETURNING id`,
    [schoolId],
  )).rows[0].id;
  const existingAssessment = (await client.query(
    "SELECT id,status FROM assessments WHERE school_id=$1 AND title='Évaluation Démonstration Initiale' ORDER BY created_at LIMIT 1",
    [schoolId],
  )).rows[0];
  const insertedAssessment = existingAssessment || (await client.query(
    `INSERT INTO assessments(school_id,academic_year_id,academic_period_id,teaching_assignment_id,assessment_type_id,title,description,assessment_date,maximum_score,coefficient,status,created_by,updated_by)
     VALUES($1,$2,$3,$4,$5,'Évaluation Démonstration Initiale','Données exclusivement synthétiques pour validation M4.3','2026-10-15',20,1,'draft',$6,$6)
     RETURNING id,status`,
    [schoolId, yearId, periodId, assignmentIds[0], typeId, adminId],
  )).rows[0];
  const assessmentId = insertedAssessment.id;
  const roster = (await client.query("SELECT student_id,id enrollment_id FROM enrollments WHERE school_id=$1 AND academic_year_id=$2 AND class_id=$3 ORDER BY student_id", [schoolId, yearId, classId])).rows;
  const states = [
    ["scored", 16, "Résultat synthétique"],
    ["pending", null, "En attente synthétique"],
    ["absent", null, "Absence synthétique"],
    ["excused", null, "Excuse synthétique"],
    ["exempt", null, "Exemption synthétique"],
  ];
  for (let index = 0; insertedAssessment.status === "draft" && index < states.length; index += 1) {
    const [status, score, comment] = states[index];
    const enrollment = roster[index];
    await client.query(
      `INSERT INTO grades(school_id,assessment_id,student_id,enrollment_id,status,score,comment,entered_by,updated_by)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8)
       ON CONFLICT(school_id,assessment_id,student_id) DO UPDATE SET enrollment_id=excluded.enrollment_id,status=excluded.status,score=excluded.score,
         comment=excluded.comment,updated_by=excluded.updated_by,updated_at=now(),version=grades.version+1
       WHERE (grades.enrollment_id,grades.status,grades.score,grades.comment) IS DISTINCT FROM
         (excluded.enrollment_id,excluded.status,excluded.score,excluded.comment)`,
      [schoolId, assessmentId, enrollment.student_id, enrollment.enrollment_id, status, score, comment, adminId],
    );
  }
  await client.query(
    `INSERT INTO audit_logs(school_id,user_id,action,entity,entity_id,metadata)
     SELECT $1::uuid,$2::uuid,'preview.seed.reconciled','school',$1::uuid::text,$3::jsonb
     WHERE NOT EXISTS(SELECT 1 FROM audit_logs WHERE school_id=$1::uuid AND action='preview.seed.reconciled' AND metadata->>'seedVersion'='m4.3-v1')`,
    [schoolId, adminId, JSON.stringify({ synthetic: true, seedVersion: "m4.3-v1" })],
  );
  return schoolId;
}

async function seedSecondarySchool(adminHash) {
  const schoolId = await upsertSchool({ name: "École Démonstration M4 B", slug: "ecole-demonstration-m4-b", email: "ecole.m4b@example.test" });
  const adminId = await upsertUser({ schoolId, name: "Administration Démonstration B", email: "admin.m4b@example.test", passwordHash: adminHash, role: "owner" });
  const teacherId = await upsertUser({ schoolId, name: "Enseignant Démonstration B", email: "teacher.m4b@example.test", passwordHash: adminHash, role: "teacher" });
  await upsertSubscription(schoolId);
  const yearId = (await client.query(
    `INSERT INTO academic_years(school_id,label,starts_on,ends_on,is_current)
     VALUES($1,'2026-2027 Démonstration B','2026-09-01','2027-06-30',true)
     ON CONFLICT(school_id,label) DO UPDATE SET starts_on=excluded.starts_on,ends_on=excluded.ends_on,is_current=true,updated_at=now() RETURNING id`,
    [schoolId],
  )).rows[0].id;
  const classId = (await client.query(
    `INSERT INTO classes(school_id,academic_year_id,name,level,capacity) VALUES($1,$2,'6e Démonstration B','6e',10)
     ON CONFLICT(school_id,academic_year_id,name) DO UPDATE SET level=excluded.level,capacity=excluded.capacity,updated_at=now() RETURNING id`,
    [schoolId, yearId],
  )).rows[0].id;
  const periodId = (await client.query(
    `INSERT INTO academic_periods(school_id,academic_year_id,name,kind,position,starts_on,ends_on)
     VALUES($1,$2,'Trimestre Démonstration B','trimester',1,'2026-09-01','2026-12-20')
     ON CONFLICT(school_id,academic_year_id,kind,position) DO UPDATE SET name=excluded.name,starts_on=excluded.starts_on,ends_on=excluded.ends_on,updated_at=now() RETURNING id`,
    [schoolId, yearId],
  )).rows[0].id;
  const subjectId = (await client.query(
    `INSERT INTO subjects(school_id,name,code,active) VALUES($1,'Matière Démonstration B','M4-B',true)
     ON CONFLICT(school_id,lower(code)) WHERE code IS NOT NULL DO UPDATE SET name=excluded.name,active=true,updated_at=now() RETURNING id`,
    [schoolId],
  )).rows[0].id;
  const assignmentId = (await client.query(
    `INSERT INTO teaching_assignments(school_id,academic_year_id,teacher_id,class_id,subject_id,status,subject_coefficient)
     VALUES($1,$2,$3,$4,$5,'active',1)
     ON CONFLICT(school_id,academic_year_id,teacher_id,class_id,subject_id) DO UPDATE SET status='active',updated_at=now() RETURNING id`,
    [schoolId, yearId, teacherId, classId, subjectId],
  )).rows[0].id;
  const studentId = (await client.query(
    `INSERT INTO students(school_id,matricule,first_name,last_name,class_name,status)
     VALUES($1,'M4-B-001','Élève','Démo B 001','6e Démonstration B','active')
     ON CONFLICT(school_id,matricule) DO UPDATE SET first_name=excluded.first_name,last_name=excluded.last_name,class_name=excluded.class_name,status='active' RETURNING id`,
    [schoolId],
  )).rows[0].id;
  await client.query(
    `INSERT INTO enrollments(school_id,student_id,class_id,academic_year_id,status,enrolled_at)
     VALUES($1,$2,$3,$4,'active','2026-09-01')
     ON CONFLICT(student_id,academic_year_id) DO UPDATE SET class_id=excluded.class_id,status='active',enrolled_at=excluded.enrolled_at,updated_at=now()`,
    [schoolId, studentId, classId, yearId],
  );
  await client.query(
    `INSERT INTO grading_settings(school_id,scale_max,rounding_precision,absence_policy,missing_grade_policy,updated_by)
     VALUES($1,20,2,'exclude','exclude',$2)
     ON CONFLICT(school_id) DO UPDATE SET updated_by=excluded.updated_by,updated_at=now()`,
    [schoolId, adminId],
  );
  await client.query(
    `INSERT INTO grading_policy_versions(school_id,academic_year_id,version,scale_max,rounding_precision,absence_policy,missing_grade_policy,changed_by)
     VALUES($1,$2,1,20,2,'exclude','exclude',$3) ON CONFLICT(school_id,academic_year_id,version) DO NOTHING`,
    [schoolId, yearId, adminId],
  );
  await client.query(
    `INSERT INTO subject_coefficient_versions(school_id,academic_year_id,class_id,subject_id,coefficient,version,changed_by)
     VALUES($1,$2,$3,$4,1,1,$5) ON CONFLICT(school_id,academic_year_id,class_id,subject_id,version) DO NOTHING`,
    [schoolId, yearId, classId, subjectId, adminId],
  );
  const typeId = (await client.query(
    `INSERT INTO assessment_types(school_id,code,name,active) VALUES($1,'m4_demo_b','Évaluation Démonstration B',true)
     ON CONFLICT(school_id,code) DO UPDATE SET name=excluded.name,active=true,updated_at=now() RETURNING id`,
    [schoolId],
  )).rows[0].id;
  await client.query(
    `INSERT INTO assessments(school_id,academic_year_id,academic_period_id,teaching_assignment_id,assessment_type_id,title,description,assessment_date,maximum_score,coefficient,status,created_by,updated_by)
     SELECT $1,$2,$3,$4,$5,'Évaluation Démonstration B','Cible synthétique de contrôle multi-tenant','2026-10-16',20,1,'draft',$6,$6
     WHERE NOT EXISTS(SELECT 1 FROM assessments WHERE school_id=$1 AND title='Évaluation Démonstration B')`,
    [schoolId, yearId, periodId, assignmentId, typeId, adminId],
  );
  return schoolId;
}

try {
  await client.query("BEGIN");
  const [adminHash, teacherHash] = await Promise.all([hashPassword(adminPassword), hashPassword(teacherPassword)]);
  const primarySchoolId = await seedPrimarySchool(adminHash, teacherHash);
  const secondarySchoolId = await seedSecondarySchool(adminHash);
  await client.query("COMMIT");
  const summary = (await client.query(
    `SELECT
       (SELECT count(*)::int FROM schools WHERE slug IN ('ecole-demonstration-m4','ecole-demonstration-m4-b')) schools,
       (SELECT count(*)::int FROM users WHERE email IN ('admin.m4@example.test','teacher.m4@example.test','accountant.m4@example.test','admin.m4b@example.test','teacher.m4b@example.test')) users,
       (SELECT count(*)::int FROM students WHERE school_id=$1 AND matricule LIKE 'M4-DEMO-%') students,
       (SELECT count(*)::int FROM subjects WHERE school_id=$1 AND code IN ('M4-MATH','M4-FR','M4-SCI')) subjects,
       (SELECT count(*)::int FROM assessments WHERE school_id=$1 AND title='Évaluation Démonstration Initiale') assessments`,
    [primarySchoolId],
  )).rows[0];
  if (summary.schools !== 2 || summary.users !== 5 || summary.students !== 12 || summary.subjects !== 3 || summary.assessments !== 1 || primarySchoolId === secondarySchoolId) {
    throw new Error("PREVIEW_SEED_RECONCILIATION_FAILED");
  }
  console.log(`preview_seed_ok schools=${summary.schools} users=${summary.users} students=${summary.students} subjects=${summary.subjects} assessments=${summary.assessments}`);
} catch (error) {
  await client.query("ROLLBACK").catch(() => {});
  throw error;
} finally {
  client.release();
  await pool.end();
}

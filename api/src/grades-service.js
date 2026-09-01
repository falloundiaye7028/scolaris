const GRADE_STATUSES = ["scored", "absent", "excused", "exempt", "pending"];
const ASSESSMENT_STATUSES = ["draft", "published", "locked", "cancelled"];
const DEFAULT_TYPES = [
  ["quiz", "Interrogation"], ["assignment", "Devoir"], ["composition", "Composition"],
  ["exam", "Examen"], ["project", "Projet"], ["practical", "Travaux pratiques"],
  ["participation", "Participation"], ["other", "Autre"],
];

export function createGradesRouter({ pool, authService, body, json, csv, identifier, isoDate, pagination, safeText, oneOf, hasPermission }) {
  const decimal = (value, { min = "0", max = "100000", scale = 4, strictlyPositive = false } = {}) => {
    const text = String(value ?? "").trim();
    if (!new RegExp(`^\\d{1,6}(?:\\.\\d{1,${scale}})?$`).test(text)) throw Error("invalid_body");
    const number = Number(text);
    if (!Number.isFinite(number) || number < Number(min) || number > Number(max) || (strictlyPositive && number <= 0)) throw Error("invalid_body");
    return text;
  };
  const version = (value) => {
    const number = Number(value);
    if (!Number.isInteger(number) || number < 1 || number > 2_147_483_647) throw Error("invalid_body");
    return number;
  };
  const audit = (client, me, action, entity, entityId, metadata = {}) => client.query(
    "INSERT INTO audit_logs(school_id,user_id,action,entity,entity_id,metadata) VALUES($1,$2,$3,$4,$5,$6)",
    [me.schoolId, me.sub, action, entity, entityId, JSON.stringify(metadata)],
  );
  const ensureDefaults = async (client, schoolId) => {
    await client.query("INSERT INTO grading_settings(school_id) VALUES($1) ON CONFLICT(school_id) DO NOTHING", [schoolId]);
    for (const [code, name] of DEFAULT_TYPES) {
      await client.query("INSERT INTO assessment_types(school_id,code,name) VALUES($1,$2,$3) ON CONFLICT(school_id,code) DO NOTHING", [schoolId, code, name]);
    }
  };
  const assessmentFor = async (client, me, id, { lock = false } = {}) => {
    const row = (await client.query(`SELECT assessment.id,assessment.academic_year_id,assessment.academic_period_id,assessment.teaching_assignment_id,
      assessment.assessment_type_id,assessment.title,assessment.description,assessment.assessment_date,assessment.maximum_score,assessment.coefficient,
      assessment.status,assessment.published_at,assessment.locked_at,assessment.version,assignment.teacher_id,assignment.class_id,assignment.subject_id,
      assignment.subject_coefficient,class.name class_name,subject.name subject_name,teacher.name teacher_name,type.name assessment_type
      FROM assessments assessment JOIN teaching_assignments assignment ON assignment.id=assessment.teaching_assignment_id AND assignment.school_id=assessment.school_id
      JOIN classes class ON class.id=assignment.class_id AND class.school_id=assessment.school_id
      JOIN subjects subject ON subject.id=assignment.subject_id AND subject.school_id=assessment.school_id
      JOIN users teacher ON teacher.id=assignment.teacher_id AND teacher.school_id=assessment.school_id
      JOIN assessment_types type ON type.id=assessment.assessment_type_id AND type.school_id=assessment.school_id
      WHERE assessment.id=$1 AND assessment.school_id=$2${lock ? " FOR UPDATE OF assessment" : ""}`, [id, me.schoolId])).rows[0];
    if (!row) return { error: [404, "Évaluation introuvable"] };
    if (me.role === "teacher" && row.teacher_id !== me.sub) return { error: [403, "Cette évaluation n’est pas affectée à cet enseignant"] };
    return { row };
  };
  const sendCheckedError = (res, checked) => {
    if (!checked.error) return false;
    json(res, checked.error[0], { error: checked.error[1] });
    return true;
  };
  const reportRows = async (me, { academicPeriodId, classId = null, studentId = null, subjectId = null }) => {
    const result = await pool.query(`WITH settings AS (
        SELECT scale_max,rounding_precision,absence_policy FROM grading_settings WHERE school_id=$1
      ), official AS (
        SELECT assessment.id,assessment.academic_period_id,assessment.coefficient,assignment.class_id,assignment.subject_id,
          assignment.subject_coefficient,subject.name subject_name,grade.student_id,student.matricule,student.first_name,student.last_name,
          CASE WHEN grade.status='scored' THEN grade.normalized_score
               WHEN grade.status='absent' AND settings.absence_policy='zero' THEN 0::numeric ELSE NULL END effective_score
        FROM assessments assessment
        JOIN teaching_assignments assignment ON assignment.id=assessment.teaching_assignment_id AND assignment.school_id=assessment.school_id
        JOIN subjects subject ON subject.id=assignment.subject_id AND subject.school_id=assessment.school_id
        JOIN grades grade ON grade.assessment_id=assessment.id AND grade.school_id=assessment.school_id
        JOIN students student ON student.id=grade.student_id AND student.school_id=assessment.school_id
        CROSS JOIN settings
        WHERE assessment.school_id=$1 AND assessment.academic_period_id=$2 AND assessment.status IN ('published','locked')
          AND ($3::uuid IS NULL OR assignment.class_id=$3) AND ($4::uuid IS NULL OR grade.student_id=$4)
          AND ($5::uuid IS NULL OR assignment.subject_id=$5)
          AND ($6::uuid IS NULL OR assignment.teacher_id=$6)
      ), subjects AS (
        SELECT student_id,matricule,first_name,last_name,class_id,subject_id,subject_name,subject_coefficient,
          sum(effective_score*coefficient)/NULLIF(sum(coefficient) FILTER(WHERE effective_score IS NOT NULL),0) subject_average_raw,
          count(*) FILTER(WHERE effective_score IS NOT NULL)::int result_count,count(DISTINCT id)::int evaluation_count
        FROM official GROUP BY student_id,matricule,first_name,last_name,class_id,subject_id,subject_name,subject_coefficient
      ), generals AS (
        SELECT student_id,sum(subject_average_raw*subject_coefficient)/NULLIF(sum(subject_coefficient) FILTER(WHERE subject_average_raw IS NOT NULL),0) general_average_raw
        FROM subjects GROUP BY student_id
      )
      SELECT subjects.*,round(subject_average_raw,(SELECT rounding_precision FROM settings)::int) subject_average,
        round(generals.general_average_raw,(SELECT rounding_precision FROM settings)::int) general_average,
        round(avg(subject_average_raw) OVER(PARTITION BY subjects.class_id,subjects.subject_id),(SELECT rounding_precision FROM settings)::int) class_subject_average,
        round(avg(generals.general_average_raw) OVER(PARTITION BY subjects.class_id),(SELECT rounding_precision FROM settings)::int) class_average,
        (SELECT scale_max FROM settings) scale_max,(SELECT rounding_precision FROM settings) rounding_precision
      FROM subjects JOIN generals USING(student_id) ORDER BY last_name,first_name,subject_name`, [me.schoolId, academicPeriodId, classId, studentId, subjectId, me.role === "teacher" ? me.sub : null]);
    return result.rows;
  };
  const validateReportScope = async (me, { academicPeriodId, classId = null, studentId = null, subjectId = null }) => {
    const checks = [
      ["academic_periods", academicPeriodId, "Période académique introuvable"],
      ["classes", classId, "Classe introuvable"],
      ["students", studentId, "Élève introuvable"],
      ["subjects", subjectId, "Matière introuvable"],
    ];
    for (const [table, id, message] of checks) {
      if (id && !(await pool.query(`SELECT 1 FROM ${table} WHERE id=$1 AND school_id=$2`, [id, me.schoolId])).rowCount) return [404, message];
    }
    return null;
  };

  return async function gradesRouter(req, res, url, me) {
    const route = `${req.method} ${url.pathname}`;

    if (route === "GET /api/grading-settings") {
      const client = await pool.connect();
      try {
        await client.query("BEGIN"); await ensureDefaults(client, me.schoolId);
        const row = (await client.query("SELECT id,scale_max,rounding_precision,absence_policy,missing_grade_policy,created_at,updated_at FROM grading_settings WHERE school_id=$1", [me.schoolId])).rows[0];
        await client.query("COMMIT"); json(res, 200, row);
      } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
      return true;
    }
    if (route === "PUT /api/grading-settings") {
      const input = await body(req), scaleMax = decimal(input.scaleMax, { min: "1", max: "1000", scale: 2, strictlyPositive: true });
      const roundingPrecision = Number(input.roundingPrecision);
      if (!Number.isInteger(roundingPrecision) || roundingPrecision < 0 || roundingPrecision > 4) throw Error("invalid_body");
      const absencePolicy = oneOf(input.absencePolicy, ["exclude", "zero"]), missingGradePolicy = oneOf(input.missingGradePolicy || "exclude", ["exclude"]);
      const row = (await pool.query(`INSERT INTO grading_settings(school_id,scale_max,rounding_precision,absence_policy,missing_grade_policy,updated_by)
        VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(school_id) DO UPDATE SET scale_max=excluded.scale_max,rounding_precision=excluded.rounding_precision,
        absence_policy=excluded.absence_policy,missing_grade_policy=excluded.missing_grade_policy,updated_by=excluded.updated_by,updated_at=now()
        RETURNING id,scale_max,rounding_precision,absence_policy,missing_grade_policy,created_at,updated_at`, [me.schoolId, scaleMax, roundingPrecision, absencePolicy, missingGradePolicy, me.sub])).rows[0];
      await audit(pool, me, "grading_settings.updated", "grading_settings", row.id, { scaleMax, roundingPrecision, absencePolicy, missingGradePolicy });
      json(res, 200, row); return true;
    }

    const coefficientMatch = url.pathname.match(/^\/api\/teaching-assignments\/([^/]+)\/coefficient$/);
    if (req.method === "PUT" && coefficientMatch) {
      const id = identifier(coefficientMatch[1]), input = await body(req);
      const subjectCoefficient = decimal(input.subjectCoefficient, { min: "0", max: "1000", strictlyPositive: true });
      const row = (await pool.query(`UPDATE teaching_assignments SET subject_coefficient=$1,updated_at=now()
        WHERE id=$2 AND school_id=$3 AND status='active' RETURNING id,subject_coefficient,updated_at`, [subjectCoefficient, id, me.schoolId])).rows[0];
      if (!row) { json(res, 404, { error: "Affectation pédagogique active introuvable" }); return true; }
      await audit(pool, me, "teaching_assignment.coefficient_updated", "teaching_assignment", id, { subjectCoefficient });
      json(res, 200, row); return true;
    }

    if (route === "GET /api/assessment-types") {
      const client = await pool.connect();
      try { await client.query("BEGIN"); await ensureDefaults(client, me.schoolId); const rows = (await client.query("SELECT id,code,name,active,created_at,updated_at FROM assessment_types WHERE school_id=$1 ORDER BY active DESC,name", [me.schoolId])).rows; await client.query("COMMIT"); json(res, 200, rows); }
      catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
      return true;
    }
    if (route === "POST /api/assessment-types") {
      const input = await body(req), code = safeText(input.code, { min: 2, max: 40, pattern: /^[a-z][a-z0-9_]+$/ }), name = safeText(input.name, { min: 2, max: 100 });
      const row = (await pool.query("INSERT INTO assessment_types(school_id,code,name) VALUES($1,$2,$3) RETURNING id,code,name,active,created_at,updated_at", [me.schoolId, code, name])).rows[0];
      await audit(pool, me, "assessment_type.created", "assessment_type", row.id, { code }); json(res, 201, row); return true;
    }

    if (route === "GET /api/assessments") {
      await ensureDefaults(pool, me.schoolId);
      const { limit, offset } = pagination(url.searchParams, { defaultLimit: 100, maxLimit: 200 });
      const academicYearId = url.searchParams.get("academicYearId") ? identifier(url.searchParams.get("academicYearId")) : null;
      const academicPeriodId = url.searchParams.get("academicPeriodId") ? identifier(url.searchParams.get("academicPeriodId")) : null;
      const classId = url.searchParams.get("classId") ? identifier(url.searchParams.get("classId")) : null;
      const subjectId = url.searchParams.get("subjectId") ? identifier(url.searchParams.get("subjectId")) : null;
      const requestedTeacher = url.searchParams.get("teacherId") ? identifier(url.searchParams.get("teacherId")) : null;
      const teacherId = me.role === "teacher" ? me.sub : requestedTeacher;
      const status = url.searchParams.get("status") ? oneOf(url.searchParams.get("status"), ASSESSMENT_STATUSES) : null;
      const rows = (await pool.query(`SELECT assessment.id,assessment.academic_year_id,assessment.academic_period_id,assessment.teaching_assignment_id,
        assessment.assessment_type_id,assessment.title,assessment.description,assessment.assessment_date,assessment.maximum_score,assessment.coefficient,
        assessment.status,assessment.published_at,assessment.locked_at,assessment.version,assignment.teacher_id,assignment.class_id,assignment.subject_id,
        assignment.subject_coefficient,class.name class_name,subject.name subject_name,teacher.name teacher_name,type.name assessment_type,
        count(grade.id)::int entered_count,count(*) FILTER(WHERE grade.status='scored')::int scored_count,
        (SELECT count(*)::int FROM enrollments enrollment WHERE enrollment.school_id=assessment.school_id AND enrollment.academic_year_id=assessment.academic_year_id
          AND enrollment.class_id=assignment.class_id AND enrollment.status IN('active','completed') AND enrollment.enrolled_at<=assessment.assessment_date) student_count,
        round(avg(grade.normalized_score) FILTER(WHERE grade.status='scored'),settings.rounding_precision::int) class_average
        FROM assessments assessment JOIN teaching_assignments assignment ON assignment.id=assessment.teaching_assignment_id AND assignment.school_id=assessment.school_id
        JOIN classes class ON class.id=assignment.class_id AND class.school_id=assessment.school_id JOIN subjects subject ON subject.id=assignment.subject_id AND subject.school_id=assessment.school_id
        JOIN users teacher ON teacher.id=assignment.teacher_id AND teacher.school_id=assessment.school_id JOIN assessment_types type ON type.id=assessment.assessment_type_id AND type.school_id=assessment.school_id
        JOIN grading_settings settings ON settings.school_id=assessment.school_id LEFT JOIN grades grade ON grade.assessment_id=assessment.id AND grade.school_id=assessment.school_id
        WHERE assessment.school_id=$1 AND ($2::uuid IS NULL OR assessment.academic_year_id=$2) AND ($3::uuid IS NULL OR assessment.academic_period_id=$3)
          AND ($4::uuid IS NULL OR assignment.class_id=$4) AND ($5::uuid IS NULL OR assignment.subject_id=$5) AND ($6::uuid IS NULL OR assignment.teacher_id=$6)
          AND ($7::text IS NULL OR assessment.status=$7)
        GROUP BY assessment.id,assignment.id,class.id,subject.id,teacher.id,type.id,settings.id
        ORDER BY assessment.assessment_date DESC,assessment.created_at DESC LIMIT $8 OFFSET $9`, [me.schoolId, academicYearId, academicPeriodId, classId, subjectId, teacherId, status, limit, offset])).rows;
      json(res, 200, rows); return true;
    }

    if (route === "POST /api/assessments") {
      const input = await body(req), academicYearId = identifier(input.academicYearId), academicPeriodId = identifier(input.academicPeriodId);
      const teachingAssignmentId = identifier(input.teachingAssignmentId), assessmentTypeId = identifier(input.assessmentTypeId);
      const title = safeText(input.title, { min: 2, max: 160 }), description = input.description ? safeText(input.description, { max: 2000 }) : null;
      const assessmentDate = isoDate(input.assessmentDate), maximumScore = decimal(input.maximumScore, { max: "100000", strictlyPositive: true });
      const coefficient = decimal(input.coefficient ?? "1", { max: "1000", strictlyPositive: true });
      const assignment = (await pool.query(`SELECT assignment.id FROM teaching_assignments assignment JOIN subjects subject ON subject.id=assignment.subject_id AND subject.school_id=assignment.school_id
        WHERE assignment.id=$1 AND assignment.school_id=$2 AND assignment.academic_year_id=$3 AND assignment.status='active' AND subject.active=true AND ($4::uuid IS NULL OR assignment.teacher_id=$4)`, [teachingAssignmentId, me.schoolId, academicYearId, me.role === "teacher" ? me.sub : null])).rows[0];
      if (!assignment) { json(res, 404, { error: "Affectation pédagogique active introuvable" }); return true; }
      const type = (await pool.query("SELECT id FROM assessment_types WHERE id=$1 AND school_id=$2 AND active=true", [assessmentTypeId, me.schoolId])).rows[0];
      if (!type) { json(res, 404, { error: "Type d’évaluation actif introuvable" }); return true; }
      const row = (await pool.query(`INSERT INTO assessments(school_id,academic_year_id,academic_period_id,teaching_assignment_id,assessment_type_id,title,description,assessment_date,maximum_score,coefficient,created_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id,academic_year_id,academic_period_id,teaching_assignment_id,assessment_type_id,title,description,assessment_date,maximum_score,coefficient,status,version,created_at,updated_at`,
      [me.schoolId, academicYearId, academicPeriodId, teachingAssignmentId, assessmentTypeId, title, description, assessmentDate, maximumScore, coefficient, me.sub])).rows[0];
      await audit(pool, me, "assessment.created", "assessment", row.id, { academicYearId, academicPeriodId, teachingAssignmentId }); json(res, 201, row); return true;
    }

    const assessmentMatch = url.pathname.match(/^\/api\/assessments\/([^/]+)$/);
    if (req.method === "PUT" && assessmentMatch) {
      const id = identifier(assessmentMatch[1]), input = await body(req), expectedVersion = version(input.expectedVersion), client = await pool.connect();
      try {
        await client.query("BEGIN"); const checked = await assessmentFor(client, me, id, { lock: true });
        if (sendCheckedError(res, checked)) { await client.query("ROLLBACK"); return true; }
        if (checked.row.status !== "draft") { await client.query("ROLLBACK"); json(res, 409, { error: "Seule une évaluation en brouillon peut être modifiée" }); return true; }
        if (checked.row.version !== expectedVersion) { await client.query("ROLLBACK"); json(res, 409, { error: "Cette évaluation a été modifiée par un autre utilisateur. Rechargez les données." }); return true; }
        const title = safeText(input.title, { min: 2, max: 160 }), description = input.description ? safeText(input.description, { max: 2000 }) : null;
        const assessmentDate = isoDate(input.assessmentDate), maximumScore = decimal(input.maximumScore, { max: "100000", strictlyPositive: true }), coefficient = decimal(input.coefficient, { max: "1000", strictlyPositive: true });
        const typeId = identifier(input.assessmentTypeId), periodId = identifier(input.academicPeriodId);
        const row = (await client.query(`UPDATE assessments SET title=$1,description=$2,assessment_date=$3,maximum_score=$4,coefficient=$5,assessment_type_id=$6,academic_period_id=$7,
          updated_by=$8,updated_at=now(),version=version+1 WHERE id=$9 AND school_id=$10 RETURNING id,title,description,assessment_date,maximum_score,coefficient,status,version,updated_at`,
        [title, description, assessmentDate, maximumScore, coefficient, typeId, periodId, me.sub, id, me.schoolId])).rows[0];
        await audit(client, me, "assessment.updated", "assessment", id, { previousVersion: expectedVersion }); await client.query("COMMIT"); json(res, 200, row);
      } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
      return true;
    }

    const workflowMatch = url.pathname.match(/^\/api\/assessments\/([^/]+)\/(publish|lock|reopen|cancel)$/);
    if (req.method === "POST" && workflowMatch) {
      const id = identifier(workflowMatch[1]), action = workflowMatch[2], input = await body(req), expectedVersion = version(input.expectedVersion), client = await pool.connect();
      const allowed = { publish: "assessments.publish", lock: "assessments.lock", reopen: "assessments.reopen", cancel: "assessments.update" }[action];
      if (!hasPermission(me.role, allowed)) { json(res, 403, { error: "Action non autorisée" }); return true; }
      try {
        await client.query("BEGIN"); const checked = await assessmentFor(client, me, id, { lock: true });
        if (sendCheckedError(res, checked)) { await client.query("ROLLBACK"); return true; }
        if (checked.row.version !== expectedVersion) { await client.query("ROLLBACK"); json(res, 409, { error: "Cette évaluation a été modifiée par un autre utilisateur. Rechargez les données." }); return true; }
        const transitions = { publish: ["draft", "published"], lock: ["published", "locked"], reopen: ["locked", "published"], cancel: ["draft,published", "cancelled"] };
        const [from, to] = transitions[action], accepted = from.split(",");
        if (!accepted.includes(checked.row.status)) { await client.query("ROLLBACK"); json(res, 409, { error: "Transition d’état impossible pour cette évaluation" }); return true; }
        if (["lock", "reopen"].includes(action) && !["owner", "director"].includes(me.role)) { await client.query("ROLLBACK"); json(res, 403, { error: "Action réservée à la direction" }); return true; }
        const reason = action === "reopen" ? safeText(input.reason, { min: 8, max: 500 }) : null;
        const row = (await client.query(`UPDATE assessments SET status=$1,
          published_at=CASE WHEN $1='published' AND published_at IS NULL THEN now() ELSE published_at END,
          published_by=CASE WHEN $1='published' AND published_by IS NULL THEN $2 ELSE published_by END,
          locked_at=CASE WHEN $1='locked' THEN now() WHEN $3='reopen' THEN NULL ELSE locked_at END,
          locked_by=CASE WHEN $1='locked' THEN $2 WHEN $3='reopen' THEN NULL ELSE locked_by END,
          updated_by=$2,updated_at=now(),version=version+1 WHERE id=$4 AND school_id=$5 RETURNING id,status,published_at,locked_at,version,updated_at`, [to, me.sub, action, id, me.schoolId])).rows[0];
        await audit(client, me, `assessment.${action === "publish" ? "published" : action === "lock" ? "locked" : action === "reopen" ? "reopened" : "cancelled"}`, "assessment", id, { previousStatus: checked.row.status, reason });
        await client.query("COMMIT"); json(res, 200, row);
      } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
      return true;
    }

    const rosterMatch = url.pathname.match(/^\/api\/assessments\/([^/]+)\/roster$/);
    if (req.method === "GET" && rosterMatch) {
      const id = identifier(rosterMatch[1]), checked = await assessmentFor(pool, me, id);
      if (sendCheckedError(res, checked)) return true;
      const students = (await pool.query(`SELECT enrollment.id enrollment_id,student.id student_id,student.matricule,student.first_name,student.last_name,
        grade.id grade_id,grade.status,grade.score,grade.normalized_score,grade.comment,grade.version,grade.entered_at,grade.updated_at,
        entered.name entered_by_name,updated.name updated_by_name
        FROM enrollments enrollment JOIN students student ON student.id=enrollment.student_id AND student.school_id=enrollment.school_id
        LEFT JOIN grades grade ON grade.school_id=enrollment.school_id AND grade.assessment_id=$1 AND grade.student_id=student.id
        LEFT JOIN users entered ON entered.id=grade.entered_by AND entered.school_id=grade.school_id LEFT JOIN users updated ON updated.id=grade.updated_by AND updated.school_id=grade.school_id
        WHERE enrollment.school_id=$2 AND enrollment.academic_year_id=$3 AND enrollment.class_id=$4 AND enrollment.status IN ('active','completed') AND enrollment.enrolled_at<=$5
        ORDER BY student.last_name,student.first_name,student.matricule`, [id, me.schoolId, checked.row.academic_year_id, checked.row.class_id, checked.row.assessment_date])).rows;
      json(res, 200, { assessment: checked.row, students }); return true;
    }

    const gradesMatch = url.pathname.match(/^\/api\/assessments\/([^/]+)\/grades$/);
    if (req.method === "POST" && gradesMatch) {
      const assessmentId = identifier(gradesMatch[1]), input = await body(req), assessmentVersion = version(input.assessmentVersion);
      if (!Array.isArray(input.grades) || input.grades.length < 1 || input.grades.length > 200) throw Error("invalid_body");
      const seen = new Set(), normalized = input.grades.map((grade) => {
        const studentId = identifier(grade.studentId); if (seen.has(studentId)) throw Error("invalid_body"); seen.add(studentId);
        const status = oneOf(grade.status, GRADE_STATUSES), score = status === "scored" ? decimal(grade.score, { min: "0", max: "100000" }) : null;
        if (status !== "scored" && grade.score !== undefined && grade.score !== null && String(grade.score) !== "") throw Error("invalid_body");
        return { student_id: studentId, status, score, comment: grade.comment ? safeText(grade.comment, { max: 1000 }) : null,
          expected_version: grade.expectedVersion === undefined || grade.expectedVersion === null ? null : version(grade.expectedVersion) };
      });
      const client = await pool.connect();
      try {
        await client.query("BEGIN"); await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`grades:${me.schoolId}:${assessmentId}`]);
        const checked = await assessmentFor(client, me, assessmentId, { lock: true }); if (sendCheckedError(res, checked)) { await client.query("ROLLBACK"); return true; }
        if (checked.row.version !== assessmentVersion) { await client.query("ROLLBACK"); json(res, 409, { error: "Ces notes ont été modifiées par un autre utilisateur. Rechargez les données avant de continuer." }); return true; }
        if (checked.row.status === "locked" || checked.row.status === "cancelled") { await client.query("ROLLBACK"); json(res, 409, { error: "Les notes de cette évaluation ne sont pas modifiables" }); return true; }
        const correction = checked.row.status === "published";
        const reason = correction ? safeText(input.reason, { min: 8, max: 500 }) : null;
        if (correction && !hasPermission(me.role, "grades.correct")) { await client.query("ROLLBACK"); json(res, 403, { error: "Correction de notes non autorisée" }); return true; }
        const roster = (await client.query(`SELECT enrollment.id enrollment_id,enrollment.student_id FROM enrollments enrollment WHERE enrollment.school_id=$1
          AND enrollment.academic_year_id=$2 AND enrollment.class_id=$3 AND enrollment.status IN ('active','completed') AND enrollment.enrolled_at<=$4 AND enrollment.student_id=ANY($5::uuid[])`,
        [me.schoolId, checked.row.academic_year_id, checked.row.class_id, checked.row.assessment_date, [...seen]])).rows;
        if (roster.length !== normalized.length) { await client.query("ROLLBACK"); json(res, 400, { error: "Un élève ne fait pas partie de cette classe pour cette évaluation" }); return true; }
        const enrollmentByStudent = new Map(roster.map((row) => [row.student_id, row.enrollment_id]));
        const existing = (await client.query("SELECT id,student_id,status,score,version FROM grades WHERE school_id=$1 AND assessment_id=$2 AND student_id=ANY($3::uuid[]) FOR UPDATE", [me.schoolId, assessmentId, [...seen]])).rows;
        const existingByStudent = new Map(existing.map((row) => [row.student_id, row]));
        for (const row of normalized) {
          const current = existingByStudent.get(row.student_id);
          if ((current && row.expected_version !== current.version) || (!current && row.expected_version !== null)) { await client.query("ROLLBACK"); json(res, 409, { error: "Ces notes ont été modifiées par un autre utilisateur. Rechargez les données avant de continuer." }); return true; }
          row.enrollment_id = enrollmentByStudent.get(row.student_id);
        }
        const rows = (await client.query(`WITH input AS (SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(student_id uuid,enrollment_id uuid,status text,score numeric,comment text))
          INSERT INTO grades(school_id,assessment_id,student_id,enrollment_id,status,score,comment,entered_by)
          SELECT $2,$3,student_id,enrollment_id,status,score,comment,$4 FROM input
          ON CONFLICT(school_id,assessment_id,student_id) DO UPDATE SET enrollment_id=excluded.enrollment_id,status=excluded.status,score=excluded.score,comment=excluded.comment,
            updated_by=$4,updated_at=now(),version=grades.version+1
          RETURNING id,student_id,status,score,normalized_score,comment,version,updated_at`, [JSON.stringify(normalized), me.schoolId, assessmentId, me.sub])).rows;
        const changes = rows.map((row) => ({ grade_id: row.id, previous_status: existingByStudent.get(row.student_id)?.status || null,
          new_status: row.status, previous_score: existingByStudent.get(row.student_id)?.score ?? null, new_score: row.score }));
        await client.query(`WITH changes AS (SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(grade_id uuid,previous_status text,new_status text,previous_score numeric,new_score numeric))
          INSERT INTO grade_events(school_id,grade_id,previous_status,new_status,previous_score,new_score,changed_by,reason)
          SELECT $2,grade_id,previous_status,new_status,previous_score,new_score,$3,$4 FROM changes`, [JSON.stringify(changes), me.schoolId, me.sub, reason]);
        await audit(client, me, correction ? "grades.batch_corrected" : "grades.batch_saved", "assessment", assessmentId, { count: rows.length, reason: reason || undefined });
        await client.query("COMMIT"); json(res, 200, { saved: rows.length, grades: rows });
      } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
      return true;
    }

    const gradeMatch = url.pathname.match(/^\/api\/grades\/([^/]+)$/);
    if (req.method === "PUT" && gradeMatch) {
      const id = identifier(gradeMatch[1]), input = await body(req), expectedVersion = version(input.expectedVersion), reason = safeText(input.reason, { min: 8, max: 500 });
      const status = oneOf(input.status, GRADE_STATUSES), score = status === "scored" ? decimal(input.score, { min: "0", max: "100000" }) : null;
      const comment = input.comment ? safeText(input.comment, { max: 1000 }) : null, client = await pool.connect();
      try {
        await client.query("BEGIN");
        const current = (await client.query(`SELECT grade.id,grade.status,grade.score,grade.version,assessment.id assessment_id,assessment.status assessment_status,
          assignment.teacher_id FROM grades grade JOIN assessments assessment ON assessment.id=grade.assessment_id AND assessment.school_id=grade.school_id
          JOIN teaching_assignments assignment ON assignment.id=assessment.teaching_assignment_id AND assignment.school_id=assessment.school_id
          WHERE grade.id=$1 AND grade.school_id=$2 FOR UPDATE OF grade,assessment`, [id, me.schoolId])).rows[0];
        if (!current) { await client.query("ROLLBACK"); json(res, 404, { error: "Note introuvable" }); return true; }
        if (me.role === "teacher" && current.teacher_id !== me.sub) { await client.query("ROLLBACK"); json(res, 403, { error: "Note non affectée à cet enseignant" }); return true; }
        if (!hasPermission(me.role, "grades.correct")) { await client.query("ROLLBACK"); json(res, 403, { error: "Correction de notes non autorisée" }); return true; }
        if (current.assessment_status !== "published") { await client.query("ROLLBACK"); json(res, 409, { error: "La correction exige une évaluation publiée et non verrouillée" }); return true; }
        if (current.version !== expectedVersion) { await client.query("ROLLBACK"); json(res, 409, { error: "Ces notes ont été modifiées par un autre utilisateur. Rechargez les données avant de continuer." }); return true; }
        const row = (await client.query("UPDATE grades SET status=$1,score=$2,comment=$3,updated_by=$4,updated_at=now(),version=version+1 WHERE id=$5 AND school_id=$6 RETURNING id,status,score,normalized_score,comment,version,updated_at", [status, score, comment, me.sub, id, me.schoolId])).rows[0];
        await client.query("INSERT INTO grade_events(school_id,grade_id,previous_status,new_status,previous_score,new_score,changed_by,reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8)", [me.schoolId, id, current.status, status, current.score, score, me.sub, reason]);
        await audit(client, me, "grade.corrected", "grade", id, { reason, assessmentId: current.assessment_id }); await client.query("COMMIT"); json(res, 200, row);
      } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
      return true;
    }

    const historyMatch = url.pathname.match(/^\/api\/grades\/([^/]+)\/history$/);
    if (req.method === "GET" && historyMatch) {
      const gradeId = identifier(historyMatch[1]);
      const rows = (await pool.query(`SELECT event.id,event.previous_status,event.new_status,event.previous_score,event.new_score,event.reason,event.created_at,user_account.name changed_by_name
        FROM grade_events event JOIN grades grade ON grade.id=event.grade_id AND grade.school_id=event.school_id
        JOIN assessments assessment ON assessment.id=grade.assessment_id AND assessment.school_id=grade.school_id
        JOIN teaching_assignments assignment ON assignment.id=assessment.teaching_assignment_id AND assignment.school_id=assessment.school_id
        JOIN users user_account ON user_account.id=event.changed_by AND user_account.school_id=event.school_id
        WHERE event.school_id=$1 AND event.grade_id=$2 AND ($3::uuid IS NULL OR assignment.teacher_id=$3) ORDER BY event.created_at DESC LIMIT 200`, [me.schoolId, gradeId, me.role === "teacher" ? me.sub : null])).rows;
      if (!rows.length && !(await pool.query("SELECT 1 FROM grades WHERE id=$1 AND school_id=$2", [gradeId, me.schoolId])).rowCount) json(res, 404, { error: "Note introuvable" });
      else json(res, 200, rows); return true;
    }

    if (route === "GET /api/grade-reports" || route === "GET /api/grade-reports.csv") {
      const scope = oneOf(url.searchParams.get("scope") || "class", ["assessment", "subject", "student", "class"]);
      if (route.endsWith(".csv")) authService.requireRecentAuthentication(me);
      let report;
      if (scope === "assessment") {
        const assessmentId = identifier(url.searchParams.get("assessmentId")), checked = await assessmentFor(pool, me, assessmentId);
        if (sendCheckedError(res, checked)) return true;
        const stats = (await pool.query(`SELECT count(enrollment.id)::int student_count,count(grade.id)::int entered_count,
          count(*) FILTER(WHERE grade.status='scored')::int scored_count,count(*) FILTER(WHERE grade.status='absent')::int absent_count,
          count(*) FILTER(WHERE grade.status='exempt')::int exempt_count,count(*) FILTER(WHERE grade.id IS NULL OR grade.status='pending')::int missing_count,
          round(avg(grade.normalized_score) FILTER(WHERE grade.status='scored'),settings.rounding_precision::int) average,
          min(grade.normalized_score) FILTER(WHERE grade.status='scored') minimum,max(grade.normalized_score) FILTER(WHERE grade.status='scored') maximum
          FROM enrollments enrollment JOIN grading_settings settings ON settings.school_id=enrollment.school_id
          LEFT JOIN grades grade ON grade.school_id=enrollment.school_id AND grade.assessment_id=$1 AND grade.student_id=enrollment.student_id
          WHERE enrollment.school_id=$2 AND enrollment.academic_year_id=$3 AND enrollment.class_id=$4 AND enrollment.status IN ('active','completed') AND enrollment.enrolled_at<=$5
          GROUP BY settings.id`, [assessmentId, me.schoolId, checked.row.academic_year_id, checked.row.class_id, checked.row.assessment_date])).rows[0];
        const distribution = (await pool.query(`SELECT LEAST(4,floor((grade.normalized_score/settings.scale_max)*5))::int bucket,count(*)::int total
          FROM grades grade JOIN grading_settings settings ON settings.school_id=grade.school_id
          WHERE grade.school_id=$1 AND grade.assessment_id=$2 AND grade.status='scored' GROUP BY bucket ORDER BY bucket`, [me.schoolId, assessmentId])).rows;
        report = { scope, assessment: checked.row, summary: stats || { student_count: 0, entered_count: 0, scored_count: 0, absent_count: 0, exempt_count: 0, missing_count: 0, average: null, minimum: null, maximum: null }, distribution };
      } else {
        const academicPeriodId = identifier(url.searchParams.get("academicPeriodId"));
        const classId = url.searchParams.get("classId") ? identifier(url.searchParams.get("classId")) : null;
        const studentId = url.searchParams.get("studentId") ? identifier(url.searchParams.get("studentId")) : null;
        const subjectId = url.searchParams.get("subjectId") ? identifier(url.searchParams.get("subjectId")) : null;
        if ((scope === "class" && !classId) || (scope === "student" && !studentId) || (scope === "subject" && !subjectId)) throw Error("invalid_body");
        const invalidScope = await validateReportScope(me, { academicPeriodId, classId, studentId, subjectId });
        if (invalidScope) { json(res, invalidScope[0], { error: invalidScope[1] }); return true; }
        if (me.role === "teacher") {
          const allowed = (await pool.query(`SELECT 1 FROM teaching_assignments assignment WHERE assignment.school_id=$1 AND assignment.teacher_id=$2
            AND ($3::uuid IS NULL OR assignment.class_id=$3) AND ($4::uuid IS NULL OR assignment.subject_id=$4) LIMIT 1`, [me.schoolId, me.sub, classId, subjectId])).rowCount;
          if (!allowed) { json(res, 403, { error: "Rapport non affecté à cet enseignant" }); return true; }
        }
        const rows = await reportRows(me, { academicPeriodId, classId, studentId, subjectId });
        report = { scope, academicPeriodId, summary: { studentCount: new Set(rows.map((row) => row.student_id)).size, classAverage: rows[0]?.class_average ?? null }, rows };
      }
      if (route.endsWith(".csv")) {
        const rows = report.scope === "assessment"
          ? [["Évaluation", "Élèves", "Notes saisies", "Absents", "Dispensés", "Manquantes", "Moyenne", "Minimum", "Maximum"], [report.assessment.title, report.summary.student_count, report.summary.scored_count, report.summary.absent_count, report.summary.exempt_count, report.summary.missing_count, report.summary.average, report.summary.minimum, report.summary.maximum]]
          : [["Matricule", "Prénom", "Nom", "Matière", "Coefficient matière", "Moyenne matière", "Moyenne générale", "Résultats"], ...report.rows.slice(0, 5000).map((row) => [row.matricule, row.first_name, row.last_name, row.subject_name, row.subject_coefficient, row.subject_average, row.general_average, row.result_count])];
        if (report.rows?.length > 5000) { json(res, 413, { error: "Export trop volumineux. Réduisez la sélection." }); return true; }
        await audit(pool, me, "grade_reports.exported", "grade_report", null, { scope, rows: rows.length - 1 }); csv(res, "releve-notes.csv", rows); return true;
      }
      json(res, 200, report); return true;
    }

    const studentGradesMatch = url.pathname.match(/^\/api\/students\/([^/]+)\/grades$/);
    if (req.method === "GET" && studentGradesMatch) {
      const studentId = identifier(studentGradesMatch[1]), academicPeriodId = identifier(url.searchParams.get("academicPeriodId"));
      const exists = (await pool.query("SELECT 1 FROM students WHERE id=$1 AND school_id=$2", [studentId, me.schoolId])).rowCount;
      if (!exists) { json(res, 404, { error: "Élève introuvable" }); return true; }
      const rows = await reportRows(me, { academicPeriodId, studentId });
      const assessments = (await pool.query(`SELECT assessment.id,assessment.title,assessment.assessment_date,assessment.maximum_score,assessment.coefficient,
        assessment.status assessment_status,subject.name subject_name,grade.status,grade.score,grade.normalized_score,grade.comment
        FROM assessments assessment JOIN teaching_assignments assignment ON assignment.id=assessment.teaching_assignment_id AND assignment.school_id=assessment.school_id
        JOIN subjects subject ON subject.id=assignment.subject_id AND subject.school_id=assessment.school_id
        LEFT JOIN grades grade ON grade.assessment_id=assessment.id AND grade.school_id=assessment.school_id AND grade.student_id=$3
        WHERE assessment.school_id=$1 AND assessment.academic_period_id=$2 AND assessment.status IN('published','locked')
          AND ($4::uuid IS NULL OR assignment.teacher_id=$4) ORDER BY assessment.assessment_date,subject.name,assessment.title`, [me.schoolId, academicPeriodId, studentId, me.role === "teacher" ? me.sub : null])).rows;
      json(res, 200, { studentId, academicPeriodId, rows, assessments }); return true;
    }

    return false;
  };
}

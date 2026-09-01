import crypto from "node:crypto";

const STATUSES = ["present", "absent", "late", "excused"];
const dateText = (value) => value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
const rate = (part, total) => total ? Math.round((Number(part) * 10_000) / Number(total)) / 100 : 0;

export function createAttendanceRouter({ pool, body, json, csv, binary, identifier, isoDate, safeText, oneOf, hasPermission }) {
  const time = (value) => {
    const text = safeText(value, { min: 5, max: 5, pattern: /^([01]\d|2[0-3]):[0-5]\d$/ });
    return text;
  };
  const audit = (client, me, action, entity, entityId, metadata = {}) => client.query(
    "INSERT INTO audit_logs(school_id,user_id,action,entity,entity_id,metadata) VALUES($1,$2,$3,$4,$5,$6)",
    [me.schoolId, me.sub, action, entity, entityId, JSON.stringify(metadata)],
  );
  const sessionFor = async (client, me, id, { lock = false } = {}) => {
    const row = (await client.query(`SELECT session.id,session.academic_year_id,session.session_date,session.start_time,session.end_time,session.status,
      assignment.id teaching_assignment_id,assignment.class_id,assignment.teacher_id,assignment.subject_id,class.name class_name,teacher.name teacher_name,subject.name subject_name
      FROM lesson_sessions session JOIN teaching_assignments assignment ON assignment.id=session.teaching_assignment_id AND assignment.school_id=session.school_id
      JOIN classes class ON class.id=assignment.class_id AND class.school_id=session.school_id JOIN users teacher ON teacher.id=assignment.teacher_id AND teacher.school_id=session.school_id
      JOIN subjects subject ON subject.id=assignment.subject_id AND subject.school_id=session.school_id
      WHERE session.id=$1 AND session.school_id=$2${lock ? " FOR UPDATE OF session" : ""}`, [id, me.schoolId])).rows[0];
    if (!row) return { error: [404, "Séance introuvable"] };
    if (me.role === "teacher" && row.teacher_id !== me.sub) return { error: [403, "Cette séance n’est pas affectée à cet enseignant"] };
    return { row };
  };
  const range = (url, fallbackDays = 31) => {
    const to = isoDate(url.searchParams.get("to") || new Date().toISOString().slice(0, 10));
    const fallback = new Date(`${to}T00:00:00Z`); fallback.setUTCDate(fallback.getUTCDate() - fallbackDays + 1);
    const from = isoDate(url.searchParams.get("from") || fallback.toISOString().slice(0, 10));
    const days = Math.round((new Date(`${to}T00:00:00Z`) - new Date(`${from}T00:00:00Z`)) / 86400000) + 1;
    if (days < 1 || days > 370) throw Error("invalid_body");
    return { from, to };
  };
  const reportFor = async (me, url) => {
    const academicYearId = identifier(url.searchParams.get("academicYearId"));
    const scope = oneOf(url.searchParams.get("scope") || "school", ["school", "class", "student"]);
    const classId = scope === "class" ? identifier(url.searchParams.get("classId")) : null;
    const studentId = scope === "student" ? identifier(url.searchParams.get("studentId")) : null;
    const periodId = url.searchParams.get("periodId") ? identifier(url.searchParams.get("periodId")) : null;
    const year = (await pool.query("SELECT starts_on,ends_on,label FROM academic_years WHERE id=$1 AND school_id=$2", [academicYearId, me.schoolId])).rows[0];
    if (!year) return { error: [404, "Année scolaire introuvable"] };
    let from = url.searchParams.get("from") ? isoDate(url.searchParams.get("from")) : dateText(year.starts_on);
    let to = url.searchParams.get("to") ? isoDate(url.searchParams.get("to")) : dateText(year.ends_on);
    let period = null;
    if (periodId) {
      period = (await pool.query("SELECT id,name,kind,position,starts_on,ends_on FROM academic_periods WHERE id=$1 AND school_id=$2 AND academic_year_id=$3", [periodId, me.schoolId, academicYearId])).rows[0];
      if (!period) return { error: [404, "Période académique introuvable"] };
      from = dateText(period.starts_on); to = dateText(period.ends_on);
    }
    if (from > to || from < dateText(year.starts_on) || to > dateText(year.ends_on)) return { error: [400, "La période doit appartenir à l’année scolaire"] };
    const teacherId = me.role === "teacher" ? me.sub : null;
    const params = [me.schoolId, academicYearId, from, to, classId, studentId, teacherId];
    const base = `WITH eligible AS (
      SELECT session.id,session.session_date,session.status session_status,assignment.class_id,assignment.teacher_id,enrollment.student_id
      FROM lesson_sessions session JOIN teaching_assignments assignment ON assignment.id=session.teaching_assignment_id AND assignment.school_id=session.school_id
      JOIN enrollments enrollment ON enrollment.school_id=session.school_id AND enrollment.academic_year_id=session.academic_year_id AND enrollment.class_id=assignment.class_id
        AND enrollment.status IN ('active','completed') AND enrollment.enrolled_at<=session.session_date
      WHERE session.school_id=$1 AND session.academic_year_id=$2 AND session.session_date BETWEEN $3 AND $4 AND session.status<>'cancelled'
        AND ($5::uuid IS NULL OR assignment.class_id=$5) AND ($6::uuid IS NULL OR enrollment.student_id=$6) AND ($7::uuid IS NULL OR assignment.teacher_id=$7)
    ), outcomes AS (
      SELECT eligible.*,record.status attendance_status FROM eligible LEFT JOIN attendance_records record
        ON record.school_id=$1 AND record.lesson_session_id=eligible.id AND record.student_id=eligible.student_id
    )`;
    const aggregateSelect = ` SELECT count(DISTINCT id)::int planned_sessions,count(DISTINCT student_id)::int student_count,
      count(DISTINCT id) FILTER (WHERE session_status='completed' OR attendance_status IS NOT NULL)::int realized_sessions,
      count(*) FILTER (WHERE attendance_status IS NOT NULL)::int marked,
      count(*) FILTER (WHERE attendance_status='present')::int present,
      count(*) FILTER (WHERE attendance_status='late')::int late,
      count(*) FILTER (WHERE attendance_status='absent')::int absent,
      count(*) FILTER (WHERE attendance_status='excused')::int excused
      FROM outcomes`;
    const aggregate = (await pool.query(`${base}${aggregateSelect}`, params)).rows[0];
    const monthly = (await pool.query(`${base} SELECT to_char(date_trunc('month',session_date),'YYYY-MM') AS "month",
      count(DISTINCT id)::int planned_sessions,count(DISTINCT id) FILTER (WHERE session_status='completed' OR attendance_status IS NOT NULL)::int realized_sessions,
      count(*) FILTER (WHERE attendance_status IS NOT NULL)::int marked,count(*) FILTER (WHERE attendance_status='present')::int present,
      count(*) FILTER (WHERE attendance_status='late')::int late,count(*) FILTER (WHERE attendance_status='absent')::int absent,
      count(*) FILTER (WHERE attendance_status='excused')::int excused FROM outcomes GROUP BY 1 ORDER BY 1`, params)).rows;
    const decorate = (item) => ({ ...item, absenceTotal: item.absent + item.excused, effectivePresence: item.present + item.late,
      attendanceRate: rate(item.present + item.late, item.marked), absenceRate: rate(item.absent, item.marked), excusedRate: rate(item.excused, item.marked), lateRate: rate(item.late, item.marked) });
    const topAbsent = scope === "class" && me.role !== "teacher" ? (await pool.query(`${base} SELECT student.id,student.matricule,student.first_name,student.last_name,
      count(*) FILTER (WHERE attendance_status IN ('absent','excused'))::int absences FROM outcomes JOIN students student ON student.id=outcomes.student_id AND student.school_id=$1
      GROUP BY student.id ORDER BY absences DESC,student.last_name LIMIT 10`, params)).rows : [];
    let previousComparison = null;
    if (period) {
      const previous = (await pool.query(`SELECT id,name,starts_on,ends_on FROM academic_periods
        WHERE school_id=$1 AND academic_year_id=$2 AND ends_on<$3 ORDER BY ends_on DESC LIMIT 1`, [me.schoolId, academicYearId, period.starts_on])).rows[0];
      if (previous) {
        const previousAggregate = (await pool.query(`${base}${aggregateSelect}`, [me.schoolId, academicYearId, dateText(previous.starts_on), dateText(previous.ends_on), classId, studentId, teacherId])).rows[0];
        if (previousAggregate.marked) previousComparison = { period: previous, summary: decorate(previousAggregate) };
      }
    }
    const periodEvolution = (await pool.query(`${base} SELECT period.id,period.name,period.kind,period.position,period.starts_on,period.ends_on,
      count(DISTINCT outcomes.id)::int planned_sessions,count(DISTINCT outcomes.student_id)::int student_count,
      count(DISTINCT outcomes.id) FILTER (WHERE outcomes.session_status='completed' OR outcomes.attendance_status IS NOT NULL)::int realized_sessions,
      count(*) FILTER (WHERE outcomes.attendance_status IS NOT NULL)::int marked,count(*) FILTER (WHERE outcomes.attendance_status='present')::int present,
      count(*) FILTER (WHERE outcomes.attendance_status='late')::int late,count(*) FILTER (WHERE outcomes.attendance_status='absent')::int absent,
      count(*) FILTER (WHERE outcomes.attendance_status='excused')::int excused
      FROM academic_periods period LEFT JOIN outcomes ON outcomes.session_date BETWEEN period.starts_on AND period.ends_on
      WHERE period.school_id=$1 AND period.academic_year_id=$2 GROUP BY period.id ORDER BY period.starts_on,period.position`,
      [me.schoolId, academicYearId, dateText(year.starts_on), dateText(year.ends_on), classId, studentId, teacherId])).rows.map(decorate);
    return { scope, academicYearId, academicYear: year.label, period, from, to, formula: "effectivePresence = present + late; denominator = marked outcomes; excused is separate",
      summary: decorate(aggregate), monthly: monthly.map(decorate), periodEvolution, previousComparison, mostAbsent: topAbsent };
  };

  return async function attendanceRouter(req, res, url, me) {
    const route = `${req.method} ${url.pathname}`;
    if (route === "GET /api/academic-periods") {
      const academicYearId = url.searchParams.get("academicYearId") ? identifier(url.searchParams.get("academicYearId")) : null;
      const rows = (await pool.query("SELECT id,academic_year_id,name,kind,position,starts_on,ends_on,created_at,updated_at FROM academic_periods WHERE school_id=$1 AND ($2::uuid IS NULL OR academic_year_id=$2) ORDER BY starts_on,position", [me.schoolId, academicYearId])).rows;
      json(res, 200, rows); return true;
    }
    if (route === "POST /api/academic-periods") {
      if (!["owner", "director"].includes(me.role)) { json(res, 403, { error: "Permission insuffisante" }); return true; }
      const input = await body(req), academicYearId = identifier(input.academicYearId), name = safeText(input.name, { min: 2, max: 100 }), kind = oneOf(input.kind, ["trimester", "semester", "term", "other"]);
      const position = Number(input.position); if (!Number.isInteger(position) || position < 1 || position > 12) throw Error("invalid_body");
      const startsOn = isoDate(input.startsOn), endsOn = isoDate(input.endsOn);
      const row = (await pool.query(`INSERT INTO academic_periods(school_id,academic_year_id,name,kind,position,starts_on,ends_on)
        VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id,academic_year_id,name,kind,position,starts_on,ends_on,created_at,updated_at`, [me.schoolId, academicYearId, name, kind, position, startsOn, endsOn])).rows[0];
      json(res, 201, row); return true;
    }
    if (route === "GET /api/attendance/sessions") {
      const date = isoDate(url.searchParams.get("date") || new Date().toISOString().slice(0, 10));
      const classId = url.searchParams.get("classId") ? identifier(url.searchParams.get("classId")) : null;
      const subjectId = url.searchParams.get("subjectId") ? identifier(url.searchParams.get("subjectId")) : null;
      const teacherId = me.role === "teacher" ? me.sub : (url.searchParams.get("teacherId") ? identifier(url.searchParams.get("teacherId")) : null);
      const rows = (await pool.query(`SELECT session.id,session.academic_year_id,session.session_date,session.start_time,session.end_time,session.status,
        assignment.class_id,assignment.teacher_id,assignment.subject_id,class.name class_name,teacher.name teacher_name,subject.name subject_name,
        count(enrollment.id)::int roster_size,count(record.id)::int marked_count
        FROM lesson_sessions session JOIN teaching_assignments assignment ON assignment.id=session.teaching_assignment_id AND assignment.school_id=session.school_id
        JOIN classes class ON class.id=assignment.class_id AND class.school_id=session.school_id JOIN users teacher ON teacher.id=assignment.teacher_id AND teacher.school_id=session.school_id
        JOIN subjects subject ON subject.id=assignment.subject_id AND subject.school_id=session.school_id
        LEFT JOIN enrollments enrollment ON enrollment.school_id=session.school_id AND enrollment.class_id=assignment.class_id AND enrollment.academic_year_id=session.academic_year_id AND enrollment.status IN ('active','completed') AND enrollment.enrolled_at<=session.session_date
        LEFT JOIN attendance_records record ON record.school_id=session.school_id AND record.lesson_session_id=session.id AND record.student_id=enrollment.student_id
        WHERE session.school_id=$1 AND session.session_date=$2 AND ($3::uuid IS NULL OR assignment.class_id=$3) AND ($4::uuid IS NULL OR assignment.subject_id=$4) AND ($5::uuid IS NULL OR assignment.teacher_id=$5)
        GROUP BY session.id,assignment.id,class.id,teacher.id,subject.id ORDER BY session.start_time,class.name`, [me.schoolId, date, classId, subjectId, teacherId])).rows;
      json(res, 200, rows); return true;
    }
    const rosterMatch = url.pathname.match(/^\/api\/attendance\/sessions\/([^/]+)\/roster$/);
    if (req.method === "GET" && rosterMatch) {
      const id = identifier(rosterMatch[1]), checked = await sessionFor(pool, me, id);
      if (checked.error) { json(res, ...checked.error.map((value, index) => index ? { error: value } : value)); return true; }
      const students = (await pool.query(`SELECT student.id student_id,enrollment.id enrollment_id,student.matricule,student.first_name,student.last_name,
        record.id attendance_record_id,record.status,record.arrival_time,record.reason,record.comment,record.justification_document_id,record.marked_at,record.updated_at,record.version,
        marker.name marked_by_name,updater.name updated_by_name
        FROM enrollments enrollment JOIN students student ON student.id=enrollment.student_id AND student.school_id=enrollment.school_id
        LEFT JOIN attendance_records record ON record.school_id=enrollment.school_id AND record.lesson_session_id=$1 AND record.student_id=student.id
        LEFT JOIN users marker ON marker.id=record.marked_by AND marker.school_id=record.school_id LEFT JOIN users updater ON updater.id=record.updated_by AND updater.school_id=record.school_id
        WHERE enrollment.school_id=$2 AND enrollment.academic_year_id=$3 AND enrollment.class_id=$4 AND enrollment.status IN ('active','completed') AND enrollment.enrolled_at<=$5
        ORDER BY student.last_name,student.first_name,student.matricule`, [id, me.schoolId, checked.row.academic_year_id, checked.row.class_id, checked.row.session_date])).rows;
      json(res, 200, { session: checked.row, students }); return true;
    }
    const recordsMatch = url.pathname.match(/^\/api\/attendance\/sessions\/([^/]+)\/records$/);
    if (req.method === "POST" && recordsMatch) {
      const sessionId = identifier(recordsMatch[1]), input = await body(req);
      if (!Array.isArray(input.records) || input.records.length < 1 || input.records.length > 200) throw Error("invalid_body");
      const seen = new Set(), normalized = input.records.map((record) => {
        const studentId = identifier(record.studentId); if (seen.has(studentId)) throw Error("invalid_body"); seen.add(studentId);
        const status = oneOf(String(record.status || "").toLowerCase(), STATUSES), arrivalTime = status === "late" && record.arrivalTime ? time(record.arrivalTime) : null;
        const reason = record.reason ? safeText(record.reason, { min: status === "excused" ? 2 : 0, max: 500 }) : null;
        if (status === "excused" && !reason) throw Error("invalid_body");
        const comment = record.comment ? safeText(record.comment, { max: 1000 }) : null;
        return { student_id: studentId, status, arrival_time: arrivalTime, reason, comment,
          justification_document_id: record.justificationDocumentId ? identifier(record.justificationDocumentId) : null,
          expected_version: record.expectedVersion === undefined || record.expectedVersion === null ? null : Number(record.expectedVersion) };
      });
      const client = await pool.connect();
      try {
        await client.query("BEGIN"); await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`attendance:${me.schoolId}:${sessionId}`]);
        const checked = await sessionFor(client, me, sessionId, { lock: true });
        if (checked.error) { await client.query("ROLLBACK"); json(res, ...checked.error.map((value, index) => index ? { error: value } : value)); return true; }
        if (checked.row.status === "cancelled") { await client.query("ROLLBACK"); json(res, 409, { error: "L’appel est interdit sur une séance annulée" }); return true; }
        const roster = (await client.query(`SELECT enrollment.id enrollment_id,enrollment.student_id FROM enrollments enrollment
          WHERE enrollment.school_id=$1 AND enrollment.academic_year_id=$2 AND enrollment.class_id=$3 AND enrollment.status IN ('active','completed')
          AND enrollment.enrolled_at<=$4 AND enrollment.student_id=ANY($5::uuid[])`, [me.schoolId, checked.row.academic_year_id, checked.row.class_id, checked.row.session_date, [...seen]])).rows;
        if (roster.length !== normalized.length) { await client.query("ROLLBACK"); json(res, 400, { error: "Un élève ne fait pas partie de cette classe pour cette séance" }); return true; }
        const enrollmentByStudent = new Map(roster.map((row) => [row.student_id, row.enrollment_id]));
        const documentIds = normalized.map((row) => row.justification_document_id).filter(Boolean);
        if (documentIds.length) {
          const valid = (await client.query("SELECT id,student_id FROM attendance_justification_documents WHERE school_id=$1 AND id=ANY($2::uuid[])", [me.schoolId, documentIds])).rows;
          const validMap = new Map(valid.map((row) => [row.id, row.student_id]));
          if (normalized.some((row) => row.justification_document_id && validMap.get(row.justification_document_id) !== row.student_id)) { await client.query("ROLLBACK"); json(res, 400, { error: "Justificatif invalide pour cet élève" }); return true; }
        }
        const existing = (await client.query("SELECT id,student_id,status,version FROM attendance_records WHERE school_id=$1 AND lesson_session_id=$2 AND student_id=ANY($3::uuid[]) FOR UPDATE", [me.schoolId, sessionId, [...seen]])).rows;
        const existingByStudent = new Map(existing.map((row) => [row.student_id, row]));
        for (const row of normalized) {
          const current = existingByStudent.get(row.student_id);
          if (current && !hasPermission(me.role, "attendance.update")) { await client.query("ROLLBACK"); json(res, 403, { error: "Correction de présence non autorisée" }); return true; }
          if (current && row.expected_version !== current.version) { await client.query("ROLLBACK"); json(res, 409, { error: "Cet appel a été modifié par un autre utilisateur. Rechargez la séance." }); return true; }
          if (!current && row.expected_version !== null) { await client.query("ROLLBACK"); json(res, 409, { error: "Cet appel a changé. Rechargez la séance." }); return true; }
          row.enrollment_id = enrollmentByStudent.get(row.student_id);
        }
        const rows = (await client.query(`WITH input AS (SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(student_id uuid,enrollment_id uuid,status text,arrival_time time,reason text,comment text,justification_document_id uuid))
          INSERT INTO attendance_records(school_id,lesson_session_id,student_id,enrollment_id,status,arrival_time,reason,comment,justification_document_id,marked_by)
          SELECT $2,$3,student_id,enrollment_id,status,arrival_time,reason,comment,justification_document_id,$4 FROM input
          ON CONFLICT(school_id,lesson_session_id,student_id) DO UPDATE SET enrollment_id=excluded.enrollment_id,status=excluded.status,arrival_time=excluded.arrival_time,
            reason=excluded.reason,comment=excluded.comment,justification_document_id=excluded.justification_document_id,updated_by=$4,updated_at=now(),version=attendance_records.version+1
          RETURNING id,student_id,status,arrival_time,reason,comment,justification_document_id,marked_at,updated_at,version`, [JSON.stringify(normalized), me.schoolId, sessionId, me.sub])).rows;
        const changes = rows.map((row) => ({ attendance_record_id: row.id, previous_status: existingByStudent.get(row.student_id)?.status || null, new_status: row.status, reason: row.reason, comment: row.comment, student_id: row.student_id }));
        await client.query(`WITH changes AS (SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(attendance_record_id uuid,previous_status text,new_status text,reason text,comment text))
          INSERT INTO attendance_record_events(school_id,attendance_record_id,previous_status,new_status,changed_by,reason,comment)
          SELECT $2,attendance_record_id,previous_status,new_status,$3,reason,comment FROM changes`, [JSON.stringify(changes), me.schoolId, me.sub]);
        const events = changes.filter((change) => change.previous_status !== change.new_status && ["absent", "late", "excused"].includes(change.new_status)).map((change) => ({
          attendance_record_id: change.attendance_record_id, event_type: change.new_status === "absent" ? "student.absent" : change.new_status === "late" ? "student.late" : "absence.justified",
          payload: { studentId: change.student_id, lessonSessionId: sessionId },
        }));
        if (events.length) await client.query(`WITH events AS (SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(attendance_record_id uuid,event_type text,payload jsonb))
          INSERT INTO attendance_domain_events(school_id,event_type,attendance_record_id,payload) SELECT $2,event_type,attendance_record_id,payload FROM events`, [JSON.stringify(events), me.schoolId]);
        await audit(client, me, "attendance.batch_saved", "lesson_session", sessionId, { count: rows.length });
        await client.query("COMMIT"); json(res, 200, { saved: rows.length, records: rows });
      } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
      return true;
    }
    if (route === "POST /api/attendance/justifications") {
      const input = await body(req, { maxStringLength: 2_800_000 }), studentId = identifier(input.studentId), name = safeText(input.name, { min: 1, max: 180, pattern: /^[^\\/\0]+$/ }), contentType = oneOf(input.contentType, ["application/pdf", "image/jpeg", "image/png"]);
      if (typeof input.base64 !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(input.base64)) throw Error("invalid_attendance_document");
      const content = Buffer.from(input.base64, "base64"); if (!content.length || content.length > 2 * 1024 * 1024) throw Error("attendance_document_too_large");
      const signatureOk = contentType === "application/pdf" ? content.subarray(0, 5).toString() === "%PDF-" : contentType === "image/png" ? content.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) : content[0] === 0xff && content[1] === 0xd8 && content[2] === 0xff;
      if (!signatureOk) throw Error("invalid_attendance_document");
      const row = (await pool.query(`INSERT INTO attendance_justification_documents(school_id,student_id,original_name,content_type,size_bytes,sha256,content,uploaded_by)
        SELECT $1,$2,$3,$4,$5,$6,$7,$8 WHERE EXISTS(SELECT 1 FROM students WHERE id=$2 AND school_id=$1)
        RETURNING id,student_id,original_name,content_type,size_bytes,sha256,created_at`, [me.schoolId, studentId, name, contentType, content.length, crypto.createHash("sha256").update(content).digest("hex"), content, me.sub])).rows[0];
      if (!row) json(res, 404, { error: "Élève introuvable" }); else json(res, 201, row); return true;
    }
    const documentMatch = url.pathname.match(/^\/api\/attendance\/justifications\/([^/]+)$/);
    if (req.method === "GET" && documentMatch) {
      const row = (await pool.query("SELECT original_name,content_type,content FROM attendance_justification_documents WHERE id=$1 AND school_id=$2", [identifier(documentMatch[1]), me.schoolId])).rows[0];
      if (!row) json(res, 404, { error: "Justificatif introuvable" }); else binary(res, 200, row.content, row.content_type, row.original_name); return true;
    }
    if (route === "GET /api/attendance/history") {
      const { from, to } = range(url, 31), classId = url.searchParams.get("classId") ? identifier(url.searchParams.get("classId")) : null;
      const studentId = url.searchParams.get("studentId") ? identifier(url.searchParams.get("studentId")) : null;
      const status = url.searchParams.get("status") ? oneOf(url.searchParams.get("status"), STATUSES) : null, teacherId = me.role === "teacher" ? me.sub : null;
      const rows = (await pool.query(`SELECT record.id,record.lesson_session_id,record.student_id,record.status,record.arrival_time,record.reason,record.comment,record.justification_document_id,
        record.marked_at,record.updated_at,record.version,session.session_date,session.start_time,session.end_time,assignment.class_id,assignment.teacher_id,
        class.name class_name,subject.name subject_name,student.matricule,student.first_name,student.last_name,marker.name marked_by_name,updater.name updated_by_name
        FROM attendance_records record JOIN lesson_sessions session ON session.id=record.lesson_session_id AND session.school_id=record.school_id
        JOIN teaching_assignments assignment ON assignment.id=session.teaching_assignment_id AND assignment.school_id=session.school_id JOIN classes class ON class.id=assignment.class_id AND class.school_id=session.school_id
        JOIN subjects subject ON subject.id=assignment.subject_id AND subject.school_id=session.school_id JOIN students student ON student.id=record.student_id AND student.school_id=record.school_id
        JOIN users marker ON marker.id=record.marked_by AND marker.school_id=record.school_id LEFT JOIN users updater ON updater.id=record.updated_by AND updater.school_id=record.school_id
        WHERE record.school_id=$1 AND session.session_date BETWEEN $2 AND $3 AND ($4::uuid IS NULL OR assignment.class_id=$4) AND ($5::uuid IS NULL OR record.student_id=$5)
          AND ($6::text IS NULL OR record.status=$6) AND ($7::uuid IS NULL OR assignment.teacher_id=$7)
        ORDER BY session.session_date DESC,session.start_time DESC,student.last_name LIMIT 5000`, [me.schoolId, from, to, classId, studentId, status, teacherId])).rows;
      json(res, 200, rows); return true;
    }
    const studentSummaryMatch = url.pathname.match(/^\/api\/attendance\/students\/([^/]+)\/summary$/);
    if (req.method === "GET" && studentSummaryMatch) {
      const studentId = identifier(studentSummaryMatch[1]); url.searchParams.set("scope", "student"); url.searchParams.set("studentId", studentId);
      const report = await reportFor(me, url); if (report.error) { json(res, report.error[0], { error: report.error[1] }); return true; }
      const historyUrl = new URL(url); historyUrl.pathname = "/api/attendance/history"; historyUrl.searchParams.set("studentId", studentId); historyUrl.searchParams.set("from", report.from); historyUrl.searchParams.set("to", report.to);
      const recent = (await pool.query(`SELECT record.status,record.arrival_time,record.reason,record.comment,record.updated_at,session.session_date,session.start_time,subject.name subject_name,class.name class_name
        FROM attendance_records record JOIN lesson_sessions session ON session.id=record.lesson_session_id AND session.school_id=record.school_id
        JOIN teaching_assignments assignment ON assignment.id=session.teaching_assignment_id AND assignment.school_id=session.school_id JOIN subjects subject ON subject.id=assignment.subject_id AND subject.school_id=session.school_id
        JOIN classes class ON class.id=assignment.class_id AND class.school_id=session.school_id WHERE record.school_id=$1 AND record.student_id=$2 AND session.session_date BETWEEN $3 AND $4
        ORDER BY session.session_date DESC,session.start_time DESC LIMIT 30`, [me.schoolId, studentId, report.from, report.to])).rows;
      json(res, 200, { ...report, history: recent }); return true;
    }
    if (route === "GET /api/attendance/reports" || route === "GET /api/attendance/reports.csv") {
      const report = await reportFor(me, url); if (report.error) { json(res, report.error[0], { error: report.error[1] }); return true; }
      if (route.endsWith(".csv")) {
        csv(res, "rapport-presences.csv", [["Période","Séances prévues","Séances réalisées","Appels renseignés","Présents","Retards","Absences non justifiées","Absences justifiées","Taux de présence"],
          ...report.monthly.map((item) => [item.month,item.planned_sessions,item.realized_sessions,item.marked,item.present,item.late,item.absent,item.excused,`${item.attendanceRate}%`])]);
        return true;
      }
      json(res, 200, report); return true;
    }
    return false;
  };
}

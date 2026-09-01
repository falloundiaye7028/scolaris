const activeSessionStatuses = ["scheduled", "completed", "rescheduled"];

export function createTimetableRouter({ pool, body, json, identifier, isoDate, pagination, positiveInteger, safeText, oneOf }) {
  const time = (value) => safeText(value, { min: 5, max: 5, pattern: /^(?:[01]\d|2[0-3]):[0-5]\d$/ });
  const dateText = (value) => value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
  const boolean = (value, fallback = true) => value === undefined ? fallback : value === true;
  const lockCalendar = (client, schoolId) => client.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text, 1))", [schoolId]);
  const audit = (client, me, action, entity, entityId, metadata = {}) => client.query(
    "INSERT INTO audit_logs(school_id,user_id,action,entity,entity_id,metadata) VALUES($1,$2,$3,$4,$5,$6)",
    [me.schoolId, me.sub, action, entity, entityId, JSON.stringify(metadata)],
  );

  const conflictFor = async (client, { schoolId, academicYearId, assignmentId, roomId, weekday, sessionDate, startTime, endTime, effectiveFrom, effectiveTo, excludeEntryId, excludeSessionId, sessions = false }) => {
    const assignment = (await client.query(
      `SELECT assignment.id,assignment.teacher_id,assignment.class_id,teacher.name teacher_name,class.name class_name,subject.name subject_name
       FROM teaching_assignments assignment
       JOIN users teacher ON teacher.id=assignment.teacher_id AND teacher.school_id=assignment.school_id
       JOIN classes class ON class.id=assignment.class_id AND class.school_id=assignment.school_id
       JOIN subjects subject ON subject.id=assignment.subject_id AND subject.school_id=assignment.school_id
       WHERE assignment.id=$1 AND assignment.school_id=$2 AND assignment.academic_year_id=$3 AND assignment.status='active' AND subject.active=true`,
      [assignmentId, schoolId, academicYearId],
    )).rows[0];
    if (!assignment) return { status: 404, error: "Affectation pédagogique active introuvable" };
    if (roomId) {
      const room = (await client.query("SELECT id,name,active FROM rooms WHERE id=$1 AND school_id=$2", [roomId, schoolId])).rows[0];
      if (!room) return { status: 404, error: "Salle introuvable" };
      if (!room.active) return { status: 409, error: `La salle ${room.name} est inactive.` };
    }
    const params = [schoolId, academicYearId, assignment.teacher_id, assignment.class_id, roomId, startTime, endTime];
    let query;
    if (sessions) {
      params.push(sessionDate, excludeSessionId || null);
      query = `SELECT session.id,session.start_time,session.end_time,teacher.name teacher_name,class.name class_name,subject.name subject_name,room.name room_name,
                      conflict_assignment.teacher_id,conflict_assignment.class_id,session.room_id
               FROM lesson_sessions session
               JOIN teaching_assignments conflict_assignment ON conflict_assignment.id=session.teaching_assignment_id AND conflict_assignment.school_id=session.school_id
               JOIN users teacher ON teacher.id=conflict_assignment.teacher_id AND teacher.school_id=session.school_id
               JOIN classes class ON class.id=conflict_assignment.class_id AND class.school_id=session.school_id
               JOIN subjects subject ON subject.id=conflict_assignment.subject_id AND subject.school_id=session.school_id
               LEFT JOIN rooms room ON room.id=session.room_id AND room.school_id=session.school_id
               WHERE session.school_id=$1 AND session.academic_year_id=$2 AND session.status=ANY($10::text[]) AND session.session_date=$8
                 AND session.start_time<$7::time AND session.end_time>$6::time AND ($9::uuid IS NULL OR session.id<>$9)
                 AND (conflict_assignment.teacher_id=$3 OR conflict_assignment.class_id=$4 OR ($5::uuid IS NOT NULL AND session.room_id=$5)) LIMIT 1`;
      params.push(activeSessionStatuses);
    } else {
      params.push(weekday, effectiveFrom, effectiveTo || null, excludeEntryId || null);
      query = `SELECT entry.id,entry.start_time,entry.end_time,teacher.name teacher_name,class.name class_name,subject.name subject_name,room.name room_name,
                      conflict_assignment.teacher_id,conflict_assignment.class_id,entry.room_id
               FROM timetable_entries entry
               JOIN teaching_assignments conflict_assignment ON conflict_assignment.id=entry.teaching_assignment_id AND conflict_assignment.school_id=entry.school_id
               JOIN users teacher ON teacher.id=conflict_assignment.teacher_id AND teacher.school_id=entry.school_id
               JOIN classes class ON class.id=conflict_assignment.class_id AND class.school_id=entry.school_id
               JOIN subjects subject ON subject.id=conflict_assignment.subject_id AND subject.school_id=entry.school_id
               LEFT JOIN rooms room ON room.id=entry.room_id AND room.school_id=entry.school_id
               WHERE entry.school_id=$1 AND entry.academic_year_id=$2 AND entry.active=true AND entry.weekday=$8
                 AND entry.start_time<$7::time AND entry.end_time>$6::time AND ($11::uuid IS NULL OR entry.id<>$11)
                 AND entry.effective_from<=COALESCE($10::date,(SELECT ends_on FROM academic_years WHERE id=$2 AND school_id=$1))
                 AND COALESCE(entry.effective_to,(SELECT ends_on FROM academic_years WHERE id=$2 AND school_id=$1))>=$9::date
                 AND (conflict_assignment.teacher_id=$3 OR conflict_assignment.class_id=$4 OR ($5::uuid IS NOT NULL AND entry.room_id=$5)) LIMIT 1`;
    }
    const conflict = (await client.query(query, params)).rows[0];
    if (!conflict) return { assignment };
    const period = `${String(conflict.start_time).slice(0,5)} à ${String(conflict.end_time).slice(0,5)}`;
    if (conflict.teacher_id === assignment.teacher_id) return { status: 409, error: `${conflict.teacher_name} enseigne déjà en ${conflict.class_name} de ${period}.` };
    if (conflict.class_id === assignment.class_id) return { status: 409, error: `La classe ${conflict.class_name} possède déjà un cours de ${conflict.subject_name} de ${period}.` };
    return { status: 409, error: `La salle ${conflict.room_name} est déjà occupée de ${period}.` };
  };

  const listSchedule = async (me, url) => {
    const academicYearId = url.searchParams.get("academicYearId") ? identifier(url.searchParams.get("academicYearId")) : null;
    const classId = url.searchParams.get("classId") ? identifier(url.searchParams.get("classId")) : null;
    const teacherId = me.role === "teacher" ? me.sub : (url.searchParams.get("teacherId") ? identifier(url.searchParams.get("teacherId")) : null);
    const roomId = url.searchParams.get("roomId") ? identifier(url.searchParams.get("roomId")) : null;
    return (await pool.query(
      `SELECT entry.id,entry.academic_year_id,entry.teaching_assignment_id,entry.room_id,entry.weekday,entry.start_time,entry.end_time,
              entry.effective_from,entry.effective_to,entry.active,year.label academic_year,assignment.teacher_id,assignment.class_id,assignment.subject_id,
              teacher.name teacher_name,class.name class_name,subject.name subject_name,room.name room_name
       FROM timetable_entries entry
       JOIN academic_years year ON year.id=entry.academic_year_id AND year.school_id=entry.school_id
       JOIN teaching_assignments assignment ON assignment.id=entry.teaching_assignment_id AND assignment.school_id=entry.school_id
       JOIN users teacher ON teacher.id=assignment.teacher_id AND teacher.school_id=entry.school_id
       JOIN classes class ON class.id=assignment.class_id AND class.school_id=entry.school_id
       JOIN subjects subject ON subject.id=assignment.subject_id AND subject.school_id=entry.school_id
       LEFT JOIN rooms room ON room.id=entry.room_id AND room.school_id=entry.school_id
       WHERE entry.school_id=$1 AND ($2::uuid IS NULL OR entry.academic_year_id=$2) AND ($3::uuid IS NULL OR assignment.class_id=$3)
         AND ($4::uuid IS NULL OR assignment.teacher_id=$4) AND ($5::uuid IS NULL OR entry.room_id=$5)
       ORDER BY entry.weekday,entry.start_time,class.name LIMIT 1000`,
      [me.schoolId, academicYearId, classId, teacherId, roomId],
    )).rows;
  };

  return async function timetableRouter(req, res, url, me) {
    const route = `${req.method} ${url.pathname}`;
    if (route === "GET /api/teachers") {
      const rows = (await pool.query("SELECT id,name,email FROM users WHERE school_id=$1 AND role='teacher' AND is_active=true AND ($2::uuid IS NULL OR id=$2) ORDER BY name", [me.schoolId, me.role === "teacher" ? me.sub : null])).rows;
      json(res, 200, rows); return true;
    }
    if (route === "GET /api/subjects") {
      const rows = (await pool.query("SELECT id,name,code,active,created_at,updated_at FROM subjects WHERE school_id=$1 ORDER BY name", [me.schoolId])).rows;
      json(res, 200, rows); return true;
    }
    if (route === "POST /api/subjects") {
      const input = await body(req), name = safeText(input.name, { min: 2, max: 120 }), code = input.code ? safeText(input.code, { max: 30 }) : null;
      const row = (await pool.query("INSERT INTO subjects(school_id,name,code) VALUES($1,$2,$3) RETURNING id,name,code,active,created_at,updated_at", [me.schoolId, name, code])).rows[0];
      json(res, 201, row); return true;
    }
    if (route === "GET /api/rooms") {
      const rows = (await pool.query("SELECT id,name,code,capacity,active,created_at,updated_at FROM rooms WHERE school_id=$1 ORDER BY name", [me.schoolId])).rows;
      json(res, 200, rows); return true;
    }
    if (route === "POST /api/rooms") {
      const input = await body(req), name = safeText(input.name, { min: 2, max: 120 }), code = input.code ? safeText(input.code, { max: 30 }) : null, capacity = input.capacity ? positiveInteger(input.capacity, { max: 10000 }) : null;
      const row = (await pool.query("INSERT INTO rooms(school_id,name,code,capacity) VALUES($1,$2,$3,$4) RETURNING id,name,code,capacity,active,created_at,updated_at", [me.schoolId, name, code, capacity])).rows[0];
      json(res, 201, row); return true;
    }
    const roomMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)$/);
    if (["PUT", "DELETE"].includes(req.method) && roomMatch) {
      const id = identifier(roomMatch[1]), input = req.method === "PUT" ? await body(req) : {};
      const current = (await pool.query("SELECT id,name,code,capacity,active FROM rooms WHERE id=$1 AND school_id=$2", [id, me.schoolId])).rows[0];
      if (!current) { json(res, 404, { error: "Salle introuvable" }); return true; }
      const name = input.name ? safeText(input.name, { min: 2, max: 120 }) : current.name;
      const code = input.code === undefined ? current.code : (input.code ? safeText(input.code, { max: 30 }) : null);
      const capacity = input.capacity === undefined ? current.capacity : (input.capacity ? positiveInteger(input.capacity, { max: 10000 }) : null);
      const active = req.method === "DELETE" ? false : boolean(input.active, current.active);
      const row = (await pool.query("UPDATE rooms SET name=$1,code=$2,capacity=$3,active=$4,updated_at=now() WHERE id=$5 AND school_id=$6 RETURNING id,name,code,capacity,active,created_at,updated_at", [name, code, capacity, active, id, me.schoolId])).rows[0];
      json(res, 200, row); return true;
    }
    if (route === "GET /api/teaching-assignments") {
      const teacherId = me.role === "teacher" ? me.sub : null;
      const rows = (await pool.query(`SELECT assignment.id,assignment.academic_year_id,assignment.teacher_id,assignment.class_id,assignment.subject_id,assignment.status,
        year.label academic_year,teacher.name teacher_name,class.name class_name,subject.name subject_name
        FROM teaching_assignments assignment JOIN academic_years year ON year.id=assignment.academic_year_id AND year.school_id=assignment.school_id
        JOIN users teacher ON teacher.id=assignment.teacher_id AND teacher.school_id=assignment.school_id JOIN classes class ON class.id=assignment.class_id AND class.school_id=assignment.school_id
        JOIN subjects subject ON subject.id=assignment.subject_id AND subject.school_id=assignment.school_id
        WHERE assignment.school_id=$1 AND ($2::uuid IS NULL OR assignment.teacher_id=$2) ORDER BY year.starts_on DESC,class.name,subject.name`, [me.schoolId, teacherId])).rows;
      json(res, 200, rows); return true;
    }
    if (route === "POST /api/teaching-assignments") {
      const input = await body(req), academicYearId = identifier(input.academicYearId), teacherId = identifier(input.teacherId), classId = identifier(input.classId), subjectId = identifier(input.subjectId);
      const row = (await pool.query(`INSERT INTO teaching_assignments(school_id,academic_year_id,teacher_id,class_id,subject_id)
        SELECT $1,$2,$3,$4,$5 WHERE EXISTS(SELECT 1 FROM users WHERE id=$3 AND school_id=$1 AND role='teacher' AND is_active=true)
        AND EXISTS(SELECT 1 FROM classes WHERE id=$4 AND school_id=$1 AND academic_year_id=$2) AND EXISTS(SELECT 1 FROM subjects WHERE id=$5 AND school_id=$1 AND active=true)
        RETURNING id,academic_year_id,teacher_id,class_id,subject_id,status,created_at,updated_at`, [me.schoolId, academicYearId, teacherId, classId, subjectId])).rows[0];
      if (!row) json(res, 404, { error: "Année, enseignant, classe ou matière introuvable" }); else json(res, 201, row); return true;
    }
    const assignmentMatch = url.pathname.match(/^\/api\/teaching-assignments\/([^/]+)$/);
    if (req.method === "DELETE" && assignmentMatch) {
      const row = (await pool.query("UPDATE teaching_assignments SET status='inactive',updated_at=now() WHERE id=$1 AND school_id=$2 RETURNING id,status", [identifier(assignmentMatch[1]), me.schoolId])).rows[0];
      if (!row) json(res, 404, { error: "Affectation pédagogique introuvable" }); else json(res, 200, row); return true;
    }
    if (route === "GET /api/timetable-entries") { json(res, 200, await listSchedule(me, url)); return true; }
    if (route === "POST /api/timetable-entries") {
      const input = await body(req), academicYearId = identifier(input.academicYearId), assignmentId = identifier(input.teachingAssignmentId), roomId = input.roomId ? identifier(input.roomId) : null;
      const weekday = positiveInteger(input.weekday, { min: 1, max: 7 }), startTime = time(input.startTime), endTime = time(input.endTime), effectiveFrom = isoDate(input.effectiveFrom), effectiveTo = input.effectiveTo ? isoDate(input.effectiveTo) : null;
      if (startTime >= endTime) { json(res, 400, { error: "L’heure de début doit précéder l’heure de fin." }); return true; }
      const client = await pool.connect(); try { await client.query("BEGIN"); await lockCalendar(client, me.schoolId);
        const checked = await conflictFor(client, { schoolId: me.schoolId, academicYearId, assignmentId, roomId, weekday, startTime, endTime, effectiveFrom, effectiveTo });
        if (checked.error) { await client.query("ROLLBACK"); json(res, checked.status, { error: checked.error }); return true; }
        const row = (await client.query(`INSERT INTO timetable_entries(school_id,academic_year_id,teaching_assignment_id,room_id,weekday,start_time,end_time,effective_from,effective_to)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id,academic_year_id,teaching_assignment_id,room_id,weekday,start_time,end_time,effective_from,effective_to,active,created_at,updated_at`, [me.schoolId, academicYearId, assignmentId, roomId, weekday, startTime, endTime, effectiveFrom, effectiveTo])).rows[0];
        await audit(client, me, "timetable_entry.created", "timetable_entry", row.id, { assignmentId, weekday, startTime, endTime }); await client.query("COMMIT"); json(res, 201, row);
      } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); } return true;
    }
    const entryMatch = url.pathname.match(/^\/api\/timetable-entries\/([^/]+)$/);
    if (["PUT", "DELETE"].includes(req.method) && entryMatch) {
      const id = identifier(entryMatch[1]);
      if (req.method === "DELETE") { const row = (await pool.query("UPDATE timetable_entries SET active=false,updated_at=now() WHERE id=$1 AND school_id=$2 RETURNING id,active", [id, me.schoolId])).rows[0]; if (!row) json(res, 404, { error: "Créneau introuvable" }); else json(res, 200, row); return true; }
      const input = await body(req), current = (await pool.query("SELECT academic_year_id,teaching_assignment_id,room_id,weekday,start_time,end_time,effective_from,effective_to,active FROM timetable_entries WHERE id=$1 AND school_id=$2", [id, me.schoolId])).rows[0];
      if (!current) { json(res, 404, { error: "Créneau introuvable" }); return true; }
      const academicYearId = input.academicYearId ? identifier(input.academicYearId) : current.academic_year_id, assignmentId = input.teachingAssignmentId ? identifier(input.teachingAssignmentId) : current.teaching_assignment_id;
      const roomId = input.roomId === undefined ? current.room_id : (input.roomId ? identifier(input.roomId) : null), weekday = input.weekday ? positiveInteger(input.weekday, { min: 1, max: 7 }) : current.weekday;
      const startTime = input.startTime ? time(input.startTime) : String(current.start_time).slice(0,5), endTime = input.endTime ? time(input.endTime) : String(current.end_time).slice(0,5);
      const effectiveFrom = input.effectiveFrom ? isoDate(input.effectiveFrom) : dateText(current.effective_from), effectiveTo = input.effectiveTo === undefined ? (current.effective_to ? dateText(current.effective_to) : null) : (input.effectiveTo ? isoDate(input.effectiveTo) : null);
      if (startTime >= endTime) { json(res, 400, { error: "L’heure de début doit précéder l’heure de fin." }); return true; }
      const client = await pool.connect(); try { await client.query("BEGIN"); await lockCalendar(client, me.schoolId);
        const checked = await conflictFor(client, { schoolId: me.schoolId, academicYearId, assignmentId, roomId, weekday, startTime, endTime, effectiveFrom, effectiveTo, excludeEntryId: id });
        if (checked.error) { await client.query("ROLLBACK"); json(res, checked.status, { error: checked.error }); return true; }
        const row = (await client.query(`UPDATE timetable_entries SET academic_year_id=$1,teaching_assignment_id=$2,room_id=$3,weekday=$4,start_time=$5,end_time=$6,effective_from=$7,effective_to=$8,active=$9,updated_at=now()
          WHERE id=$10 AND school_id=$11 RETURNING id,academic_year_id,teaching_assignment_id,room_id,weekday,start_time,end_time,effective_from,effective_to,active,created_at,updated_at`, [academicYearId, assignmentId, roomId, weekday, startTime, endTime, effectiveFrom, effectiveTo, boolean(input.active, current.active), id, me.schoolId])).rows[0];
        await audit(client, me, "timetable_entry.updated", "timetable_entry", row.id); await client.query("COMMIT"); json(res, 200, row);
      } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); } return true;
    }
    if (route === "POST /api/lesson-sessions/generate") {
      const input = await body(req), academicYearId = identifier(input.academicYearId), from = isoDate(input.from), to = isoDate(input.to);
      const fromDate = new Date(`${from}T00:00:00Z`), toDate = new Date(`${to}T00:00:00Z`), days = Math.round((toDate-fromDate)/86400000)+1;
      if (days < 1 || days > 62) { json(res, 400, { error: "La génération doit couvrir entre 1 et 62 jours." }); return true; }
      const entries = await listSchedule(me, new URL(`http://local/api/timetable-entries?academicYearId=${academicYearId}`));
      const client = await pool.connect(); let created = 0; try { await client.query("BEGIN"); await lockCalendar(client, me.schoolId);
        for (let cursor = new Date(fromDate); cursor <= toDate; cursor.setUTCDate(cursor.getUTCDate()+1)) {
          const date = cursor.toISOString().slice(0,10), weekday = cursor.getUTCDay() || 7;
          for (const entry of entries.filter(item => item.active && Number(item.weekday) === weekday && date >= dateText(item.effective_from) && (!item.effective_to || date <= dateText(item.effective_to)))) {
            if ((await client.query("SELECT 1 FROM lesson_sessions WHERE school_id=$1 AND timetable_entry_id=$2 AND session_date=$3", [me.schoolId, entry.id, date])).rowCount) continue;
            const checked = await conflictFor(client, { schoolId: me.schoolId, academicYearId, assignmentId: entry.teaching_assignment_id, roomId: entry.room_id, sessionDate: date, startTime: String(entry.start_time).slice(0,5), endTime: String(entry.end_time).slice(0,5), sessions: true });
            if (checked.error) { await client.query("ROLLBACK"); json(res, checked.status, { error: checked.error }); return true; }
            const result = await client.query(`INSERT INTO lesson_sessions(school_id,academic_year_id,timetable_entry_id,teaching_assignment_id,room_id,session_date,start_time,end_time)
              VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`, [me.schoolId, academicYearId, entry.id, entry.teaching_assignment_id, entry.room_id, date, entry.start_time, entry.end_time]); created += result.rowCount;
          }
        }
        await audit(client, me, "lesson_sessions.generated", "academic_year", academicYearId, { from, to, created }); await client.query("COMMIT"); json(res, 201, { created, from, to });
      } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); } return true;
    }
    if (route === "GET /api/lesson-sessions") {
      const from = isoDate(url.searchParams.get("from")), to = isoDate(url.searchParams.get("to"));
      const teacherId = me.role === "teacher" ? me.sub : null;
      const rows = (await pool.query(`SELECT session.id,session.academic_year_id,session.timetable_entry_id,session.teaching_assignment_id,session.room_id,session.session_date,session.start_time,session.end_time,session.status,session.title,session.notes,
        assignment.teacher_id,assignment.class_id,assignment.subject_id,teacher.name teacher_name,class.name class_name,subject.name subject_name,room.name room_name
        FROM lesson_sessions session JOIN teaching_assignments assignment ON assignment.id=session.teaching_assignment_id AND assignment.school_id=session.school_id
        JOIN users teacher ON teacher.id=assignment.teacher_id AND teacher.school_id=session.school_id JOIN classes class ON class.id=assignment.class_id AND class.school_id=session.school_id
        JOIN subjects subject ON subject.id=assignment.subject_id AND subject.school_id=session.school_id LEFT JOIN rooms room ON room.id=session.room_id AND room.school_id=session.school_id
        WHERE session.school_id=$1 AND session.session_date BETWEEN $2 AND $3 AND ($4::uuid IS NULL OR assignment.teacher_id=$4) ORDER BY session.session_date,session.start_time LIMIT 5000`, [me.schoolId, from, to, teacherId])).rows;
      json(res, 200, rows); return true;
    }
    const sessionMatch = url.pathname.match(/^\/api\/lesson-sessions\/([^/]+)$/);
    if (req.method === "PUT" && sessionMatch) {
      const id = identifier(sessionMatch[1]), input = await body(req), action = oneOf(input.action, ["cancel", "reschedule"]), client = await pool.connect();
      try { await client.query("BEGIN"); await lockCalendar(client, me.schoolId); const current = (await client.query("SELECT id,academic_year_id,teaching_assignment_id,room_id,session_date,start_time,end_time,status FROM lesson_sessions WHERE id=$1 AND school_id=$2 FOR UPDATE", [id, me.schoolId])).rows[0];
        if (!current) { await client.query("ROLLBACK"); json(res, 404, { error: "Séance introuvable" }); return true; }
        if (action === "cancel") { const row = (await client.query("UPDATE lesson_sessions SET status='cancelled',notes=$1,updated_at=now() WHERE id=$2 AND school_id=$3 RETURNING id,status,notes,updated_at", [input.notes ? safeText(input.notes, { max: 1000 }) : current.notes, id, me.schoolId])).rows[0]; await audit(client, me, "lesson_session.cancelled", "lesson_session", id); await client.query("COMMIT"); json(res, 200, row); return true; }
        const sessionDate = isoDate(input.sessionDate), startTime = time(input.startTime), endTime = time(input.endTime), roomId = input.roomId === undefined ? current.room_id : (input.roomId ? identifier(input.roomId) : null);
        if (startTime >= endTime) { await client.query("ROLLBACK"); json(res, 400, { error: "L’heure de début doit précéder l’heure de fin." }); return true; }
        const checked = await conflictFor(client, { schoolId: me.schoolId, academicYearId: current.academic_year_id, assignmentId: current.teaching_assignment_id, roomId, sessionDate, startTime, endTime, excludeSessionId: id, sessions: true });
        if (checked.error) { await client.query("ROLLBACK"); json(res, checked.status, { error: checked.error }); return true; }
        const row = (await client.query("UPDATE lesson_sessions SET room_id=$1,session_date=$2,start_time=$3,end_time=$4,status='rescheduled',title=$5,notes=$6,updated_at=now() WHERE id=$7 AND school_id=$8 RETURNING id,session_date,start_time,end_time,status,room_id,title,notes,updated_at", [roomId, sessionDate, startTime, endTime, input.title ? safeText(input.title, { max: 180 }) : null, input.notes ? safeText(input.notes, { max: 1000 }) : null, id, me.schoolId])).rows[0];
        await audit(client, me, "lesson_session.rescheduled", "lesson_session", id, { sessionDate, startTime, endTime }); await client.query("COMMIT"); json(res, 200, row);
      } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); } return true;
    }
    return false;
  };
}

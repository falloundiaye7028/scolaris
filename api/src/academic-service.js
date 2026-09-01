const enrollmentStatuses = ["active", "completed", "cancelled"];

export function createAcademicRouter({ pool, body, json, identifier, isoDate, pagination, positiveInteger, safeText, oneOf }) {
  const lockAcademicYear = (client, schoolId) =>
    client.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))", [schoolId]);

  const audit = (client, me, action, entity, entityId, metadata = {}) =>
    client.query(
      "INSERT INTO audit_logs(school_id,user_id,action,entity,entity_id,metadata) VALUES($1,$2,$3,$4,$5,$6)",
      [me.schoolId, me.sub, action, entity, entityId, JSON.stringify(metadata)],
    );

  const syncCurrentClass = (client, schoolId, studentId = null) =>
    client.query(
      `UPDATE students AS student
       SET class_name = (
         SELECT class.name
         FROM enrollments AS enrollment
         JOIN classes AS class
           ON class.id=enrollment.class_id
          AND class.school_id=enrollment.school_id
          AND class.academic_year_id=enrollment.academic_year_id
         JOIN academic_years AS year
           ON year.id=enrollment.academic_year_id
          AND year.school_id=enrollment.school_id
          AND year.is_current=true
         WHERE enrollment.school_id=$1
           AND enrollment.student_id=student.id
           AND enrollment.status='active'
         LIMIT 1
       )
       WHERE student.school_id=$1 AND ($2::uuid IS NULL OR student.id=$2)`,
      [schoolId, studentId],
    );

  const setCurrentYear = async (client, me, academicYearId) => {
    await lockAcademicYear(client, me.schoolId);
    const target = (await client.query(
      "SELECT id,label FROM academic_years WHERE id=$1 AND school_id=$2 FOR UPDATE",
      [academicYearId, me.schoolId],
    )).rows[0];
    if (!target) return null;
    await client.query(
      "UPDATE academic_years SET is_current=false,updated_at=now() WHERE school_id=$1 AND is_current=true AND id<>$2",
      [me.schoolId, academicYearId],
    );
    await client.query(
      "UPDATE academic_years SET is_current=true,updated_at=now() WHERE school_id=$1 AND id=$2 AND is_current=false",
      [me.schoolId, academicYearId],
    );
    await syncCurrentClass(client, me.schoolId);
    return target;
  };

  return async function academicRouter(req, res, url, me) {
    const route = `${req.method} ${url.pathname}`;

    if (route === "GET /api/academic-years") {
      const { limit, offset } = pagination(url.searchParams, { defaultLimit: 50, maxLimit: 100 });
      const result = await pool.query(
        "SELECT id,label,starts_on,ends_on,is_current,created_at,updated_at FROM academic_years WHERE school_id=$1 ORDER BY starts_on DESC LIMIT $2 OFFSET $3",
        [me.schoolId, limit, offset],
      );
      json(res, 200, result.rows);
      return true;
    }

    if (route === "POST /api/academic-years") {
      const input = await body(req);
      const label = safeText(input.label, { min: 3, max: 50 });
      const startsOn = isoDate(input.startsOn);
      const endsOn = isoDate(input.endsOn);
      if (endsOn <= startsOn) {
        json(res, 400, { error: "La date de fin doit suivre la date de début" });
        return true;
      }
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        if (input.isCurrent === true) {
          await lockAcademicYear(client, me.schoolId);
          await client.query("UPDATE academic_years SET is_current=false,updated_at=now() WHERE school_id=$1 AND is_current=true", [me.schoolId]);
        }
        const year = (await client.query(
          "INSERT INTO academic_years(school_id,label,starts_on,ends_on,is_current) VALUES($1,$2,$3,$4,$5) RETURNING id,label,starts_on,ends_on,is_current,created_at,updated_at",
          [me.schoolId, label, startsOn, endsOn, input.isCurrent === true],
        )).rows[0];
        if (year.is_current) await syncCurrentClass(client, me.schoolId);
        await audit(client, me, "academic_year.created", "academic_year", year.id, { isCurrent: year.is_current });
        await client.query("COMMIT");
        json(res, 201, year);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
      return true;
    }

    const currentYearMatch = url.pathname.match(/^\/api\/academic-years\/([^/]+)\/current$/);
    if (req.method === "PUT" && currentYearMatch) {
      const academicYearId = identifier(currentYearMatch[1]);
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const target = await setCurrentYear(client, me, academicYearId);
        if (!target) {
          await client.query("ROLLBACK");
          json(res, 404, { error: "Année scolaire introuvable" });
          return true;
        }
        await audit(client, me, "academic_year.current_changed", "academic_year", target.id, { label: target.label });
        await client.query("COMMIT");
        json(res, 200, { id: target.id, label: target.label, isCurrent: true });
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
      return true;
    }

    if (route === "GET /api/classes") {
      const { limit, offset } = pagination(url.searchParams, { defaultLimit: 200, maxLimit: 200 });
      const academicYearId = url.searchParams.get("academicYearId") ? identifier(url.searchParams.get("academicYearId")) : null;
      const result = await pool.query(
        `SELECT class.id,class.academic_year_id,class.name,class.level,class.capacity,class.created_at,class.updated_at,
                year.label academic_year,year.is_current academic_year_is_current
         FROM classes AS class
         JOIN academic_years AS year
           ON year.id=class.academic_year_id AND year.school_id=class.school_id
         WHERE class.school_id=$1 AND ($2::uuid IS NULL OR class.academic_year_id=$2)
         ORDER BY year.starts_on DESC,class.name LIMIT $3 OFFSET $4`,
        [me.schoolId, academicYearId, limit, offset],
      );
      json(res, 200, result.rows);
      return true;
    }

    if (route === "POST /api/classes") {
      const input = await body(req);
      const academicYearId = identifier(input.academicYearId);
      const name = safeText(input.name, { min: 1, max: 120 });
      const level = input.level ? safeText(input.level, { max: 80 }) : null;
      const capacity = input.capacity ? positiveInteger(input.capacity, { max: 10_000 }) : null;
      const result = await pool.query(
        `INSERT INTO classes(school_id,academic_year_id,name,level,capacity)
         SELECT $1,$2,$3,$4,$5
         WHERE EXISTS(SELECT 1 FROM academic_years WHERE id=$2 AND school_id=$1)
         RETURNING id,academic_year_id,name,level,capacity,created_at,updated_at`,
        [me.schoolId, academicYearId, name, level, capacity],
      );
      if (!result.rows[0]) json(res, 404, { error: "Année scolaire introuvable" });
      else json(res, 201, result.rows[0]);
      return true;
    }

    if (route === "GET /api/guardians") {
      const { limit, offset } = pagination(url.searchParams, { defaultLimit: 200, maxLimit: 200 });
      const result = await pool.query(
        "SELECT id,full_name,phone,email,preferred_language,created_at FROM guardians WHERE school_id=$1 ORDER BY full_name LIMIT $2 OFFSET $3",
        [me.schoolId, limit, offset],
      );
      json(res, 200, result.rows);
      return true;
    }

    if (route === "POST /api/guardians") {
      const input = await body(req);
      const fullName = safeText(input.fullName, { min: 2, max: 180 });
      const phone = input.phone ? safeText(input.phone, { max: 40 }) : null;
      const email = input.email ? safeText(input.email, { min: 3, max: 254, pattern: /^[^\s@]+@[^\s@]+\.[^\s@]+$/ }) .toLowerCase() : null;
      const language = oneOf(input.preferredLanguage || "fr", ["fr", "wo", "en"]);
      const guardian = (await pool.query(
        "INSERT INTO guardians(school_id,full_name,phone,email,preferred_language) VALUES($1,$2,$3,$4,$5) RETURNING id,full_name,phone,email,preferred_language,created_at",
        [me.schoolId, fullName, phone, email, language],
      )).rows[0];
      json(res, 201, guardian);
      return true;
    }

    if (route === "GET /api/enrollments") {
      const { limit, offset } = pagination(url.searchParams, { defaultLimit: 200, maxLimit: 200 });
      const academicYearId = url.searchParams.get("academicYearId") ? identifier(url.searchParams.get("academicYearId")) : null;
      const classId = url.searchParams.get("classId") ? identifier(url.searchParams.get("classId")) : null;
      const studentId = url.searchParams.get("studentId") ? identifier(url.searchParams.get("studentId")) : null;
      const status = url.searchParams.get("status") ? oneOf(url.searchParams.get("status"), enrollmentStatuses) : null;
      const result = await pool.query(
        `SELECT enrollment.id,enrollment.student_id,enrollment.class_id,enrollment.academic_year_id,enrollment.status,
                enrollment.enrolled_at,enrollment.updated_at,student.matricule,student.first_name,student.last_name,
                class.name class_name,class.level,year.label academic_year,year.is_current academic_year_is_current
         FROM enrollments AS enrollment
         JOIN students AS student ON student.id=enrollment.student_id AND student.school_id=enrollment.school_id
         JOIN classes AS class ON class.id=enrollment.class_id AND class.school_id=enrollment.school_id
         JOIN academic_years AS year ON year.id=enrollment.academic_year_id AND year.school_id=enrollment.school_id
         WHERE enrollment.school_id=$1
           AND ($2::uuid IS NULL OR enrollment.academic_year_id=$2)
           AND ($3::uuid IS NULL OR enrollment.class_id=$3)
           AND ($4::uuid IS NULL OR enrollment.student_id=$4)
           AND ($5::text IS NULL OR enrollment.status=$5)
         ORDER BY year.starts_on DESC,class.name,student.last_name,student.first_name
         LIMIT $6 OFFSET $7`,
        [me.schoolId, academicYearId, classId, studentId, status, limit, offset],
      );
      json(res, 200, result.rows);
      return true;
    }

    if (route === "POST /api/enrollments") {
      const input = await body(req);
      const studentId = identifier(input.studentId);
      const classId = identifier(input.classId);
      const academicYearId = identifier(input.academicYearId);
      const status = oneOf(input.status || "active", enrollmentStatuses);
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const enrollment = (await client.query(
          `INSERT INTO enrollments(school_id,student_id,class_id,academic_year_id,status)
           SELECT $1,$2,$3,$4,$5
           WHERE EXISTS(SELECT 1 FROM students WHERE id=$2 AND school_id=$1)
             AND EXISTS(SELECT 1 FROM classes WHERE id=$3 AND academic_year_id=$4 AND school_id=$1)
           RETURNING id,student_id,class_id,academic_year_id,status,enrolled_at,updated_at`,
          [me.schoolId, studentId, classId, academicYearId, status],
        )).rows[0];
        if (!enrollment) {
          await client.query("ROLLBACK");
          json(res, 404, { error: "Élève, classe ou année scolaire introuvable" });
          return true;
        }
        await syncCurrentClass(client, me.schoolId, studentId);
        await audit(client, me, "enrollment.created", "enrollment", enrollment.id, { studentId, classId, academicYearId, status });
        await client.query("COMMIT");
        json(res, 201, enrollment);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
      return true;
    }

    const enrollmentMatch = url.pathname.match(/^\/api\/enrollments\/([^/]+)$/);
    if (req.method === "PUT" && enrollmentMatch) {
      const enrollmentId = identifier(enrollmentMatch[1]);
      const input = await body(req);
      const classId = identifier(input.classId);
      const academicYearId = identifier(input.academicYearId);
      const status = oneOf(input.status || "active", enrollmentStatuses);
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const enrollment = (await client.query(
          `UPDATE enrollments AS enrollment
           SET class_id=$1,academic_year_id=$2,status=$3,updated_at=now()
           WHERE enrollment.id=$4 AND enrollment.school_id=$5
             AND EXISTS(SELECT 1 FROM classes WHERE id=$1 AND academic_year_id=$2 AND school_id=$5)
           RETURNING id,student_id,class_id,academic_year_id,status,enrolled_at,updated_at`,
          [classId, academicYearId, status, enrollmentId, me.schoolId],
        )).rows[0];
        if (!enrollment) {
          await client.query("ROLLBACK");
          json(res, 404, { error: "Inscription ou classe introuvable" });
          return true;
        }
        await syncCurrentClass(client, me.schoolId, enrollment.student_id);
        await audit(client, me, "enrollment.updated", "enrollment", enrollment.id, { classId, academicYearId, status });
        await client.query("COMMIT");
        json(res, 200, enrollment);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
      return true;
    }

    if (route === "GET /api/student-guardians") {
      const studentId = identifier(url.searchParams.get("studentId"));
      const links = await pool.query(
        `SELECT link.student_id,link.guardian_id,link.relationship,link.is_primary,
                guardian.full_name,guardian.phone,guardian.email,guardian.preferred_language
         FROM student_guardians AS link
         JOIN guardians AS guardian ON guardian.id=link.guardian_id AND guardian.school_id=link.school_id
         WHERE link.school_id=$1 AND link.student_id=$2
         ORDER BY link.is_primary DESC,guardian.full_name`,
        [me.schoolId, studentId],
      );
      json(res, 200, links.rows);
      return true;
    }

    if (route === "POST /api/student-guardians") {
      const input = await body(req);
      const studentId = identifier(input.studentId);
      const guardianId = identifier(input.guardianId);
      const relationship = safeText(input.relationship || "parent", { min: 2, max: 60 });
      const isPrimary = input.isPrimary === true;
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        if (isPrimary) {
          await client.query("UPDATE student_guardians SET is_primary=false WHERE school_id=$1 AND student_id=$2 AND is_primary=true", [me.schoolId, studentId]);
        }
        const link = (await client.query(
          `INSERT INTO student_guardians(school_id,student_id,guardian_id,relationship,is_primary)
           SELECT $1,$2,$3,$4,$5
           WHERE EXISTS(SELECT 1 FROM students WHERE id=$2 AND school_id=$1)
             AND EXISTS(SELECT 1 FROM guardians WHERE id=$3 AND school_id=$1)
           ON CONFLICT(student_id,guardian_id) DO UPDATE
             SET relationship=EXCLUDED.relationship,is_primary=EXCLUDED.is_primary,school_id=EXCLUDED.school_id
           RETURNING student_id,guardian_id,relationship,is_primary`,
          [me.schoolId, studentId, guardianId, relationship, isPrimary],
        )).rows[0];
        if (!link) {
          await client.query("ROLLBACK");
          json(res, 404, { error: "Élève ou responsable introuvable" });
          return true;
        }
        await audit(client, me, "student_guardian.linked", "student", studentId, { guardianId, relationship, isPrimary });
        await client.query("COMMIT");
        json(res, 201, link);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
      return true;
    }

    return false;
  };
}

-- M1 — Fondation académique additive.
-- Les colonnes historiques sont conservées ; enrollments devient la source de vérité
-- de la classe annuelle et students.class_name reste une projection de compatibilité.

ALTER TABLE academic_years ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE academic_years ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE classes ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE classes ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE enrollments ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

-- Une migration d'une base historique peut rencontrer plusieurs années courantes.
-- La plus récente reste courante ; les autres sont conservées comme archives.
WITH ranked_current_years AS (
  SELECT id, row_number() OVER (PARTITION BY school_id ORDER BY starts_on DESC, id DESC) AS position
  FROM academic_years
  WHERE is_current = true
)
UPDATE academic_years AS year
SET is_current = false, updated_at = now()
FROM ranked_current_years AS ranked
WHERE year.id = ranked.id AND ranked.position > 1;

CREATE UNIQUE INDEX IF NOT EXISTS idx_academic_years_school_id_id ON academic_years(school_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_academic_years_one_current ON academic_years(school_id) WHERE is_current = true;
CREATE INDEX IF NOT EXISTS idx_academic_years_school_dates ON academic_years(school_id, starts_on DESC, ends_on DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_students_school_id_id ON students(school_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_guardians_school_id_id ON guardians(school_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_classes_school_id_id ON classes(school_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_classes_school_id_year_id ON classes(school_id, id, academic_year_id);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM students WHERE status NOT IN ('active', 'inactive', 'transferred', 'graduated', 'archived')) THEN
    RAISE EXCEPTION 'invalid historical student status';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'students_status_check') THEN
    ALTER TABLE students ADD CONSTRAINT students_status_check
      CHECK (status IN ('active', 'inactive', 'transferred', 'graduated', 'archived')) NOT VALID;
    ALTER TABLE students VALIDATE CONSTRAINT students_status_check;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM enrollments WHERE status NOT IN ('active', 'completed', 'cancelled')) THEN
    RAISE EXCEPTION 'invalid historical enrollment status';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'enrollments_status_check') THEN
    ALTER TABLE enrollments ADD CONSTRAINT enrollments_status_check
      CHECK (status IN ('active', 'completed', 'cancelled')) NOT VALID;
    ALTER TABLE enrollments VALIDATE CONSTRAINT enrollments_status_check;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'classes_school_academic_year_fkey') THEN
    ALTER TABLE classes ADD CONSTRAINT classes_school_academic_year_fkey
      FOREIGN KEY (school_id, academic_year_id)
      REFERENCES academic_years(school_id, id) ON DELETE CASCADE NOT VALID;
    ALTER TABLE classes VALIDATE CONSTRAINT classes_school_academic_year_fkey;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'enrollments_school_student_fkey') THEN
    ALTER TABLE enrollments ADD CONSTRAINT enrollments_school_student_fkey
      FOREIGN KEY (school_id, student_id)
      REFERENCES students(school_id, id) ON DELETE CASCADE NOT VALID;
    ALTER TABLE enrollments VALIDATE CONSTRAINT enrollments_school_student_fkey;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'enrollments_school_academic_year_fkey') THEN
    ALTER TABLE enrollments ADD CONSTRAINT enrollments_school_academic_year_fkey
      FOREIGN KEY (school_id, academic_year_id)
      REFERENCES academic_years(school_id, id) ON DELETE RESTRICT NOT VALID;
    ALTER TABLE enrollments VALIDATE CONSTRAINT enrollments_school_academic_year_fkey;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'enrollments_school_class_year_fkey') THEN
    ALTER TABLE enrollments ADD CONSTRAINT enrollments_school_class_year_fkey
      FOREIGN KEY (school_id, class_id, academic_year_id)
      REFERENCES classes(school_id, id, academic_year_id) ON DELETE RESTRICT NOT VALID;
    ALTER TABLE enrollments VALIDATE CONSTRAINT enrollments_school_class_year_fkey;
  END IF;
END $$;

ALTER TABLE student_guardians ADD COLUMN IF NOT EXISTS school_id uuid;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM student_guardians AS link
    JOIN students AS student ON student.id = link.student_id
    JOIN guardians AS guardian ON guardian.id = link.guardian_id
    WHERE student.school_id <> guardian.school_id
  ) THEN
    RAISE EXCEPTION 'cross-school student guardian link detected';
  END IF;
END $$;

UPDATE student_guardians AS link
SET school_id = student.school_id
FROM students AS student
WHERE student.id = link.student_id AND link.school_id IS NULL;

ALTER TABLE student_guardians ALTER COLUMN school_id SET NOT NULL;

WITH ranked_primary_guardians AS (
  SELECT student_id, guardian_id,
    row_number() OVER (PARTITION BY school_id, student_id ORDER BY guardian_id) AS position
  FROM student_guardians
  WHERE is_primary = true
)
UPDATE student_guardians AS link
SET is_primary = false
FROM ranked_primary_guardians AS ranked
WHERE link.student_id = ranked.student_id
  AND link.guardian_id = ranked.guardian_id
  AND ranked.position > 1;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'student_guardians_school_fkey') THEN
    ALTER TABLE student_guardians ADD CONSTRAINT student_guardians_school_fkey
      FOREIGN KEY (school_id) REFERENCES schools(id) ON DELETE CASCADE NOT VALID;
    ALTER TABLE student_guardians VALIDATE CONSTRAINT student_guardians_school_fkey;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'student_guardians_school_student_fkey') THEN
    ALTER TABLE student_guardians ADD CONSTRAINT student_guardians_school_student_fkey
      FOREIGN KEY (school_id, student_id)
      REFERENCES students(school_id, id) ON DELETE CASCADE NOT VALID;
    ALTER TABLE student_guardians VALIDATE CONSTRAINT student_guardians_school_student_fkey;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'student_guardians_school_guardian_fkey') THEN
    ALTER TABLE student_guardians ADD CONSTRAINT student_guardians_school_guardian_fkey
      FOREIGN KEY (school_id, guardian_id)
      REFERENCES guardians(school_id, id) ON DELETE CASCADE NOT VALID;
    ALTER TABLE student_guardians VALIDATE CONSTRAINT student_guardians_school_guardian_fkey;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_student_guardians_one_primary
  ON student_guardians(school_id, student_id) WHERE is_primary = true;
CREATE INDEX IF NOT EXISTS idx_student_guardians_school_guardian
  ON student_guardians(school_id, guardian_id);
CREATE INDEX IF NOT EXISTS idx_enrollments_school_class
  ON enrollments(school_id, academic_year_id, class_id, status);


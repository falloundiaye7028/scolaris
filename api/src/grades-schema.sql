-- M4 — Notes, évaluations, coefficients et moyennes.
-- Migration additive, idempotente et compatible avec M1, M2 et M3.

ALTER TABLE teaching_assignments
  ADD COLUMN IF NOT EXISTS subject_coefficient numeric(8,4) NOT NULL DEFAULT 1;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='teaching_assignments_subject_coefficient_check') THEN
    ALTER TABLE teaching_assignments ADD CONSTRAINT teaching_assignments_subject_coefficient_check
      CHECK(subject_coefficient>0 AND subject_coefficient<=1000);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS grading_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  scale_max numeric(8,2) NOT NULL DEFAULT 20 CHECK(scale_max>0 AND scale_max<=1000),
  rounding_precision smallint NOT NULL DEFAULT 2 CHECK(rounding_precision BETWEEN 0 AND 4),
  absence_policy text NOT NULL DEFAULT 'exclude' CHECK(absence_policy IN ('exclude','zero')),
  missing_grade_policy text NOT NULL DEFAULT 'exclude' CHECK(missing_grade_policy IN ('exclude')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  UNIQUE(school_id),
  UNIQUE(school_id,id),
  CONSTRAINT grading_settings_school_updater_fkey FOREIGN KEY(school_id,updated_by) REFERENCES users(school_id,id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS assessment_types (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  code text NOT NULL CHECK(code~'^[a-z][a-z0-9_]{1,39}$'),
  name text NOT NULL CHECK(length(btrim(name)) BETWEEN 2 AND 100),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(school_id,id),
  UNIQUE(school_id,code)
);
CREATE INDEX IF NOT EXISTS idx_assessment_types_active ON assessment_types(school_id,active,name);

INSERT INTO grading_settings(school_id)
SELECT id FROM schools ON CONFLICT(school_id) DO NOTHING;

INSERT INTO assessment_types(school_id,code,name)
SELECT school.id,seed.code,seed.name
FROM schools AS school
CROSS JOIN (VALUES
  ('quiz','Interrogation'),('assignment','Devoir'),('composition','Composition'),
  ('exam','Examen'),('project','Projet'),('practical','Travaux pratiques'),
  ('participation','Participation'),('other','Autre')
) AS seed(code,name)
ON CONFLICT(school_id,code) DO NOTHING;

CREATE TABLE IF NOT EXISTS assessments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  academic_year_id uuid NOT NULL,
  academic_period_id uuid NOT NULL,
  teaching_assignment_id uuid NOT NULL,
  assessment_type_id uuid NOT NULL,
  title text NOT NULL CHECK(length(btrim(title)) BETWEEN 2 AND 160),
  description text CHECK(description IS NULL OR length(description)<=2000),
  assessment_date date NOT NULL,
  maximum_score numeric(10,4) NOT NULL CHECK(maximum_score>0 AND maximum_score<=100000),
  coefficient numeric(8,4) NOT NULL DEFAULT 1 CHECK(coefficient>0 AND coefficient<=1000),
  status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','published','locked','cancelled')),
  published_at timestamptz,
  published_by uuid,
  locked_at timestamptz,
  locked_by uuid,
  version integer NOT NULL DEFAULT 1 CHECK(version>0),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(school_id,id),
  UNIQUE(school_id,id,academic_year_id),
  CONSTRAINT assessments_school_year_fkey FOREIGN KEY(school_id,academic_year_id) REFERENCES academic_years(school_id,id) ON DELETE RESTRICT,
  CONSTRAINT assessments_school_period_year_fkey FOREIGN KEY(school_id,academic_period_id,academic_year_id) REFERENCES academic_periods(school_id,id,academic_year_id) ON DELETE RESTRICT,
  CONSTRAINT assessments_school_assignment_year_fkey FOREIGN KEY(school_id,teaching_assignment_id,academic_year_id) REFERENCES teaching_assignments(school_id,id,academic_year_id) ON DELETE RESTRICT,
  CONSTRAINT assessments_school_type_fkey FOREIGN KEY(school_id,assessment_type_id) REFERENCES assessment_types(school_id,id) ON DELETE RESTRICT,
  CONSTRAINT assessments_school_creator_fkey FOREIGN KEY(school_id,created_by) REFERENCES users(school_id,id) ON DELETE RESTRICT,
  CONSTRAINT assessments_school_updater_fkey FOREIGN KEY(school_id,updated_by) REFERENCES users(school_id,id) ON DELETE RESTRICT,
  CONSTRAINT assessments_school_publisher_fkey FOREIGN KEY(school_id,published_by) REFERENCES users(school_id,id) ON DELETE RESTRICT,
  CONSTRAINT assessments_school_locker_fkey FOREIGN KEY(school_id,locked_by) REFERENCES users(school_id,id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_assessments_assignment_period ON assessments(school_id,teaching_assignment_id,academic_period_id,assessment_date DESC);
CREATE INDEX IF NOT EXISTS idx_assessments_period_status ON assessments(school_id,academic_period_id,status,assessment_date DESC);
CREATE INDEX IF NOT EXISTS idx_assessments_year_status ON assessments(school_id,academic_year_id,status,assessment_date DESC);

CREATE TABLE IF NOT EXISTS grades (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  assessment_id uuid NOT NULL,
  student_id uuid NOT NULL,
  enrollment_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('scored','absent','excused','exempt','pending')),
  score numeric(10,4),
  normalized_score numeric(12,6),
  comment text CHECK(comment IS NULL OR length(comment)<=1000),
  entered_by uuid NOT NULL,
  entered_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1 CHECK(version>0),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK((status='scored' AND score IS NOT NULL) OR (status<>'scored' AND score IS NULL)),
  CHECK(score IS NULL OR score>=0),
  UNIQUE(school_id,id),
  UNIQUE(school_id,assessment_id,student_id),
  CONSTRAINT grades_school_assessment_fkey FOREIGN KEY(school_id,assessment_id) REFERENCES assessments(school_id,id) ON DELETE RESTRICT,
  CONSTRAINT grades_school_student_fkey FOREIGN KEY(school_id,student_id) REFERENCES students(school_id,id) ON DELETE RESTRICT,
  CONSTRAINT grades_school_enrollment_fkey FOREIGN KEY(school_id,enrollment_id) REFERENCES enrollments(school_id,id) ON DELETE RESTRICT,
  CONSTRAINT grades_school_entered_by_fkey FOREIGN KEY(school_id,entered_by) REFERENCES users(school_id,id) ON DELETE RESTRICT,
  CONSTRAINT grades_school_updated_by_fkey FOREIGN KEY(school_id,updated_by) REFERENCES users(school_id,id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_grades_assessment_status ON grades(school_id,assessment_id,status);
CREATE INDEX IF NOT EXISTS idx_grades_student_assessment ON grades(school_id,student_id,assessment_id);
CREATE INDEX IF NOT EXISTS idx_grades_enrollment ON grades(school_id,enrollment_id);

CREATE TABLE IF NOT EXISTS grade_events (
  id bigserial PRIMARY KEY,
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  grade_id uuid NOT NULL,
  previous_status text CHECK(previous_status IS NULL OR previous_status IN ('scored','absent','excused','exempt','pending')),
  new_status text NOT NULL CHECK(new_status IN ('scored','absent','excused','exempt','pending')),
  previous_score numeric(10,4),
  new_score numeric(10,4),
  changed_by uuid NOT NULL,
  reason text CHECK(reason IS NULL OR length(btrim(reason)) BETWEEN 8 AND 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT grade_events_school_grade_fkey FOREIGN KEY(school_id,grade_id) REFERENCES grades(school_id,id) ON DELETE RESTRICT,
  CONSTRAINT grade_events_school_user_fkey FOREIGN KEY(school_id,changed_by) REFERENCES users(school_id,id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_grade_events_history ON grade_events(school_id,grade_id,created_at DESC);

CREATE OR REPLACE FUNCTION validate_m4_grade_reference() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE assessment_row record; enrollment_row record; year_row record; period_row record; assignment_row record; scale numeric;
BEGIN
  IF TG_TABLE_NAME='assessments' THEN
    SELECT starts_on,ends_on INTO year_row FROM academic_years WHERE school_id=NEW.school_id AND id=NEW.academic_year_id;
    SELECT starts_on,ends_on INTO period_row FROM academic_periods WHERE school_id=NEW.school_id AND id=NEW.academic_period_id AND academic_year_id=NEW.academic_year_id;
    SELECT assignment.status,subject.active INTO assignment_row
      FROM teaching_assignments assignment JOIN subjects subject ON subject.id=assignment.subject_id AND subject.school_id=assignment.school_id
      WHERE assignment.school_id=NEW.school_id AND assignment.id=NEW.teaching_assignment_id AND assignment.academic_year_id=NEW.academic_year_id;
    IF NOT FOUND OR assignment_row.status<>'active' OR assignment_row.active IS NOT TRUE THEN RAISE EXCEPTION 'inactive or invalid teaching assignment'; END IF;
    IF NEW.assessment_date<year_row.starts_on OR NEW.assessment_date>year_row.ends_on THEN RAISE EXCEPTION 'assessment outside academic year'; END IF;
    IF period_row IS NULL OR NEW.assessment_date<period_row.starts_on OR NEW.assessment_date>period_row.ends_on THEN RAISE EXCEPTION 'assessment outside academic period'; END IF;
    RETURN NEW;
  END IF;

  SELECT assessment.status,assessment.maximum_score,assessment.assessment_date,assessment.academic_year_id,assignment.class_id
    INTO assessment_row FROM assessments assessment
    JOIN teaching_assignments assignment ON assignment.id=assessment.teaching_assignment_id AND assignment.school_id=assessment.school_id
    WHERE assessment.school_id=NEW.school_id AND assessment.id=NEW.assessment_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'invalid assessment'; END IF;
  IF assessment_row.status='cancelled' THEN RAISE EXCEPTION 'grade forbidden for cancelled assessment'; END IF;
  IF assessment_row.status='locked' THEN RAISE EXCEPTION 'grade forbidden for locked assessment'; END IF;
  SELECT student_id,class_id,academic_year_id,status,enrolled_at INTO enrollment_row
    FROM enrollments WHERE school_id=NEW.school_id AND id=NEW.enrollment_id;
  IF NOT FOUND OR enrollment_row.student_id<>NEW.student_id OR enrollment_row.class_id<>assessment_row.class_id
    OR enrollment_row.academic_year_id<>assessment_row.academic_year_id OR enrollment_row.status NOT IN ('active','completed')
    OR enrollment_row.enrolled_at>assessment_row.assessment_date THEN RAISE EXCEPTION 'student not enrolled for assessment'; END IF;
  IF NEW.status='scored' THEN
    IF NEW.score IS NULL OR NEW.score<0 OR NEW.score>assessment_row.maximum_score THEN RAISE EXCEPTION 'score outside assessment scale'; END IF;
    SELECT COALESCE(scale_max,20) INTO scale FROM grading_settings WHERE school_id=NEW.school_id;
    NEW.normalized_score=round((NEW.score/assessment_row.maximum_score)*COALESCE(scale,20),6);
  ELSE
    IF NEW.score IS NOT NULL THEN RAISE EXCEPTION 'non-scored grade cannot carry score'; END IF;
    NEW.normalized_score=NULL;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_validate_m4_assessment ON assessments;
CREATE TRIGGER trg_validate_m4_assessment BEFORE INSERT OR UPDATE ON assessments FOR EACH ROW EXECUTE FUNCTION validate_m4_grade_reference();
DROP TRIGGER IF EXISTS trg_validate_m4_grade ON grades;
CREATE TRIGGER trg_validate_m4_grade BEFORE INSERT OR UPDATE ON grades FOR EACH ROW EXECUTE FUNCTION validate_m4_grade_reference();


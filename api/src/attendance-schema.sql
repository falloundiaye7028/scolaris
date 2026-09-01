-- M3 — Présences, absences, retards et justificatifs.
-- Migration additive, idempotente et reliée aux séances M2.

CREATE UNIQUE INDEX IF NOT EXISTS idx_enrollments_school_id_id ON enrollments(school_id,id);

CREATE TABLE IF NOT EXISTS academic_periods (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  academic_year_id uuid NOT NULL,
  name text NOT NULL,
  kind text NOT NULL CHECK(kind IN ('trimester','semester','term','other')),
  position smallint NOT NULL CHECK(position BETWEEN 1 AND 12),
  starts_on date NOT NULL,
  ends_on date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK(starts_on<=ends_on),
  UNIQUE(school_id,id),
  UNIQUE(school_id,id,academic_year_id),
  UNIQUE(school_id,academic_year_id,kind,position),
  CONSTRAINT academic_periods_school_year_fkey FOREIGN KEY(school_id,academic_year_id) REFERENCES academic_years(school_id,id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_academic_periods_year_dates ON academic_periods(school_id,academic_year_id,starts_on,ends_on);

CREATE TABLE IF NOT EXISTS attendance_justification_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  student_id uuid NOT NULL,
  original_name text NOT NULL,
  content_type text NOT NULL CHECK(content_type IN ('application/pdf','image/jpeg','image/png')),
  size_bytes integer NOT NULL CHECK(size_bytes BETWEEN 1 AND 2097152),
  sha256 char(64) NOT NULL,
  content bytea NOT NULL,
  uploaded_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(school_id,id),
  UNIQUE(school_id,id,student_id),
  CONSTRAINT attendance_documents_school_student_fkey FOREIGN KEY(school_id,student_id) REFERENCES students(school_id,id) ON DELETE RESTRICT,
  CONSTRAINT attendance_documents_school_uploader_fkey FOREIGN KEY(school_id,uploaded_by) REFERENCES users(school_id,id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_attendance_documents_student ON attendance_justification_documents(school_id,student_id,created_at DESC);

CREATE TABLE IF NOT EXISTS attendance_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  lesson_session_id uuid NOT NULL,
  student_id uuid NOT NULL,
  enrollment_id uuid NOT NULL,
  status text NOT NULL CHECK(status IN ('present','absent','late','excused')),
  arrival_time time,
  reason text,
  comment text,
  justification_document_id uuid,
  marked_by uuid NOT NULL,
  marked_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1 CHECK(version>0),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK(status='late' OR arrival_time IS NULL),
  CHECK(status<>'excused' OR nullif(btrim(reason),'') IS NOT NULL),
  UNIQUE(school_id,id),
  UNIQUE(school_id,lesson_session_id,student_id),
  CONSTRAINT attendance_records_school_session_fkey FOREIGN KEY(school_id,lesson_session_id) REFERENCES lesson_sessions(school_id,id) ON DELETE RESTRICT,
  CONSTRAINT attendance_records_school_student_fkey FOREIGN KEY(school_id,student_id) REFERENCES students(school_id,id) ON DELETE RESTRICT,
  CONSTRAINT attendance_records_school_enrollment_fkey FOREIGN KEY(school_id,enrollment_id) REFERENCES enrollments(school_id,id) ON DELETE RESTRICT,
  CONSTRAINT attendance_records_school_document_student_fkey FOREIGN KEY(school_id,justification_document_id,student_id) REFERENCES attendance_justification_documents(school_id,id,student_id) ON DELETE RESTRICT,
  CONSTRAINT attendance_records_school_marker_fkey FOREIGN KEY(school_id,marked_by) REFERENCES users(school_id,id) ON DELETE RESTRICT,
  CONSTRAINT attendance_records_school_updater_fkey FOREIGN KEY(school_id,updated_by) REFERENCES users(school_id,id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_attendance_session ON attendance_records(school_id,lesson_session_id,status);
CREATE INDEX IF NOT EXISTS idx_attendance_student ON attendance_records(school_id,student_id,lesson_session_id);
CREATE INDEX IF NOT EXISTS idx_attendance_status ON attendance_records(school_id,status,lesson_session_id);

CREATE TABLE IF NOT EXISTS attendance_record_events (
  id bigserial PRIMARY KEY,
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  attendance_record_id uuid NOT NULL,
  previous_status text CHECK(previous_status IS NULL OR previous_status IN ('present','absent','late','excused')),
  new_status text NOT NULL CHECK(new_status IN ('present','absent','late','excused')),
  changed_by uuid NOT NULL,
  reason text,
  comment text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT attendance_events_school_record_fkey FOREIGN KEY(school_id,attendance_record_id) REFERENCES attendance_records(school_id,id) ON DELETE RESTRICT,
  CONSTRAINT attendance_events_school_user_fkey FOREIGN KEY(school_id,changed_by) REFERENCES users(school_id,id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_attendance_record_events_history ON attendance_record_events(school_id,attendance_record_id,created_at DESC);

CREATE TABLE IF NOT EXISTS attendance_domain_events (
  id bigserial PRIMARY KEY,
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  event_type text NOT NULL CHECK(event_type IN ('student.absent','student.late','absence.justified')),
  attendance_record_id uuid NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}',
  occurred_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  CONSTRAINT attendance_domain_events_school_record_fkey FOREIGN KEY(school_id,attendance_record_id) REFERENCES attendance_records(school_id,id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_attendance_domain_events_pending ON attendance_domain_events(school_id,occurred_at) WHERE published_at IS NULL;

CREATE OR REPLACE FUNCTION validate_m3_attendance_reference() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE session_row record; enrollment_row record; year_row record;
BEGIN
  IF TG_TABLE_NAME='academic_periods' THEN
    SELECT starts_on,ends_on INTO year_row FROM academic_years WHERE school_id=NEW.school_id AND id=NEW.academic_year_id;
    IF NOT FOUND OR NEW.starts_on<year_row.starts_on OR NEW.ends_on>year_row.ends_on THEN RAISE EXCEPTION 'academic period outside academic year'; END IF;
    RETURN NEW;
  END IF;
  SELECT session.status,session.session_date,session.academic_year_id,assignment.class_id
    INTO session_row FROM lesson_sessions session
    JOIN teaching_assignments assignment ON assignment.id=session.teaching_assignment_id AND assignment.school_id=session.school_id
    WHERE session.school_id=NEW.school_id AND session.id=NEW.lesson_session_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'invalid attendance lesson session'; END IF;
  IF session_row.status='cancelled' THEN RAISE EXCEPTION 'attendance forbidden for cancelled lesson session'; END IF;
  SELECT school_id,student_id,class_id,academic_year_id,status,enrolled_at INTO enrollment_row
    FROM enrollments WHERE school_id=NEW.school_id AND id=NEW.enrollment_id;
  IF NOT FOUND OR enrollment_row.student_id<>NEW.student_id OR enrollment_row.class_id<>session_row.class_id
    OR enrollment_row.academic_year_id<>session_row.academic_year_id OR enrollment_row.status NOT IN ('active','completed')
    OR enrollment_row.enrolled_at>session_row.session_date THEN RAISE EXCEPTION 'student not enrolled for lesson session'; END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_validate_academic_period ON academic_periods;
CREATE TRIGGER trg_validate_academic_period BEFORE INSERT OR UPDATE ON academic_periods FOR EACH ROW EXECUTE FUNCTION validate_m3_attendance_reference();
DROP TRIGGER IF EXISTS trg_validate_attendance_record ON attendance_records;
CREATE TRIGGER trg_validate_attendance_record BEFORE INSERT OR UPDATE ON attendance_records FOR EACH ROW EXECUTE FUNCTION validate_m3_attendance_reference();

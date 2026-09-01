-- M2 — Emplois du temps et séances pédagogiques.
-- Migration additive, idempotente et compatible avec la fondation M1.

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_school_id_id ON users(school_id,id);

CREATE TABLE IF NOT EXISTS subjects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  name text NOT NULL,
  code text,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(school_id,id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_subjects_school_name ON subjects(school_id,lower(name));
CREATE UNIQUE INDEX IF NOT EXISTS idx_subjects_school_code ON subjects(school_id,lower(code)) WHERE code IS NOT NULL;

CREATE TABLE IF NOT EXISTS rooms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  name text NOT NULL,
  code text,
  capacity integer CHECK(capacity IS NULL OR capacity>0),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(school_id,id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_rooms_school_name ON rooms(school_id,lower(name));
CREATE UNIQUE INDEX IF NOT EXISTS idx_rooms_school_code ON rooms(school_id,lower(code)) WHERE code IS NOT NULL;

CREATE TABLE IF NOT EXISTS teaching_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  academic_year_id uuid NOT NULL,
  teacher_id uuid NOT NULL,
  class_id uuid NOT NULL,
  subject_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','inactive')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(school_id,id),
  UNIQUE(school_id,id,academic_year_id),
  UNIQUE(school_id,academic_year_id,teacher_id,class_id,subject_id),
  CONSTRAINT teaching_assignments_school_year_fkey FOREIGN KEY(school_id,academic_year_id) REFERENCES academic_years(school_id,id) ON DELETE RESTRICT,
  CONSTRAINT teaching_assignments_school_teacher_fkey FOREIGN KEY(school_id,teacher_id) REFERENCES users(school_id,id) ON DELETE RESTRICT,
  CONSTRAINT teaching_assignments_school_class_year_fkey FOREIGN KEY(school_id,class_id,academic_year_id) REFERENCES classes(school_id,id,academic_year_id) ON DELETE RESTRICT,
  CONSTRAINT teaching_assignments_school_subject_fkey FOREIGN KEY(school_id,subject_id) REFERENCES subjects(school_id,id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_teaching_assignments_teacher ON teaching_assignments(school_id,academic_year_id,teacher_id,status);
CREATE INDEX IF NOT EXISTS idx_teaching_assignments_class ON teaching_assignments(school_id,academic_year_id,class_id,status);

CREATE TABLE IF NOT EXISTS timetable_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  academic_year_id uuid NOT NULL,
  teaching_assignment_id uuid NOT NULL,
  room_id uuid,
  weekday smallint NOT NULL CHECK(weekday BETWEEN 1 AND 7),
  start_time time NOT NULL,
  end_time time NOT NULL,
  effective_from date NOT NULL,
  effective_to date,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK(start_time<end_time),
  CHECK(effective_to IS NULL OR effective_from<=effective_to),
  UNIQUE(school_id,id),
  UNIQUE(school_id,id,academic_year_id),
  CONSTRAINT timetable_entries_school_year_fkey FOREIGN KEY(school_id,academic_year_id) REFERENCES academic_years(school_id,id) ON DELETE RESTRICT,
  CONSTRAINT timetable_entries_school_assignment_year_fkey FOREIGN KEY(school_id,teaching_assignment_id,academic_year_id) REFERENCES teaching_assignments(school_id,id,academic_year_id) ON DELETE RESTRICT,
  CONSTRAINT timetable_entries_school_room_fkey FOREIGN KEY(school_id,room_id) REFERENCES rooms(school_id,id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_timetable_entries_week ON timetable_entries(school_id,academic_year_id,weekday,start_time,end_time) WHERE active=true;

CREATE TABLE IF NOT EXISTS lesson_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  academic_year_id uuid NOT NULL,
  timetable_entry_id uuid,
  teaching_assignment_id uuid NOT NULL,
  room_id uuid,
  session_date date NOT NULL,
  start_time time NOT NULL,
  end_time time NOT NULL,
  status text NOT NULL DEFAULT 'scheduled' CHECK(status IN ('scheduled','completed','cancelled','rescheduled')),
  title text,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK(start_time<end_time),
  UNIQUE(school_id,id),
  CONSTRAINT lesson_sessions_school_year_fkey FOREIGN KEY(school_id,academic_year_id) REFERENCES academic_years(school_id,id) ON DELETE RESTRICT,
  CONSTRAINT lesson_sessions_school_entry_year_fkey FOREIGN KEY(school_id,timetable_entry_id,academic_year_id) REFERENCES timetable_entries(school_id,id,academic_year_id) ON DELETE RESTRICT,
  CONSTRAINT lesson_sessions_school_assignment_year_fkey FOREIGN KEY(school_id,teaching_assignment_id,academic_year_id) REFERENCES teaching_assignments(school_id,id,academic_year_id) ON DELETE RESTRICT,
  CONSTRAINT lesson_sessions_school_room_fkey FOREIGN KEY(school_id,room_id) REFERENCES rooms(school_id,id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_lesson_sessions_entry_date ON lesson_sessions(school_id,timetable_entry_id,session_date) WHERE timetable_entry_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_lesson_sessions_calendar ON lesson_sessions(school_id,academic_year_id,session_date,start_time) WHERE status<>'cancelled';

CREATE OR REPLACE FUNCTION validate_m2_academic_reference() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE year_start date; year_end date; teacher_role text;
BEGIN
  SELECT starts_on,ends_on INTO year_start,year_end FROM academic_years WHERE school_id=NEW.school_id AND id=NEW.academic_year_id;
  IF TG_TABLE_NAME='teaching_assignments' THEN
    SELECT role INTO teacher_role FROM users WHERE school_id=NEW.school_id AND id=NEW.teacher_id;
    IF teacher_role IS DISTINCT FROM 'teacher' THEN RAISE EXCEPTION 'teaching assignment requires a teacher'; END IF;
  ELSIF TG_TABLE_NAME='timetable_entries' THEN
    IF NEW.effective_from<year_start OR COALESCE(NEW.effective_to,year_end)>year_end THEN RAISE EXCEPTION 'timetable dates outside academic year'; END IF;
  ELSIF TG_TABLE_NAME='lesson_sessions' THEN
    IF NEW.session_date<year_start OR NEW.session_date>year_end THEN RAISE EXCEPTION 'lesson session outside academic year'; END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_validate_teaching_assignment ON teaching_assignments;
CREATE TRIGGER trg_validate_teaching_assignment BEFORE INSERT OR UPDATE ON teaching_assignments FOR EACH ROW EXECUTE FUNCTION validate_m2_academic_reference();
DROP TRIGGER IF EXISTS trg_validate_timetable_entry ON timetable_entries;
CREATE TRIGGER trg_validate_timetable_entry BEFORE INSERT OR UPDATE ON timetable_entries FOR EACH ROW EXECUTE FUNCTION validate_m2_academic_reference();
DROP TRIGGER IF EXISTS trg_validate_lesson_session ON lesson_sessions;
CREATE TRIGGER trg_validate_lesson_session BEFORE INSERT OR UPDATE ON lesson_sessions FOR EACH ROW EXECUTE FUNCTION validate_m2_academic_reference();


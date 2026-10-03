-- Keep the real actor ID for super-admin actions in an explicit school context.
-- School-domain foreign keys remain unchanged; only actor references gain the
-- same platform-admin exception already enforced by the HTTP authorization layer.
CREATE OR REPLACE FUNCTION validate_school_actor() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE actor_id uuid;
BEGIN
  actor_id := (to_jsonb(NEW)->>TG_ARGV[0])::uuid;
  IF actor_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM users WHERE id=actor_id AND (school_id=NEW.school_id OR is_platform_admin=true)
  ) THEN RAISE EXCEPTION 'invalid school actor' USING ERRCODE='23503'; END IF;
  RETURN NEW;
END $$;

DO $$
DECLARE actor record; reference_name text; trigger_name text;
BEGIN
  FOR actor IN SELECT * FROM (VALUES
    ('attendance_justification_documents','uploaded_by','attendance_documents_school_uploader_fkey'),
    ('attendance_records','marked_by','attendance_records_school_marker_fkey'),
    ('attendance_records','updated_by','attendance_records_school_updater_fkey'),
    ('attendance_record_events','changed_by','attendance_events_school_user_fkey'),
    ('grading_settings','updated_by','grading_settings_school_updater_fkey'),
    ('assessments','created_by','assessments_school_creator_fkey'),
    ('assessments','updated_by','assessments_school_updater_fkey'),
    ('assessments','published_by','assessments_school_publisher_fkey'),
    ('assessments','locked_by','assessments_school_locker_fkey'),
    ('grades','entered_by','grades_school_entered_by_fkey'),
    ('grades','updated_by','grades_school_updated_by_fkey'),
    ('grade_events','changed_by','grade_events_school_user_fkey'),
    ('grading_policy_versions','changed_by','grading_policy_versions_actor_fkey'),
    ('subject_coefficient_versions','changed_by','subject_coefficient_versions_actor_fkey'),
    ('assessment_publication_snapshots','published_by','publication_snapshot_publisher_fkey'),
    ('grade_versions','changed_by','grade_versions_actor_fkey'),
    ('assessment_events','changed_by','assessment_events_actor_fkey')
  ) AS actors(table_name,column_name,old_constraint)
  LOOP
    -- Keep the historical name so older schema files do not recreate the
    -- composite constraint on the next cold start.
    reference_name := actor.old_constraint;
    trigger_name := 'trg_actor_' || actor.column_name;
    IF EXISTS(SELECT 1 FROM pg_constraint WHERE conname=reference_name AND conrelid=to_regclass(actor.table_name) AND cardinality(conkey)>1) THEN
      EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I',actor.table_name,reference_name);
    END IF;
    IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname=reference_name AND conrelid=to_regclass(actor.table_name)) THEN
      EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY(%I) REFERENCES users(id) ON DELETE RESTRICT',actor.table_name,reference_name,actor.column_name);
    END IF;
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I',trigger_name,actor.table_name);
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION validate_school_actor(%L)',trigger_name,actor.table_name,actor.column_name);
  END LOOP;
END $$;

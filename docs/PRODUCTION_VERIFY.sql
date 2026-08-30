\set ON_ERROR_STOP on

SELECT
  (SELECT count(*) FROM schools) AS school_count,
  (SELECT count(*) FROM users) AS user_count,
  EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'users'
      AND column_name = 'is_platform_admin'
  ) AS platform_admin_column,
  (
    SELECT count(*)
    FROM users AS candidate
    WHERE COALESCE((to_jsonb(candidate) ->> 'is_platform_admin')::boolean, false)
  ) AS platform_admin_count;

SELECT
  to_regclass('public.sessions') IS NOT NULL AS sessions_table,
  to_regclass('public.login_attempts') IS NOT NULL AS login_attempts_table;

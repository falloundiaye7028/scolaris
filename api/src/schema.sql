CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE TABLE IF NOT EXISTS schools (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL,
  slug text UNIQUE NOT NULL, currency char(3) NOT NULL DEFAULT 'XOF',
  locale text NOT NULL DEFAULT 'fr-SN', created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE schools ADD COLUMN IF NOT EXISTS subscription_status text NOT NULL DEFAULT 'active';
ALTER TABLE schools ADD COLUMN IF NOT EXISTS subscription_due_date date;
ALTER TABLE schools ADD COLUMN IF NOT EXISTS suspended_at timestamptz;
ALTER TABLE schools ADD COLUMN IF NOT EXISTS deletion_requested_at timestamptz;
ALTER TABLE schools ADD COLUMN IF NOT EXISTS school_type text;
ALTER TABLE schools ADD COLUMN IF NOT EXISTS country text;
ALTER TABLE schools ADD COLUMN IF NOT EXISTS city text;
ALTER TABLE schools ADD COLUMN IF NOT EXISTS address text;
ALTER TABLE schools ADD COLUMN IF NOT EXISTS phone text;
ALTER TABLE schools ADD COLUMN IF NOT EXISTS professional_email text;
ALTER TABLE schools ADD COLUMN IF NOT EXISTS approximate_student_count integer;
ALTER TABLE schools ADD COLUMN IF NOT EXISTS ninea text;
ALTER TABLE schools ADD COLUMN IF NOT EXISTS rccm text;
ALTER TABLE schools ADD COLUMN IF NOT EXISTS representative_title text;
ALTER TABLE schools ADD COLUMN IF NOT EXISTS representative_phone text;
ALTER TABLE schools ADD COLUMN IF NOT EXISTS terms_accepted_at timestamptz;
ALTER TABLE schools ADD COLUMN IF NOT EXISTS privacy_acknowledged_at timestamptz;
ALTER TABLE schools ADD COLUMN IF NOT EXISTS representation_confirmed_at timestamptz;
ALTER TABLE schools ADD COLUMN IF NOT EXISTS email_verified_at timestamptz;
ALTER TABLE schools ADD COLUMN IF NOT EXISTS reviewed_at timestamptz;
ALTER TABLE schools ADD COLUMN IF NOT EXISTS reviewed_by uuid;
ALTER TABLE schools ADD COLUMN IF NOT EXISTS rejection_reason text;
CREATE UNIQUE INDEX IF NOT EXISTS idx_schools_professional_email ON schools(lower(professional_email)) WHERE professional_email IS NOT NULL;
CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  name text NOT NULL, email text UNIQUE NOT NULL, password_hash text NOT NULL,
  role text NOT NULL CHECK(role IN ('owner','director','accountant','teacher')), created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_platform_admin boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true;
ALTER TABLE users ADD COLUMN IF NOT EXISTS disabled_at timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_changed_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at timestamptz;
CREATE TABLE IF NOT EXISTS sessions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  ip_hash text,
  user_agent_hash text,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS token_hash text;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS absolute_expires_at timestamptz;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS reauthenticated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS auth_method text NOT NULL DEFAULT 'password';
UPDATE sessions SET absolute_expires_at=expires_at WHERE absolute_expires_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_token_hash ON sessions(token_hash) WHERE token_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sessions_user_active ON sessions(user_id,expires_at) WHERE revoked_at IS NULL;
CREATE TABLE IF NOT EXISTS login_attempts (
  attempt_key text PRIMARY KEY,
  attempts integer NOT NULL DEFAULT 0,
  first_attempt_at timestamptz NOT NULL DEFAULT now(),
  locked_until timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  requested_ip_hash text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_password_reset_user ON password_reset_tokens(user_id,expires_at DESC);
CREATE TABLE IF NOT EXISTS user_mfa (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  secret_ciphertext text NOT NULL,
  enabled_at timestamptz,
  verified_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS mfa_recovery_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash text NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id,code_hash)
);
CREATE TABLE IF NOT EXISTS mfa_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  challenge_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS security_events (
  id bigserial PRIMARY KEY,
  school_id uuid,
  user_id uuid,
  event_type text NOT NULL,
  severity text NOT NULL CHECK(severity IN ('info','warning','critical')),
  outcome text NOT NULL,
  ip_hash text,
  user_agent_hash text,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_security_events_type_date ON security_events(event_type,created_at DESC);
CREATE TABLE IF NOT EXISTS import_limits (
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  window_started_at timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 0,
  PRIMARY KEY(school_id,user_id)
);
CREATE TABLE IF NOT EXISTS registration_attempts (
  attempt_key text PRIMARY KEY,
  attempts integer NOT NULL DEFAULT 0,
  window_started_at timestamptz NOT NULL DEFAULT now(),
  blocked_until timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS school_email_confirmations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_school_email_confirmation_school ON school_email_confirmations(school_id,created_at DESC);
CREATE TABLE IF NOT EXISTS school_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL UNIQUE REFERENCES schools(id) ON DELETE CASCADE,
  monthly_price_xof integer NOT NULL DEFAULT 50000 CHECK(monthly_price_xof=50000),
  billing_cycle text NOT NULL DEFAULT 'monthly' CHECK(billing_cycle='monthly'),
  status text NOT NULL DEFAULT 'pending_payment' CHECK(status IN ('pending_payment','active','grace_period','suspended','cancelled')),
  is_exempt boolean NOT NULL DEFAULT false,
  started_at timestamptz,
  current_period_start timestamptz,
  current_period_end timestamptz,
  paid_until timestamptz,
  grace_period_end timestamptz,
  suspended_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK(current_period_end IS NULL OR current_period_start IS NOT NULL),
  CHECK(paid_until IS NULL OR started_at IS NOT NULL),
  CHECK(grace_period_end IS NULL OR paid_until IS NOT NULL)
);
INSERT INTO school_subscriptions(school_id,status,is_exempt,started_at,current_period_start,current_period_end,paid_until,grace_period_end,suspended_at)
SELECT s.id,
  CASE WHEN s.subscription_status='suspended' THEN 'suspended' ELSE 'active' END,
  EXISTS(SELECT 1 FROM users u WHERE u.school_id=s.id AND u.is_platform_admin=true),
  s.created_at,
  date_trunc('day',s.created_at),
  COALESCE(s.subscription_due_date::timestamptz + interval '1 day' - interval '1 second',now()+interval '30 days'),
  COALESCE(s.subscription_due_date::timestamptz + interval '1 day' - interval '1 second',now()+interval '30 days'),
  COALESCE(s.subscription_due_date::timestamptz + interval '8 days' - interval '1 second',now()+interval '37 days'),
  s.suspended_at
FROM schools s
ON CONFLICT(school_id) DO NOTHING;
CREATE TABLE IF NOT EXISTS subscription_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  amount_minor bigint NOT NULL CHECK(amount_minor > 0), currency char(3) NOT NULL DEFAULT 'XOF',
  method text NOT NULL, reference text NOT NULL, paid_at timestamptz NOT NULL DEFAULT now(),
  coverage_end date NOT NULL, notes text, recorded_by uuid REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(school_id,reference)
);
CREATE INDEX IF NOT EXISTS idx_subscription_payments_date ON subscription_payments(paid_at DESC);
CREATE TABLE IF NOT EXISTS platform_payment_proofs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  content_type text NOT NULL CHECK(content_type IN ('application/pdf','image/png','image/jpeg')),
  original_name text NOT NULL,
  size_bytes integer NOT NULL CHECK(size_bytes>0 AND size_bytes<=2097152),
  sha256 text NOT NULL,
  content bytea NOT NULL,
  uploaded_by_user_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS platform_subscription_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE RESTRICT,
  subscription_id uuid NOT NULL REFERENCES school_subscriptions(id) ON DELETE RESTRICT,
  amount_expected_xof integer NOT NULL CHECK(amount_expected_xof=50000),
  amount_received_xof integer NOT NULL CHECK(amount_received_xof>0),
  payment_method text NOT NULL CHECK(payment_method IN ('cash','wave','orange_money','bank_transfer','cheque','other')),
  external_reference text,
  receipt_number text NOT NULL UNIQUE,
  payment_period_start timestamptz NOT NULL,
  payment_period_end timestamptz NOT NULL,
  paid_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  recorded_by_user_id uuid NOT NULL REFERENCES users(id),
  status text NOT NULL DEFAULT 'confirmed' CHECK(status IN ('confirmed','cancelled')),
  notes text,
  proof_file_id uuid REFERENCES platform_payment_proofs(id),
  cancelled_at timestamptz,
  cancelled_by_user_id uuid REFERENCES users(id),
  cancellation_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK(payment_period_end>payment_period_start),
  CHECK((status='confirmed' AND cancelled_at IS NULL AND cancelled_by_user_id IS NULL AND cancellation_reason IS NULL) OR
        (status='cancelled' AND cancelled_at IS NOT NULL AND cancelled_by_user_id IS NOT NULL AND cancellation_reason IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_platform_subscription_reference ON platform_subscription_payments(school_id,external_reference) WHERE external_reference IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_platform_subscription_payment_school ON platform_subscription_payments(school_id,paid_at DESC);
CREATE TABLE IF NOT EXISTS subscription_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  event_type text NOT NULL CHECK(event_type IN ('expiry_reminder','suspension_warning')),
  period_end timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(school_id,event_type,period_end)
);
INSERT INTO platform_subscription_payments(id,school_id,subscription_id,amount_expected_xof,amount_received_xof,payment_method,external_reference,receipt_number,payment_period_start,payment_period_end,paid_at,recorded_at,recorded_by_user_id,status,notes,created_at,updated_at)
SELECT p.id,p.school_id,ss.id,50000,GREATEST(1,(p.amount_minor/100)::integer),
  CASE p.method WHEN 'Espèces' THEN 'cash' WHEN 'Wave' THEN 'wave' WHEN 'Orange Money' THEN 'orange_money' WHEN 'Virement' THEN 'bank_transfer' WHEN 'Chèque' THEN 'cheque' ELSE 'other' END,
  p.reference,'ABN-LEGACY-'||upper(substr(replace(p.id::text,'-',''),1,16)),
  date_trunc('day',p.paid_at),p.coverage_end::timestamptz + interval '1 day' - interval '1 second',p.paid_at,p.created_at,p.recorded_by,'confirmed',p.notes,p.created_at,p.created_at
FROM subscription_payments p JOIN school_subscriptions ss ON ss.school_id=p.school_id
WHERE p.recorded_by IS NOT NULL
ON CONFLICT(id) DO NOTHING;
CREATE TABLE IF NOT EXISTS students (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  matricule text NOT NULL, first_name text NOT NULL, last_name text NOT NULL, class_name text,
  guardian_name text, guardian_phone text, status text NOT NULL DEFAULT 'active', created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(school_id,matricule)
);
CREATE TABLE IF NOT EXISTS school_counters (
  school_id uuid PRIMARY KEY REFERENCES schools(id) ON DELETE CASCADE,
  student_next bigint NOT NULL DEFAULT 1 CHECK(student_next > 0)
);
CREATE TABLE IF NOT EXISTS academic_years (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  label text NOT NULL, starts_on date NOT NULL, ends_on date NOT NULL, is_current boolean NOT NULL DEFAULT false,
  UNIQUE(school_id,label), CHECK(ends_on > starts_on)
);
CREATE TABLE IF NOT EXISTS classes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  academic_year_id uuid NOT NULL REFERENCES academic_years(id) ON DELETE CASCADE,
  name text NOT NULL, level text, capacity integer CHECK(capacity IS NULL OR capacity > 0), UNIQUE(school_id,academic_year_id,name)
);
CREATE TABLE IF NOT EXISTS guardians (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  full_name text NOT NULL, phone text, email text, preferred_language text NOT NULL DEFAULT 'fr', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS student_guardians (
  student_id uuid NOT NULL REFERENCES students(id) ON DELETE CASCADE, guardian_id uuid NOT NULL REFERENCES guardians(id) ON DELETE CASCADE,
  relationship text NOT NULL, is_primary boolean NOT NULL DEFAULT false, PRIMARY KEY(student_id,guardian_id)
);
CREATE TABLE IF NOT EXISTS enrollments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  student_id uuid NOT NULL REFERENCES students(id) ON DELETE CASCADE, class_id uuid NOT NULL REFERENCES classes(id),
  academic_year_id uuid NOT NULL REFERENCES academic_years(id), status text NOT NULL DEFAULT 'active', enrolled_at date NOT NULL DEFAULT CURRENT_DATE,
  UNIQUE(student_id,academic_year_id)
);
CREATE TABLE IF NOT EXISTS invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  student_id uuid NOT NULL REFERENCES students(id) ON DELETE CASCADE, label text NOT NULL,
  amount_minor bigint NOT NULL CHECK(amount_minor >= 0), currency char(3) NOT NULL, due_date date NOT NULL,
  status text NOT NULL DEFAULT 'unpaid' CHECK(status IN ('unpaid','partial','paid','cancelled')), created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS fee_type text NOT NULL DEFAULT 'other';
CREATE TABLE IF NOT EXISTS payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  student_id uuid NOT NULL REFERENCES students(id), invoice_id uuid REFERENCES invoices(id),
  amount_minor bigint NOT NULL CHECK(amount_minor > 0), currency char(3) NOT NULL,
  method text NOT NULL, reference text NOT NULL, paid_at timestamptz NOT NULL DEFAULT now(), UNIQUE(school_id,reference)
);
CREATE OR REPLACE VIEW student_fee_payments AS
SELECT id,school_id,student_id,invoice_id,amount_minor,currency,method,reference,paid_at FROM payments;
CREATE TABLE IF NOT EXISTS receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  payment_id uuid NOT NULL UNIQUE REFERENCES payments(id), number text NOT NULL,
  issued_at timestamptz NOT NULL DEFAULT now(), UNIQUE(school_id,number)
);
CREATE TABLE IF NOT EXISTS reminders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  guardian_id uuid NOT NULL REFERENCES guardians(id), invoice_id uuid NOT NULL REFERENCES invoices(id),
  channel text NOT NULL CHECK(channel IN ('email','sms','whatsapp')), message text NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','sent','failed','cancelled')),
  scheduled_at timestamptz NOT NULL DEFAULT now(), sent_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_reminders_queue ON reminders(status,scheduled_at);
CREATE TABLE IF NOT EXISTS parent_portal_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  guardian_id uuid NOT NULL REFERENCES guardians(id) ON DELETE CASCADE, token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL, revoked_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS audit_logs (
  id bigserial PRIMARY KEY, school_id uuid NOT NULL, user_id uuid, action text NOT NULL,
  entity text NOT NULL, entity_id text, metadata jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_students_school ON students(school_id);
CREATE INDEX IF NOT EXISTS idx_guardians_school ON guardians(school_id);
CREATE INDEX IF NOT EXISTS idx_enrollments_school ON enrollments(school_id,academic_year_id);
CREATE INDEX IF NOT EXISTS idx_invoices_school_status ON invoices(school_id,status);
CREATE INDEX IF NOT EXISTS idx_payments_school_date ON payments(school_id,paid_at DESC);

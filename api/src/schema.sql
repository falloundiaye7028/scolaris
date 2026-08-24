CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE TABLE IF NOT EXISTS schools (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL,
  slug text UNIQUE NOT NULL, currency char(3) NOT NULL DEFAULT 'XOF',
  locale text NOT NULL DEFAULT 'fr-SN', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  name text NOT NULL, email text UNIQUE NOT NULL, password_hash text NOT NULL,
  role text NOT NULL CHECK(role IN ('owner','director','accountant','teacher')), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS students (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  matricule text NOT NULL, first_name text NOT NULL, last_name text NOT NULL, class_name text,
  guardian_name text, guardian_phone text, status text NOT NULL DEFAULT 'active', created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(school_id,matricule)
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
CREATE TABLE IF NOT EXISTS payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  student_id uuid NOT NULL REFERENCES students(id), invoice_id uuid REFERENCES invoices(id),
  amount_minor bigint NOT NULL CHECK(amount_minor > 0), currency char(3) NOT NULL,
  method text NOT NULL, reference text NOT NULL, paid_at timestamptz NOT NULL DEFAULT now(), UNIQUE(school_id,reference)
);
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
CREATE TABLE IF NOT EXISTS audit_logs (
  id bigserial PRIMARY KEY, school_id uuid NOT NULL, user_id uuid, action text NOT NULL,
  entity text NOT NULL, entity_id text, metadata jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_students_school ON students(school_id);
CREATE INDEX IF NOT EXISTS idx_guardians_school ON guardians(school_id);
CREATE INDEX IF NOT EXISTS idx_enrollments_school ON enrollments(school_id,academic_year_id);
CREATE INDEX IF NOT EXISTS idx_invoices_school_status ON invoices(school_id,status);
CREATE INDEX IF NOT EXISTS idx_payments_school_date ON payments(school_id,paid_at DESC);

-- Migration additive des frais scolaires. Les montants métier sont des entiers XOF.
CREATE TABLE IF NOT EXISTS fee_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid REFERENCES schools(id) ON DELETE CASCADE,
  code text NOT NULL,
  name text NOT NULL,
  system_fee_type text CHECK(system_fee_type IS NULL OR system_fee_type IN ('tuition','registration','uniform','transport','other')),
  is_system boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK((is_system AND school_id IS NULL AND system_fee_type IS NOT NULL) OR (NOT is_system AND school_id IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_fee_categories_system_code ON fee_categories(code) WHERE is_system=true;
CREATE UNIQUE INDEX IF NOT EXISTS idx_fee_categories_school_code ON fee_categories(school_id,code) WHERE is_system=false;
INSERT INTO fee_categories(id,code,name,system_fee_type,is_system)
VALUES
  ('00000000-0000-4000-8000-000000000001','tuition','Mensualité','tuition',true),
  ('00000000-0000-4000-8000-000000000002','registration','Frais d’inscription','registration',true),
  ('00000000-0000-4000-8000-000000000003','uniform','Tenue scolaire','uniform',true),
  ('00000000-0000-4000-8000-000000000004','transport','Transport','transport',true),
  ('00000000-0000-4000-8000-000000000005','other','Autre','other',true)
ON CONFLICT(id) DO UPDATE SET name=excluded.name,system_fee_type=excluded.system_fee_type,is_active=true,updated_at=now();

CREATE TABLE IF NOT EXISTS fee_definitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  academic_year_id uuid NOT NULL REFERENCES academic_years(id) ON DELETE RESTRICT,
  category_id uuid NOT NULL REFERENCES fee_categories(id) ON DELETE RESTRICT,
  name text NOT NULL,
  fee_type text NOT NULL CHECK(fee_type IN ('tuition','registration','uniform','transport','other')),
  amount_xof bigint NOT NULL CHECK(amount_xof>0),
  class_id uuid REFERENCES classes(id) ON DELETE RESTRICT,
  is_mandatory boolean NOT NULL DEFAULT true,
  is_active boolean NOT NULL DEFAULT true,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_fee_definitions_identity ON fee_definitions(school_id,academic_year_id,fee_type,lower(name),COALESCE(class_id,'00000000-0000-0000-0000-000000000000'::uuid));
CREATE INDEX IF NOT EXISTS idx_fee_definitions_school_year ON fee_definitions(school_id,academic_year_id,fee_type);

ALTER TABLE invoices ADD COLUMN IF NOT EXISTS fee_definition_id uuid REFERENCES fee_definitions(id) ON DELETE RESTRICT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS academic_year_id uuid REFERENCES academic_years(id) ON DELETE RESTRICT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS class_id uuid REFERENCES classes(id) ON DELETE RESTRICT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS description text;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS amount_expected_xof bigint NOT NULL DEFAULT 0;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS discount_xof bigint NOT NULL DEFAULT 0;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS amount_due_xof bigint NOT NULL DEFAULT 0;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS amount_paid_xof bigint NOT NULL DEFAULT 0;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS balance_xof bigint NOT NULL DEFAULT 0;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS financial_status text NOT NULL DEFAULT 'unpaid';
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS is_mandatory boolean NOT NULL DEFAULT true;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS exemption_reason text;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS cancelled_at timestamptz;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS cancelled_by uuid REFERENCES users(id);
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS cancellation_reason text;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES users(id);
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
UPDATE invoices
SET amount_expected_xof=CASE WHEN trim(currency)='XOF' THEN (amount_minor/100)::bigint ELSE amount_expected_xof END,
    amount_due_xof=CASE WHEN trim(currency)='XOF' THEN (amount_minor/100)::bigint ELSE amount_due_xof END,
    balance_xof=CASE WHEN trim(currency)='XOF' THEN (amount_minor/100)::bigint ELSE balance_xof END,
    financial_status=CASE status WHEN 'partial' THEN 'partially_paid' ELSE status END,
    description=COALESCE(description,label)
WHERE amount_expected_xof=0;
UPDATE invoices i SET academic_year_id=e.academic_year_id,class_id=e.class_id
FROM enrollments e WHERE e.student_id=i.student_id AND e.school_id=i.school_id AND e.status='active' AND i.academic_year_id IS NULL;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='invoices_financial_status_check') THEN
    ALTER TABLE invoices ADD CONSTRAINT invoices_financial_status_check CHECK(financial_status IN ('unpaid','partially_paid','paid','cancelled','exempted'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='invoices_xof_amounts_check') THEN
    ALTER TABLE invoices ADD CONSTRAINT invoices_xof_amounts_check CHECK(amount_expected_xof>=0 AND discount_xof>=0 AND amount_due_xof>=0 AND amount_paid_xof>=0 AND balance_xof>=0 AND discount_xof<=amount_expected_xof);
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS idx_registration_once_per_year ON invoices(school_id,student_id,academic_year_id) WHERE fee_type='registration' AND academic_year_id IS NOT NULL AND fee_definition_id IS NOT NULL AND financial_status<>'cancelled';
CREATE UNIQUE INDEX IF NOT EXISTS idx_fee_assignment_definition_student ON invoices(school_id,student_id,fee_definition_id) WHERE fee_definition_id IS NOT NULL AND financial_status<>'cancelled';
CREATE INDEX IF NOT EXISTS idx_invoices_fee_filters ON invoices(school_id,academic_year_id,class_id,fee_type,financial_status,due_date);

CREATE TABLE IF NOT EXISTS uniform_fee_items (
  invoice_id uuid PRIMARY KEY REFERENCES invoices(id) ON DELETE RESTRICT,
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  item_type text,
  size text,
  quantity integer NOT NULL DEFAULT 1 CHECK(quantity>0),
  unit_price_xof bigint CHECK(unit_price_xof IS NULL OR unit_price_xof>=0),
  total_amount_xof bigint CHECK(total_amount_xof IS NULL OR total_amount_xof>=0),
  delivery_status text NOT NULL DEFAULT 'to_prepare' CHECK(delivery_status IN ('not_applicable','to_prepare','available','delivered')),
  delivered_at timestamptz,
  delivered_by uuid REFERENCES users(id),
  delivery_note text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK((delivery_status='delivered' AND delivered_at IS NOT NULL AND delivered_by IS NOT NULL) OR delivery_status<>'delivered')
);
CREATE INDEX IF NOT EXISTS idx_uniform_items_delivery ON uniform_fee_items(school_id,delivery_status,item_type,size);

CREATE TABLE IF NOT EXISTS uniform_delivery_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  invoice_id uuid NOT NULL REFERENCES invoices(id) ON DELETE RESTRICT,
  previous_status text NOT NULL CHECK(previous_status IN ('not_applicable','to_prepare','available','delivered')),
  new_status text NOT NULL CHECK(new_status IN ('not_applicable','to_prepare','available','delivered')),
  note text,
  changed_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_uniform_delivery_events_invoice ON uniform_delivery_events(school_id,invoice_id,created_at DESC);

CREATE TABLE IF NOT EXISTS fee_adjustments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  invoice_id uuid NOT NULL REFERENCES invoices(id) ON DELETE RESTRICT,
  adjustment_type text NOT NULL CHECK(adjustment_type IN ('discount','exemption','cancellation')),
  original_amount_expected_xof bigint NOT NULL,
  previous_discount_xof bigint NOT NULL,
  adjustment_xof bigint NOT NULL DEFAULT 0,
  reason text NOT NULL,
  authorized_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_fee_adjustments_invoice ON fee_adjustments(school_id,invoice_id,created_at DESC);

CREATE TABLE IF NOT EXISTS student_payment_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE RESTRICT,
  student_id uuid NOT NULL REFERENCES students(id) ON DELETE RESTRICT,
  total_amount_xof bigint NOT NULL CHECK(total_amount_xof>0),
  currency char(3) NOT NULL DEFAULT 'XOF' CHECK(currency='XOF'),
  method text NOT NULL,
  reference text NOT NULL,
  paid_at timestamptz NOT NULL DEFAULT now(),
  recorded_by uuid NOT NULL REFERENCES users(id),
  status text NOT NULL DEFAULT 'confirmed' CHECK(status IN ('confirmed','cancelled')),
  cancelled_at timestamptz,
  cancelled_by uuid REFERENCES users(id),
  cancellation_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(school_id,reference),
  CHECK((status='confirmed' AND cancelled_at IS NULL AND cancelled_by IS NULL AND cancellation_reason IS NULL) OR (status='cancelled' AND cancelled_at IS NOT NULL AND cancelled_by IS NOT NULL AND cancellation_reason IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS student_payment_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE RESTRICT,
  payment_batch_id uuid NOT NULL REFERENCES student_payment_batches(id) ON DELETE RESTRICT,
  invoice_id uuid NOT NULL REFERENCES invoices(id) ON DELETE RESTRICT,
  amount_xof bigint NOT NULL CHECK(amount_xof>0),
  amount_expected_xof_snapshot bigint CHECK(amount_expected_xof_snapshot IS NULL OR amount_expected_xof_snapshot>=0),
  total_paid_after_xof bigint CHECK(total_paid_after_xof IS NULL OR total_paid_after_xof>=0),
  balance_after_xof bigint CHECK(balance_after_xof IS NULL OR balance_after_xof>=0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(payment_batch_id,invoice_id)
);
ALTER TABLE student_payment_allocations ADD COLUMN IF NOT EXISTS amount_expected_xof_snapshot bigint CHECK(amount_expected_xof_snapshot IS NULL OR amount_expected_xof_snapshot>=0);
ALTER TABLE student_payment_allocations ADD COLUMN IF NOT EXISTS total_paid_after_xof bigint CHECK(total_paid_after_xof IS NULL OR total_paid_after_xof>=0);
ALTER TABLE student_payment_allocations ADD COLUMN IF NOT EXISTS balance_after_xof bigint CHECK(balance_after_xof IS NULL OR balance_after_xof>=0);
CREATE INDEX IF NOT EXISTS idx_student_payment_allocations_invoice ON student_payment_allocations(school_id,invoice_id);
ALTER TABLE payments ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'confirmed';
ALTER TABLE payments ADD COLUMN IF NOT EXISTS recorded_by uuid REFERENCES users(id);
ALTER TABLE payments ADD COLUMN IF NOT EXISTS cancelled_at timestamptz;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS cancelled_by uuid REFERENCES users(id);
ALTER TABLE payments ADD COLUMN IF NOT EXISTS cancellation_reason text;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='payments_status_check') THEN
    ALTER TABLE payments ADD CONSTRAINT payments_status_check CHECK(status IN ('confirmed','cancelled'));
  END IF;
END $$;
ALTER TABLE receipts ALTER COLUMN payment_id DROP NOT NULL;
ALTER TABLE receipts ADD COLUMN IF NOT EXISTS payment_batch_id uuid REFERENCES student_payment_batches(id) ON DELETE RESTRICT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_receipts_payment_batch ON receipts(payment_batch_id) WHERE payment_batch_id IS NOT NULL;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='receipts_payment_source_check') THEN
    ALTER TABLE receipts ADD CONSTRAINT receipts_payment_source_check CHECK((payment_id IS NOT NULL)::integer+(payment_batch_id IS NOT NULL)::integer=1);
  END IF;
END $$;

CREATE OR REPLACE VIEW student_fee_payments AS
SELECT p.id,p.school_id,p.student_id,p.invoice_id,p.amount_minor,p.currency,p.method,p.reference,p.paid_at
FROM payments p
WHERE p.status='confirmed'
UNION ALL
SELECT a.id,b.school_id,b.student_id,a.invoice_id,(a.amount_xof::bigint*100) amount_minor,b.currency,b.method,b.reference,b.paid_at
FROM student_payment_allocations a JOIN student_payment_batches b ON b.id=a.payment_batch_id
WHERE b.status='confirmed';

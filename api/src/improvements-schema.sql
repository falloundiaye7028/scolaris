CREATE TABLE IF NOT EXISTS amy_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  title text NOT NULL CHECK(length(title) BETWEEN 1 AND 160),
  content text NOT NULL CHECK(length(content) BETWEEN 1 AND 50000),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(school_id,id)
);
CREATE TABLE IF NOT EXISTS amy_document_chunks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), school_id uuid NOT NULL,
  document_id uuid NOT NULL, position integer NOT NULL,
  content text NOT NULL CHECK(length(content)<=1800),
  search_vector tsvector GENERATED ALWAYS AS (to_tsvector('french',content)) STORED,
  FOREIGN KEY(school_id,document_id) REFERENCES amy_documents(school_id,id) ON DELETE CASCADE,
  UNIQUE(document_id,position)
);
CREATE INDEX IF NOT EXISTS amy_chunks_search ON amy_document_chunks USING gin(search_vector);
CREATE INDEX IF NOT EXISTS amy_documents_school ON amy_documents(school_id,created_at DESC);

ALTER TABLE reminders ADD COLUMN IF NOT EXISTS approved_at timestamptz;
ALTER TABLE reminders ADD COLUMN IF NOT EXISTS approved_by uuid REFERENCES users(id);
ALTER TABLE reminders ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0;
ALTER TABLE reminders ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz;
ALTER TABLE reminders ADD COLUMN IF NOT EXISTS delivery_status text NOT NULL DEFAULT 'unconfirmed';
ALTER TABLE reminders ADD COLUMN IF NOT EXISTS delivered_at timestamptz;
ALTER TABLE reminders ADD COLUMN IF NOT EXISTS provider_id text;
ALTER TABLE reminders ADD COLUMN IF NOT EXISTS provider text;
ALTER TABLE reminders ADD COLUMN IF NOT EXISTS last_error text;
ALTER TABLE reminders ADD COLUMN IF NOT EXISTS idempotency_key uuid;
ALTER TABLE reminders ADD COLUMN IF NOT EXISTS dispatch_started_at timestamptz;
ALTER TABLE reminders ADD COLUMN IF NOT EXISTS first_attempt_at timestamptz;
ALTER TABLE reminders ADD COLUMN IF NOT EXISTS approved_recipient text;
ALTER TABLE reminders ADD COLUMN IF NOT EXISTS delivery_checked_at timestamptz;
CREATE UNIQUE INDEX IF NOT EXISTS reminders_idempotency ON reminders(school_id,idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS reminders_provider_id ON reminders(provider,provider_id) WHERE provider_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS online_checkouts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), school_id uuid NOT NULL REFERENCES schools(id),
  invoice_id uuid NOT NULL, created_by uuid NOT NULL REFERENCES users(id),
  amount_xof bigint NOT NULL CHECK(amount_xof>0),
  status text NOT NULL DEFAULT 'creating' CHECK(status IN ('creating','pending','confirmed','expired','failed','review')),
  provider_session_id text UNIQUE, provider_transaction_id text UNIQUE,
  launch_url text, receipt_number text, failure_code text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(school_id,invoice_id) REFERENCES invoices(school_id,id)
);
CREATE UNIQUE INDEX IF NOT EXISTS online_checkout_open_invoice ON online_checkouts(school_id,invoice_id) WHERE status IN ('creating','pending');
CREATE INDEX IF NOT EXISTS online_checkout_school ON online_checkouts(school_id,created_at DESC);

DO $$
DECLARE actor record;
BEGIN
  FOR actor IN SELECT * FROM (VALUES ('amy_documents','created_by'),('online_checkouts','created_by'),('reminders','approved_by')) AS actors(table_name,column_name)
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I','trg_actor_' || actor.column_name,actor.table_name);
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION validate_school_actor(%L)','trg_actor_' || actor.column_name,actor.table_name,actor.column_name);
  END LOOP;
END $$;

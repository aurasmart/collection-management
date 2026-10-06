"""Foundation schema: Stage 1 data model + tenant isolation (RLS) + token/snapshot guards.

Revision ID: 0001
Revises:
"""

from alembic import op

revision = "0001"
down_revision = None
branch_labels = None
depends_on = None

TENANT_TABLES = [
    "customers",
    "import_batches",
    "import_rows",
    "collections",
    "payment_requests",
    "payments",
    "payment_settings",
    "notifications",
    "audit_events",
]

# Least-privilege grants for the tenant role (no DELETE on financial/audit records).
GRANTS = {
    "employers": "SELECT",
    "customers": "SELECT, INSERT, UPDATE",
    "import_batches": "SELECT, INSERT, UPDATE",
    "import_rows": "SELECT, INSERT, UPDATE, DELETE",
    "collections": "SELECT, INSERT, UPDATE",
    "payment_requests": "SELECT, INSERT, UPDATE",
    "payments": "SELECT, INSERT, UPDATE",
    "payment_settings": "SELECT, INSERT, UPDATE",
    "notifications": "SELECT, INSERT, UPDATE",
    "audit_events": "SELECT, INSERT",
}

UPGRADE_SQL = """
-- ---------------------------------------------------------------- roles & helpers
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_rls') THEN
    CREATE ROLE app_rls NOLOGIN NOBYPASSRLS;
  END IF;
END $$;
GRANT app_rls TO CURRENT_USER;
GRANT USAGE ON SCHEMA public TO app_rls;

CREATE FUNCTION current_employer_id() RETURNS uuid
LANGUAGE sql STABLE AS
$$ SELECT NULLIF(current_setting('app.employer_id', true), '')::uuid $$;
GRANT EXECUTE ON FUNCTION current_employer_id() TO app_rls;

CREATE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql AS
$$ BEGIN NEW.updated_at = now(); RETURN NEW; END $$;

-- ---------------------------------------------------------------- employers (tenant root)
CREATE TABLE employers (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_user_id  uuid NOT NULL UNIQUE,            -- Supabase auth.users.id (no cross-schema FK)
  name          text NOT NULL,
  email         text NOT NULL,
  phone         text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- The only pre-tenant lookup: auth user -> employer. SECURITY DEFINER, not granted to app_rls.
CREATE FUNCTION resolve_employer_id(p_auth_user_id uuid) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS
$$ SELECT id FROM employers WHERE auth_user_id = p_auth_user_id $$;
REVOKE ALL ON FUNCTION resolve_employer_id(uuid) FROM PUBLIC;

-- ---------------------------------------------------------------- customers
CREATE TABLE customers (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employer_id uuid NOT NULL REFERENCES employers(id),
  name        text NOT NULL,
  phone       text,                               -- E.164
  email       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, employer_id)
);
CREATE UNIQUE INDEX customers_employer_phone_uq ON customers (employer_id, phone) WHERE phone IS NOT NULL;
CREATE INDEX customers_employer_name_idx ON customers (employer_id, lower(name));

-- ---------------------------------------------------------------- import_batches (also the job queue, ADR 0003)
CREATE TABLE import_batches (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employer_id       uuid NOT NULL REFERENCES employers(id),
  filename          text NOT NULL,
  file_type         text NOT NULL CHECK (file_type IN ('XLSX','XLS','CSV','DOCX','PDF')),
  file_hash         text NOT NULL,                -- SHA-256 hex
  storage_key       text,
  uploaded_by       uuid NOT NULL,                -- auth user id
  uploaded_at       timestamptz NOT NULL DEFAULT now(),
  status            text NOT NULL DEFAULT 'UPLOADED'
                    CHECK (status IN ('UPLOADED','PROCESSING','READY_FOR_REVIEW','IMPORTED','FAILED','DISCARDED')),
  total_rows        integer,
  ready_rows        integer,
  review_rows       integer,
  error_message     text,
  attempts          integer NOT NULL DEFAULT 0,
  locked_at         timestamptz,
  confirmed_mapping jsonb,
  extraction_method text CHECK (extraction_method IN ('TABLE','TEXT','AI','OCR')),
  imported_at       timestamptz,
  UNIQUE (id, employer_id)
);
CREATE INDEX import_batches_employer_uploaded_idx ON import_batches (employer_id, uploaded_at DESC);
CREATE INDEX import_batches_employer_hash_idx ON import_batches (employer_id, file_hash);
CREATE INDEX import_batches_queue_idx ON import_batches (status, locked_at)
  WHERE status IN ('UPLOADED','PROCESSING');

-- ---------------------------------------------------------------- collections
CREATE TABLE collections (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employer_id     uuid NOT NULL REFERENCES employers(id),
  customer_id     uuid NOT NULL,
  amount_due      numeric(12,2) NOT NULL CHECK (amount_due > 0),   -- immutable original; payments are separate
  due_date        date,
  reference       text,
  description     text,
  import_batch_id uuid,
  status          text NOT NULL DEFAULT 'PENDING'
                  CHECK (status IN ('PENDING','SENT','PAID','CANCELLED')),  -- OVERDUE / PARTIALLY_PAID are derived
  cancelled_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, employer_id),
  FOREIGN KEY (customer_id, employer_id)     REFERENCES customers (id, employer_id),
  FOREIGN KEY (import_batch_id, employer_id) REFERENCES import_batches (id, employer_id)
);
CREATE INDEX collections_employer_status_idx   ON collections (employer_id, status);
CREATE INDEX collections_employer_due_idx      ON collections (employer_id, due_date);
CREATE INDEX collections_employer_customer_idx ON collections (employer_id, customer_id);
CREATE TRIGGER collections_updated_at BEFORE UPDATE ON collections
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------- import_rows (staging)
CREATE TABLE import_rows (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employer_id                 uuid NOT NULL REFERENCES employers(id),
  batch_id                    uuid NOT NULL,
  row_number                  integer NOT NULL,
  raw_data                    jsonb NOT NULL DEFAULT '{}'::jsonb,
  mapped_data                 jsonb NOT NULL DEFAULT '{}'::jsonb,
  original_values             jsonb,
  issues                      jsonb NOT NULL DEFAULT '[]'::jsonb,
  decision                    text NOT NULL DEFAULT 'PENDING' CHECK (decision IN ('PENDING','ACCEPTED','REJECTED')),
  source_method               text NOT NULL DEFAULT 'TABLE' CHECK (source_method IN ('TABLE','TEXT','AI','OCR')),
  requires_review             boolean NOT NULL DEFAULT false,
  ocr_confidence              numeric(4,3) CHECK (ocr_confidence BETWEEN 0 AND 1),
  source_snippet              text,
  duplicate_action            text NOT NULL DEFAULT 'NONE' CHECK (duplicate_action IN ('NONE','SKIP','IMPORT_ANYWAY')),
  duplicate_of_collection_id  uuid,
  duplicate_of_row_id         uuid REFERENCES import_rows(id),
  FOREIGN KEY (batch_id, employer_id) REFERENCES import_batches (id, employer_id) ON DELETE CASCADE,
  FOREIGN KEY (duplicate_of_collection_id, employer_id) REFERENCES collections (id, employer_id),
  -- Server-side OCR rule (Stage 1 R1): OCR rows always require human review.
  CHECK (source_method <> 'OCR' OR requires_review)
);
CREATE UNIQUE INDEX import_rows_batch_row_uq ON import_rows (batch_id, row_number);

-- ---------------------------------------------------------------- payment_requests (immutable snapshot, ADR 0001)
CREATE TABLE payment_requests (
  id                           uuid PRIMARY KEY DEFAULT gen_random_uuid(),   -- client-supplied UUID allowed (idempotency)
  employer_id                  uuid NOT NULL REFERENCES employers(id),
  collection_id                uuid NOT NULL,
  token_hash                   text NOT NULL UNIQUE,
  token_ciphertext             bytea,
  token_key_id                 text,
  status                       text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','REVOKED')),
  supersedes_request_id        uuid,
  created_at                   timestamptz NOT NULL DEFAULT now(),
  revoked_at                   timestamptz,
  revoked_reason               text,
  first_viewed_at              timestamptz,
  last_viewed_at               timestamptz,
  expires_at                   timestamptz,   -- reserved; unused in V1
  snapshot_customer_name       text NOT NULL,
  snapshot_amount_requested    numeric(12,2) NOT NULL CHECK (snapshot_amount_requested > 0),
  snapshot_reference           text,
  snapshot_employer_display_name text NOT NULL,
  snapshot_upi_id              text,
  snapshot_upi_number          text,
  snapshot_qr_storage_key      text,
  snapshot_bank_name           text,
  snapshot_account_name        text,
  snapshot_account_number      text,
  snapshot_ifsc                text,
  snapshot_enabled_methods     jsonb NOT NULL,
  UNIQUE (id, employer_id),
  FOREIGN KEY (collection_id, employer_id) REFERENCES collections (id, employer_id),
  FOREIGN KEY (supersedes_request_id, employer_id) REFERENCES payment_requests (id, employer_id),
  -- Encrypted token exists exactly while the request is ACTIVE; erased on revoke/regenerate/cancel.
  CONSTRAINT payment_requests_token_erased_when_inactive
    CHECK ((status = 'ACTIVE') = (token_ciphertext IS NOT NULL)),
  CONSTRAINT payment_requests_key_id_with_ciphertext
    CHECK ((token_ciphertext IS NULL) = (token_key_id IS NULL))
);
-- Only one ACTIVE request per collection.
CREATE UNIQUE INDEX payment_requests_one_active ON payment_requests (collection_id) WHERE status = 'ACTIVE';
CREATE INDEX payment_requests_collection_idx ON payment_requests (employer_id, collection_id);

CREATE FUNCTION payment_requests_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id, NEW.employer_id, NEW.collection_id, NEW.token_hash, NEW.created_at,
      NEW.supersedes_request_id, NEW.expires_at,
      NEW.snapshot_customer_name, NEW.snapshot_amount_requested, NEW.snapshot_reference,
      NEW.snapshot_employer_display_name, NEW.snapshot_upi_id, NEW.snapshot_upi_number,
      NEW.snapshot_qr_storage_key, NEW.snapshot_bank_name, NEW.snapshot_account_name,
      NEW.snapshot_account_number, NEW.snapshot_ifsc, NEW.snapshot_enabled_methods)
     IS DISTINCT FROM
     (OLD.id, OLD.employer_id, OLD.collection_id, OLD.token_hash, OLD.created_at,
      OLD.supersedes_request_id, OLD.expires_at,
      OLD.snapshot_customer_name, OLD.snapshot_amount_requested, OLD.snapshot_reference,
      OLD.snapshot_employer_display_name, OLD.snapshot_upi_id, OLD.snapshot_upi_number,
      OLD.snapshot_qr_storage_key, OLD.snapshot_bank_name, OLD.snapshot_account_name,
      OLD.snapshot_account_number, OLD.snapshot_ifsc, OLD.snapshot_enabled_methods)
  THEN
    RAISE EXCEPTION 'payment_requests snapshot and token_hash are immutable';
  END IF;
  IF OLD.status = 'REVOKED' AND NEW.status <> 'REVOKED' THEN
    RAISE EXCEPTION 'a revoked payment request can never become active again';
  END IF;
  IF OLD.token_ciphertext IS NULL AND NEW.token_ciphertext IS NOT NULL THEN
    RAISE EXCEPTION 'token ciphertext can only be erased, never re-added';
  END IF;
  IF OLD.token_ciphertext IS NOT NULL AND NEW.token_ciphertext IS NOT NULL
     AND NEW.token_ciphertext IS DISTINCT FROM OLD.token_ciphertext THEN
    RAISE EXCEPTION 'token ciphertext cannot be modified';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER payment_requests_guard_trg BEFORE UPDATE ON payment_requests
  FOR EACH ROW EXECUTE FUNCTION payment_requests_guard();

-- ---------------------------------------------------------------- payments
CREATE TABLE payments (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),     -- client-supplied UUID allowed (idempotency)
  employer_id    uuid NOT NULL REFERENCES employers(id),
  collection_id  uuid NOT NULL,
  amount         numeric(12,2) NOT NULL CHECK (amount > 0),
  payment_date   date NOT NULL,
  payment_method text NOT NULL CHECK (payment_method IN ('UPI','BANK','CASH','OTHER')),
  reference_utr  text,
  status         text NOT NULL DEFAULT 'VERIFIED' CHECK (status IN ('RECORDED','VERIFIED','VOID')),
  voided_reason  text,
  created_by     uuid NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, employer_id),
  FOREIGN KEY (collection_id, employer_id) REFERENCES collections (id, employer_id),
  CHECK (status <> 'VOID' OR voided_reason IS NOT NULL)
);
CREATE INDEX payments_collection_idx ON payments (employer_id, collection_id);
CREATE TRIGGER payments_updated_at BEFORE UPDATE ON payments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------- payment_settings
CREATE TABLE payment_settings (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employer_id         uuid NOT NULL UNIQUE REFERENCES employers(id),
  display_name        text,
  upi_id              text,
  upi_number          text,
  qr_code_storage_key text,
  bank_name           text,
  account_name        text,
  account_number      text,
  ifsc                text,
  upi_enabled         boolean NOT NULL DEFAULT false,
  upi_number_enabled  boolean NOT NULL DEFAULT false,
  qr_enabled          boolean NOT NULL DEFAULT false,
  bank_enabled        boolean NOT NULL DEFAULT false,
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- notifications
CREATE TABLE notifications (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employer_id         uuid NOT NULL REFERENCES employers(id),
  collection_id       uuid NOT NULL,
  payment_request_id  uuid,
  channel             text NOT NULL CHECK (channel IN ('WHATSAPP','SMS','MANUAL')),
  to_phone            text,
  status              text NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED','SENT','FAILED')),
  provider            text,
  provider_message_id text,
  error               text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (collection_id, employer_id)       REFERENCES collections (id, employer_id),
  FOREIGN KEY (payment_request_id, employer_id)  REFERENCES payment_requests (id, employer_id)
);
CREATE INDEX notifications_collection_idx ON notifications (employer_id, collection_id);

-- ---------------------------------------------------------------- audit_events (append-only; never holds tokens)
CREATE TABLE audit_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employer_id uuid NOT NULL REFERENCES employers(id),
  actor       text NOT NULL,
  entity_type text NOT NULL,
  entity_id   uuid,
  action      text NOT NULL,
  details     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_events_entity_idx ON audit_events (employer_id, entity_type, entity_id, created_at DESC);

CREATE FUNCTION audit_events_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'audit_events is append-only'; END $$;
CREATE TRIGGER audit_events_no_update BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_events_append_only();

-- ---------------------------------------------------------------- RLS
ALTER TABLE employers ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON employers TO app_rls
  USING (id = current_employer_id()) WITH CHECK (id = current_employer_id());
"""


def upgrade() -> None:
    op.execute(UPGRADE_SQL)
    for table in TENANT_TABLES:
        op.execute(f"ALTER TABLE {table} ENABLE ROW LEVEL SECURITY")
        op.execute(
            f"CREATE POLICY tenant_isolation ON {table} TO app_rls "
            f"USING (employer_id = current_employer_id()) "
            f"WITH CHECK (employer_id = current_employer_id())"
        )
    for table, privs in GRANTS.items():
        op.execute(f"GRANT {privs} ON {table} TO app_rls")
    # Supabase exposes the public schema through its Data API; deny those roles outright.
    op.execute(
        """
        DO $$
        DECLARE r text;
        BEGIN
          FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
            IF EXISTS (SELECT FROM pg_roles WHERE rolname = r) THEN
              EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', r);
              EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM %I', r);
            END IF;
          END LOOP;
        END $$;
        """
    )


def downgrade() -> None:
    op.execute(
        """
        DROP TABLE IF EXISTS audit_events, notifications, payment_settings, payments,
          payment_requests, import_rows, collections, import_batches, customers, employers CASCADE;
        DROP FUNCTION IF EXISTS audit_events_append_only();
        DROP FUNCTION IF EXISTS payment_requests_guard();
        DROP FUNCTION IF EXISTS resolve_employer_id(uuid);
        DROP FUNCTION IF EXISTS set_updated_at();
        DROP FUNCTION IF EXISTS current_employer_id();
        """
    )

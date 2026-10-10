"""Payment receipts on collections, and petty-cash entries (ADR 0008).

Revision ID: 0005
Revises: 0004

`collection_receipts`: at most one receipt file (image/PDF) per collection, stored privately.
`petty_cash_entries`: a receipt-backed expense record whose fields the employer reviewed.
Both are tenant tables: employer_id, RLS and a policy.
"""

from alembic import op

revision = "0005"
down_revision = "0004"
branch_labels = None
depends_on = None

UPGRADE_SQL = """
CREATE TABLE collection_receipts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employer_id   uuid NOT NULL REFERENCES employers(id),
  collection_id uuid NOT NULL UNIQUE REFERENCES collections(id) ON DELETE CASCADE,
  storage_key   text NOT NULL,
  content_type  text NOT NULL,
  size_bytes    integer NOT NULL CHECK (size_bytes > 0),
  original_name text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE collection_receipts ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON collection_receipts TO app_rls
  USING (employer_id = current_employer_id()) WITH CHECK (employer_id = current_employer_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON collection_receipts TO app_rls;

CREATE TABLE petty_cash_entries (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employer_id    uuid NOT NULL REFERENCES employers(id),
  transaction_id text,
  txn_date       date,
  payment_to     text,
  payment_from   text,
  remarks        text,
  amount         numeric(14,2) NOT NULL CHECK (amount > 0),
  storage_key    text NOT NULL,
  content_type   text NOT NULL,
  original_name  text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX petty_cash_entries_employer_date ON petty_cash_entries (employer_id, txn_date DESC);
CREATE INDEX petty_cash_entries_txn ON petty_cash_entries (employer_id, transaction_id);
CREATE TRIGGER petty_cash_entries_updated_at BEFORE UPDATE ON petty_cash_entries
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
ALTER TABLE petty_cash_entries ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON petty_cash_entries TO app_rls
  USING (employer_id = current_employer_id()) WITH CHECK (employer_id = current_employer_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON petty_cash_entries TO app_rls;
"""

DOWNGRADE_SQL = """
DROP TABLE petty_cash_entries;
DROP TABLE collection_receipts;
"""


def upgrade() -> None:
    op.execute(UPGRADE_SQL)


def downgrade() -> None:
    op.execute(DOWNGRADE_SQL)

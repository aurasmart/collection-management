"""Simple MVP: one payment-page token per collection, per-row customers, public page lookup.

Revision ID: 0002
Revises: 0001
"""

from alembic import op

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None

UPGRADE_SQL = """
-- A customer's payment page is addressed by one unguessable random token (secrets.token_urlsafe(16)).
ALTER TABLE collections ADD COLUMN payment_token text;
CREATE UNIQUE INDEX collections_payment_token_uq ON collections (payment_token)
  WHERE payment_token IS NOT NULL;

-- Every imported row is its own customer record, so editing a row never touches another row.
DROP INDEX customers_employer_phone_uq;

-- The ONLY way the public payment page reads data (no tenant context exists for an anonymous visitor).
-- Disabled payment methods come back as NULL, so they can never leak.
CREATE FUNCTION public_payment_page(p_token text)
RETURNS TABLE (
  company_name text, customer_name text, amount_due numeric, reference text, status text,
  upi_id text, upi_number text, has_qr boolean, qr_key text,
  bank_name text, account_name text, account_number text, ifsc text
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS
$$
  SELECT COALESCE(NULLIF(ps.display_name, ''), e.name),
         cu.name, c.amount_due, c.reference, c.status,
         CASE WHEN ps.upi_enabled THEN ps.upi_id END,
         CASE WHEN ps.upi_number_enabled THEN ps.upi_number END,
         COALESCE(ps.qr_enabled AND ps.qr_code_storage_key IS NOT NULL, false),
         CASE WHEN ps.qr_enabled THEN ps.qr_code_storage_key END,
         CASE WHEN ps.bank_enabled THEN ps.bank_name END,
         CASE WHEN ps.bank_enabled THEN ps.account_name END,
         CASE WHEN ps.bank_enabled THEN ps.account_number END,
         CASE WHEN ps.bank_enabled THEN ps.ifsc END
  FROM collections c
  JOIN customers cu ON cu.id = c.customer_id AND cu.employer_id = c.employer_id
  JOIN employers e ON e.id = c.employer_id
  LEFT JOIN payment_settings ps ON ps.employer_id = c.employer_id
  WHERE c.payment_token = p_token AND c.payment_token IS NOT NULL
$$;
REVOKE ALL ON FUNCTION public_payment_page(text) FROM PUBLIC;
"""


def upgrade() -> None:
    op.execute(UPGRADE_SQL)


def downgrade() -> None:
    op.execute(
        """
        DROP FUNCTION IF EXISTS public_payment_page(text);
        CREATE UNIQUE INDEX customers_employer_phone_uq ON customers (employer_id, phone)
          WHERE phone IS NOT NULL;
        DROP INDEX IF EXISTS collections_payment_token_uq;
        ALTER TABLE collections DROP COLUMN IF EXISTS payment_token;
        """
    )

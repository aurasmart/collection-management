"""Company profiles: the company's identity (name, logo, contacts) lives apart from payment details.

Revision ID: 0003
Revises: 0002

`payment_settings.display_name` is copied into `company_profiles.display_name` and is no longer
written by the application. The old column stays (nullable, unused) until a later clean-up
migration, so this change is reversible and no existing payment link breaks.
"""

from alembic import op

revision = "0003"
down_revision = "0002"
branch_labels = None
depends_on = None

UPGRADE_SQL = """
CREATE TABLE company_profiles (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employer_id    uuid NOT NULL UNIQUE REFERENCES employers(id),
  display_name   text NOT NULL CHECK (char_length(display_name) BETWEEN 2 AND 60),
  legal_name     text,
  logo_key       text,
  address        text,
  city           text,
  state          text,
  pin            text,
  gstin          text,
  pan            text,
  contact_person text,
  phone          text,
  email          text,
  website        text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER company_profiles_updated_at BEFORE UPDATE ON company_profiles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE company_profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON company_profiles TO app_rls
  USING (employer_id = current_employer_id()) WITH CHECK (employer_id = current_employer_id());
GRANT SELECT, INSERT, UPDATE ON company_profiles TO app_rls;

-- Existing display names move over. Names outside the 2..60 rule are trimmed/skipped safely.
INSERT INTO company_profiles (employer_id, display_name)
SELECT ps.employer_id, left(btrim(ps.display_name), 60)
FROM payment_settings ps
WHERE char_length(btrim(COALESCE(ps.display_name, ''))) >= 2;

-- The public page: same single door, now reading the profile. Optional contact fields come back
-- NULL when empty. PAN, legal name and contact person are never returned.
DROP FUNCTION public_payment_page(text);
CREATE FUNCTION public_payment_page(p_token text)
RETURNS TABLE (
  company_name text, customer_name text, amount_due numeric, reference text, status text,
  upi_id text, upi_number text, has_qr boolean, qr_key text,
  bank_name text, account_name text, account_number text, ifsc text,
  has_logo boolean, logo_key text, company_phone text, company_email text,
  company_address text, company_gstin text
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS
$$
  SELECT COALESCE(NULLIF(cp.display_name, ''), NULLIF(ps.display_name, ''), e.name),
         cu.name, c.amount_due, c.reference, c.status,
         CASE WHEN ps.upi_enabled THEN ps.upi_id END,
         CASE WHEN ps.upi_number_enabled THEN ps.upi_number END,
         COALESCE(ps.qr_enabled AND ps.qr_code_storage_key IS NOT NULL, false),
         CASE WHEN ps.qr_enabled THEN ps.qr_code_storage_key END,
         CASE WHEN ps.bank_enabled THEN ps.bank_name END,
         CASE WHEN ps.bank_enabled THEN ps.account_name END,
         CASE WHEN ps.bank_enabled THEN ps.account_number END,
         CASE WHEN ps.bank_enabled THEN ps.ifsc END,
         cp.logo_key IS NOT NULL, cp.logo_key,
         NULLIF(cp.phone, ''), NULLIF(cp.email, ''),
         NULLIF(concat_ws(', ', NULLIF(cp.address, ''), NULLIF(cp.city, ''),
                          NULLIF(concat_ws(' ', NULLIF(cp.state, ''), NULLIF(cp.pin, '')), '')), ''),
         NULLIF(cp.gstin, '')
  FROM collections c
  JOIN customers cu ON cu.id = c.customer_id AND cu.employer_id = c.employer_id
  JOIN employers e ON e.id = c.employer_id
  LEFT JOIN company_profiles cp ON cp.employer_id = c.employer_id
  LEFT JOIN payment_settings ps ON ps.employer_id = c.employer_id
  WHERE c.payment_token = p_token AND c.payment_token IS NOT NULL
$$;
REVOKE ALL ON FUNCTION public_payment_page(text) FROM PUBLIC;
"""

DOWNGRADE_SQL = """
DROP FUNCTION IF EXISTS public_payment_page(text);
CREATE FUNCTION public_payment_page(p_token text)
RETURNS TABLE (
  company_name text, customer_name text, amount_due numeric, reference text, status text,
  upi_id text, upi_number text, has_qr boolean, qr_key text,
  bank_name text, account_name text, account_number text, ifsc text
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS
$$
  SELECT COALESCE(NULLIF(cp.display_name, ''), NULLIF(ps.display_name, ''), e.name),
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
  LEFT JOIN company_profiles cp ON cp.employer_id = c.employer_id
  LEFT JOIN payment_settings ps ON ps.employer_id = c.employer_id
  WHERE c.payment_token = p_token AND c.payment_token IS NOT NULL
$$;
REVOKE ALL ON FUNCTION public_payment_page(text) FROM PUBLIC;
DROP TABLE IF EXISTS company_profiles;
"""


def upgrade() -> None:
    op.execute(UPGRADE_SQL)


def downgrade() -> None:
    op.execute(DOWNGRADE_SQL)

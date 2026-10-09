"""Let the employer delete their own customers (collections) from the app.

Revision ID: 0004
Revises: 0003

The tenant role could not DELETE collections or customers (least privilege). Deleting a customer is
now an employer action, so the grant is added. Row-level security still limits it to the employer's
own rows; audit events are append-only and survive. Payment, request and notification tables stay
without DELETE.
"""

from alembic import op

revision = "0004"
down_revision = "0003"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("GRANT DELETE ON collections, customers TO app_rls")


def downgrade() -> None:
    op.execute("REVOKE DELETE ON collections, customers FROM app_rls")

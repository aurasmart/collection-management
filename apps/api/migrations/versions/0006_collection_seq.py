"""Insertion order for collections.

Revision ID: 0006
Revises: 0005

Rows imported together share one `created_at` (a transaction has a single timestamp), so sorting by
created date alone left them in a random order. `seq` counts rows in the order they were inserted
and breaks those ties, so "Oldest/Newest first" follows the import file's row order.
"""

from alembic import op

revision = "0006"
down_revision = "0005"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("ALTER TABLE collections ADD COLUMN seq bigint GENERATED ALWAYS AS IDENTITY")


def downgrade() -> None:
    op.execute("ALTER TABLE collections DROP COLUMN seq")

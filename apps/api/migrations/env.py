"""Alembic environment. Migrations are plain SQL-in-Python; no ORM metadata."""

from __future__ import annotations

import os
from logging.config import fileConfig

from alembic import context
from dotenv import dotenv_values
from sqlalchemy import create_engine, pool

config = context.config
if config.config_file_name is not None:
    fileConfig(config.config_file_name, disable_existing_loggers=False)


def _database_url() -> str:
    url = (
        config.get_main_option("sqlalchemy.url")
        or os.environ.get("DATABASE_URL")
        or dotenv_values(".env").get("DATABASE_URL")
    )
    if not url:
        raise RuntimeError("DATABASE_URL is not set (environment or apps/api/.env)")
    if url.startswith("postgres://"):
        url = "postgresql://" + url.removeprefix("postgres://")
    if url.startswith("postgresql://"):
        url = "postgresql+psycopg://" + url.removeprefix("postgresql://")
    return url


def run_migrations_online() -> None:
    engine = create_engine(_database_url(), poolclass=pool.NullPool)
    with engine.connect() as connection:
        context.configure(connection=connection, target_metadata=None)
        with context.begin_transaction():
            context.run_migrations()


run_migrations_online()

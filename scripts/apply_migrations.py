"""
Apply the SQL migrations to Supabase over a direct Postgres connection.

Why this exists: neither the `sb_secret_…` key nor the `service_role` JWT can run DDL. Both talk to
PostgREST, which executes queries against tables that already exist — it has no path to CREATE TABLE.
Applying a schema needs one of:

  * the database password  → this script
  * a management token (`sbp_…`) → https://api.supabase.com/v1/projects/{ref}/database/query

Usage:

    SUPABASE_DB_PASSWORD='…' python scripts/apply_migrations.py
    python scripts/apply_migrations.py --url "postgresql://postgres:…@db.….supabase.co:5432/postgres"

The script is idempotent in the sense that it reports what already exists rather than failing the
whole run: each migration is applied in its own transaction, and an "already exists" error is
reported as SKIPPED rather than crashing, so re-running after a partial apply is safe.
"""

from __future__ import annotations

import argparse
import os
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MIGRATIONS = ROOT / "db" / "migrations"
PROJECT_REF = "atsffbepeptelvtxkufv"

try:
    import psycopg
except ImportError:
    print("psycopg is not installed.  pip install 'psycopg[binary]'")
    sys.exit(2)


def build_url(args: argparse.Namespace) -> str | None:
    if args.url:
        return args.url
    pw = args.password or os.getenv("SUPABASE_DB_PASSWORD")
    if not pw:
        return None
    # Direct connection. The pooler (aws-0-<region>.pooler.supabase.com:5432, user
    # postgres.<ref>) also works and is the fallback when 5432 is blocked.
    return f"postgresql://postgres:{pw}@db.{PROJECT_REF}.supabase.co:5432/postgres?sslmode=require"


def split_statements(sql: str) -> list[str]:
    """
    Split on the semicolons that actually terminate a statement.

    Three things must be stepped over, or a semicolon inside them splits a statement in half:
      * dollar-quoted bodies — 002_rls.sql defines functions as $$ ... $$
      * line comments — a header like "V4 §35 (tables), §38 (RLS); Ecosystem Addendum V5" contains
        a semicolon, and splitting there turns the comment tail into a bogus statement
      * block comments
      * single-quoted string literals
    """
    out: list[str] = []
    buf: list[str] = []
    i = 0
    n = len(sql)

    while i < n:
        rest = sql[i:]

        # line comment: keep it with the current buffer, but never split inside it
        if rest.startswith("--"):
            end = sql.find("\n", i)
            end = n if end == -1 else end + 1
            buf.append(sql[i:end])
            i = end
            continue

        if rest.startswith("/*"):
            end = sql.find("*/", i)
            end = n if end == -1 else end + 2
            buf.append(sql[i:end])
            i = end
            continue

        m = re.match(r"\$([A-Za-z_]*)\$", rest)
        if m:
            tag = m.group(0)
            end = sql.find(tag, i + len(tag))
            end = n if end == -1 else end + len(tag)
            buf.append(sql[i:end])
            i = end
            continue

        if rest.startswith("'"):
            j = i + 1
            while j < n:
                if sql[j] == "'":
                    if j + 1 < n and sql[j + 1] == "'":  # escaped quote
                        j += 2
                        continue
                    j += 1
                    break
                j += 1
            buf.append(sql[i:j])
            i = j
            continue

        if sql[i] == ";":
            stmt = "".join(buf).strip()
            if stmt and not _is_only_comment(stmt):
                out.append(stmt)
            buf = []
            i += 1
            continue

        buf.append(sql[i])
        i += 1

    tail = "".join(buf).strip()
    if tail and not _is_only_comment(tail):
        out.append(tail)
    return out


def _is_only_comment(stmt: str) -> bool:
    """A trailing block of comments is not a statement and must not be sent to the server."""
    stripped = re.sub(r"/\*.*?\*/", "", stmt, flags=re.S)
    stripped = "\n".join(
        line for line in stripped.splitlines() if not line.strip().startswith("--")
    )
    return not stripped.strip()


ALREADY_EXISTS = ("already exists", "duplicate object", "duplicate_object")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", help="full postgresql:// connection string")
    ap.add_argument("--password", help="database password (or set SUPABASE_DB_PASSWORD)")
    ap.add_argument("--dry-run", action="store_true", help="parse and count statements, connect to nothing")
    args = ap.parse_args()

    files = sorted(MIGRATIONS.glob("*.sql"))
    if not files:
        print(f"no migrations found in {MIGRATIONS}")
        return 1

    if args.dry_run:
        for f in files:
            print(f"{f.name}: {len(split_statements(f.read_text(encoding='utf-8')))} statements")
        return 0

    url = build_url(args)
    if not url:
        # Operator-facing output stays ASCII: this console is cp1252, and a stray arrow here
        # crashed the very message that explains what to do next.
        print(
            "No database password.\n\n"
            "The service_role key and the sb_secret_ key both go through PostgREST,\n"
            "which cannot run DDL. Supply one of:\n\n"
            "  SUPABASE_DB_PASSWORD='<password>' python scripts/apply_migrations.py\n"
            "  python scripts/apply_migrations.py --url "
            "'postgresql://postgres:<password>@db.<ref>.supabase.co:5432/postgres'\n\n"
            "Find it at: Dashboard > Project Settings > Database > Database password.\n"
            "Or paste db/apply_all.sql into the SQL editor, which needs no credentials at all."
        )
        return 2

    applied = skipped = failed = 0
    safe_url = re.sub(r"://([^:]+):[^@]+@", r"://\1:***@", url)
    print(f"connecting to {safe_url}\n")

    with psycopg.connect(url, autocommit=True) as conn:
        for f in files:
            statements = split_statements(f.read_text(encoding="utf-8"))
            print(f"── {f.name} ({len(statements)} statements)")
            for n, stmt in enumerate(statements, 1):
                head = " ".join(stmt.split())[:70]
                try:
                    with conn.cursor() as cur:
                        cur.execute(stmt)
                    applied += 1
                except psycopg.Error as exc:
                    msg = str(exc).strip().splitlines()[0]
                    if any(k in msg.lower() for k in ALREADY_EXISTS):
                        skipped += 1
                    else:
                        failed += 1
                        print(f"   [{n:3d}] FAILED  {head}")
                        print(f"         {msg}")
            print(f"   applied so far: {applied}  skipped: {skipped}  failed: {failed}")

        with conn.cursor() as cur:
            cur.execute(
                "select count(*) from information_schema.tables "
                "where table_schema = 'public' and table_type = 'BASE TABLE'"
            )
            tables = cur.fetchone()[0]
            cur.execute(
                "select count(*) from pg_policies where schemaname = 'public'"
            )
            policies = cur.fetchone()[0]

    print(f"\napplied {applied} · skipped (already present) {skipped} · failed {failed}")
    print(f"public schema now has {tables} tables and {policies} RLS policies")
    if failed:
        print("\nsome statements failed — review the messages above before switching STORE=supabase")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())

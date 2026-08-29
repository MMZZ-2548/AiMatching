"""
Validate the migrations offline, before anything touches the database.

Uses pglast, which wraps PostgreSQL's own `libpg_query` — so this is the real server grammar, not
an approximation. Running it costs nothing and catches the class of mistake that is most annoying
to discover halfway through a paste into the SQL editor.

It also checks the statement splitter used by apply_migrations.py, which is a genuine source of
bugs: a semicolon inside a comment, a dollar-quoted function body or a string literal must not end
a statement.

    python scripts/validate_migrations.py
"""

from __future__ import annotations

import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

from apply_migrations import split_statements  # noqa: E402

try:
    from pglast import parse_sql
    from pglast.parser import ParseError
except ImportError:
    print("pglast is not installed.  pip install pglast")
    sys.exit(2)


def main() -> int:
    total = valid = invalid = 0
    kinds: Counter[str] = Counter()
    failures: list[tuple[str, int, str, str]] = []

    for f in sorted((ROOT / "db" / "migrations").glob("*.sql")):
        statements = split_statements(f.read_text(encoding="utf-8"))
        errs = 0
        for i, stmt in enumerate(statements, 1):
            total += 1
            try:
                tree = parse_sql(stmt)
                valid += 1
                node = tree[0].stmt if tree else None
                kinds[type(node).__name__ if node else "Empty"] += 1
            except ParseError as exc:
                invalid += 1
                errs += 1
                failures.append((f.name, i, " ".join(stmt.split())[:90], str(exc)))
        status = "OK" if errs == 0 else f"{errs} ERRORS"
        print(f"{f.name:20s} {len(statements):4d} statements   {status}")

    # the whole-file path, which is what a paste into the SQL editor exercises
    whole = ROOT / "db" / "apply_all.sql"
    whole_ok = True
    if whole.exists():
        try:
            parse_sql(whole.read_text(encoding="utf-8"))
            print(f"{whole.name:20s} parses cleanly as a single script")
        except ParseError as exc:
            whole_ok = False
            print(f"{whole.name:20s} PARSE ERROR: {exc}")

    print(f"\n{total} statements | valid {valid} | invalid {invalid}")
    print("\nby statement type:")
    for kind, n in kinds.most_common():
        print(f"  {n:4d}  {kind}")

    for name, i, head, msg in failures:
        print(f"\n{name} [{i}] {head}\n    {msg}")

    return 0 if invalid == 0 and whole_ok else 1


if __name__ == "__main__":
    sys.exit(main())

# Supabase schema

**Applied.** Project `atsffbepeptelvtxkufv` now holds **42 tables and 32 RLS policies**.

```
001_init.sql          71 statements   tables, enums, indexes        (V4 §35)
002_rls.sql           56 statements   Row Level Security            (V4 §38)
003_stable_codes.sql  30 statements   readable codes + workflow columns
                     ───
                     157 statements   0 failed
```

## Re-applying or applying to a fresh project

```bash
pip install "psycopg[binary]" pglast

python scripts/validate_migrations.py                  # 157/157 parse against the real PG grammar
SUPABASE_DB_PASSWORD='<password>' python scripts/apply_migrations.py
```

The script applies each statement separately and reports anything that already exists as *skipped*
rather than failing, so re-running is safe. It finishes by counting the tables and policies that
actually ended up in `public`.

Password: **Dashboard → Project Settings → Database → Database password**.
Alternative with no credential at all: paste `db/apply_all.sql` into the SQL editor.

## Why the API keys were not enough

| Credential | Reaches | Can run DDL? |
|---|---|---|
| `sb_publishable_…` | PostgREST, anonymous | no |
| `sb_secret_…` | PostgREST, service role | **no** |
| `service_role` JWT (`eyJ…`) | PostgREST, service role | **no** |
| database password | Postgres directly | **yes** |
| management token (`sbp_…`) | Management API | yes |

PostgREST executes queries against tables that already exist. This project exposes no
`exec_sql`-style RPC — `exec_sql`, `exec`, `query`, `execute_sql` and `run_sql` all return 404,
and `/pg/query` is not public. The Management API rejects the service-role JWT with 401.

## Running against it

```bash
STORE=supabase node backend/src/server.js
curl http://localhost:3000/api/health          # store.driver -> "supabase"
curl -X POST http://localhost:3000/api/dev/seed
```

`STORE=memory` (the default) keeps the same domain in process and enforces the same rules; the
benchmarks use it because they need no persistence.

> **Do not run the test suite against a shared project.** `beforeEach` calls `store.reset()`, which
> deletes every domain row. Against `STORE=supabase` that wipes the real project — including data
> another person or a running tester is using. Point `SUPABASE_URL` at a scratch project first, or
> leave the suite on the default in-process store, which is what CI should use.
>
> It is also slow: each test resets 38 tables and re-seeds 45 rows over the network, so the
> default 10 s hook timeout is not enough. Raise it if you do run it:
> `STORE=supabase npx vitest run --hookTimeout 120000`.

## Readable codes vs uuid keys

Seeded rows carry a uuid primary key **and** a unique `code` (`CR-01`, `CG_FAR_PERFECT_01`). The
uuid is UUIDv5 of the code (`backend/src/lib/ids.js`), so it is identical on every machine and
across re-seeds, and the API accepts either form — `/api/matching/CR-01/run` and
`/api/matching/<uuid>/run` reach the same row.

## Files

| File | Contents |
|---|---|
| `migrations/001_init.sql` | 42 tables, 16 enums, 12 indexes |
| `migrations/002_rls.sql` | 32 RLS policies, 3 helper functions |
| `migrations/003_stable_codes.sql` | `code` columns, workflow columns |
| `apply_all.sql` | 001 + 002 concatenated, for a single paste |
| `../scripts/apply_migrations.py` | scripted apply over a direct Postgres connection |
| `../scripts/validate_migrations.py` | offline syntax check with `pglast` |

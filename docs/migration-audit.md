# Migration audit

Required by Master System Spec V4 §49 and §52 step 3.

## Finding

`D:\T-Ai\AiMatching` contained only `.codesight/` — an IDE scan-configuration folder, no source,
no dependencies, no database objects. The Supabase project `atsffbepeptelvtxkufv` exposed no
tables through PostgREST (verified: `GET /rest/v1/profiles` returned PGRST205 "Could not find the
table").

**This is a greenfield build.** There is no prior system to inventory, and V4 §49's
KEEP / REWRITE / DEPRECATED / REMOVE classification has nothing to classify. No backup was needed
because nothing existed to lose, and nothing was deleted.

## What was created

| Path | Contents |
|---|---|
| `docs/SCORING_SPEC.md` | The normative scoring specification, reconciling V4 §14–§20/§34, V5 §18–§27 and V6 §6–§11 |
| `backend/src/matching/` | Deterministic matching engine — hard filters, features, scores, exceptional distance, trust |
| `backend/src/services/` | Matching orchestration, two-sided workflow, rule-based monitoring, AI gateway |
| `backend/src/routes/api.js` | Node API (V4 §36 plus the V5 additions) |
| `backend/src/store/` | Pluggable persistence: in-process and Supabase PostgREST |
| `backend/src/seed/seed.js` | Demo world — V4 §40 counts plus the V5 §32 distance caregivers |
| `backend/tests/` | 80 tests: unit, API integration, two-sided E2E |
| `ai-service/` | Python FastAPI service — intake, explanation, advisor, report, STT |
| `db/migrations/` | 40 tables (V4 §35) and RLS policies (V4 §38) |
| `adapters/` | Strathclyde and HHCRSP benchmark adapters |
| `scripts/` | Dataset generation, three benchmark runners, aggregation |
| `web/`, `tester/` | Test web UI, since removed — see the note below |

## The test UI

A web UI was built during development to exercise every flow end to end: a nine-step family wizard,
the caregiver's own search and job board, the live job screen, and a developer console. It served
its purpose — it is what surfaced the seed-availability bug, the self-double-booking bug and the
stale-profile echo — and it was removed once the flows were proven, because it was never the
deliverable.

What it covered is written up in `docs/FRONTEND_HANDOFF.md`: every screen, the endpoints each one
called, and the rules a real frontend has to respect. The endpoints it used all remain.

## Data preserved

V4 §49 forbids deleting benchmark artifacts, test reports or historical evidence without a backup.
Nothing in `reports/` or `data/` has been deleted at any point. `data/strathclyde/` holds a copy of
the CSVs supplied by the team; `data/hhcrsp2/` is a clone of the upstream MIT-licensed repository.
Both are excluded from version control by `.gitignore` because they are large and separately
licensed, not because they are disposable.

## Schema application

Applied on 29 August 2026 with `scripts/apply_migrations.py` over a direct Postgres connection:
**127 statements from 001 and 002, then 30 more from 003 — 0 failures.** The `public` schema now
holds **42 tables and 32 RLS policies**.

Neither Supabase API key could do this. `sb_publishable_…`, `sb_secret_…` and the `service_role`
JWT all reach PostgREST, which executes queries against existing tables and has no DDL path; the
project exposes no `exec_sql`-style RPC (all of `exec_sql`, `exec`, `query`, `execute_sql`,
`run_sql` return 404) and the Management API rejects the service-role JWT with 401. The database
password was required, and is what `apply_migrations.py` uses.

### 003_stable_codes.sql

Seeding against real Postgres exposed a design gap the in-process store had hidden: the demo world
and every test scenario name entities readably (`CR-01`, `CG_FAR_PERFECT_01`), but the schema keys
on `uuid`, which a Map-backed store accepted and Postgres correctly rejected. Rather than weaken
the keys to text, migration 003 adds a unique `code` column to the four seeded tables, and
`backend/src/lib/ids.js` derives each seed id as UUIDv5 of its code. The ids are therefore stable
across re-seeds and machines, and the API accepts either form (`backend/src/routes/api.js`
resolves a non-uuid path or body id through `resolveId`).

Migration 003 also adds the columns the workflow persists that the first cut of the schema did not
carry — `skills`, `availability`, `requirements`, `feature_values` and similar.

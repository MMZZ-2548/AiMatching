-- Human-readable stable codes alongside the uuid primary keys.
--
-- The demo world and every test scenario refer to entities by readable names ("CR-01",
-- "CG_FAR_PERFECT_01"). Those are not uuids, and Postgres rightly rejects them as primary keys —
-- the in-process store accepted them only because it is a Map.
--
-- Rather than weaken the keys to text, each seeded row keeps a uuid id and carries a `code`.
-- Seed ids are generated as UUIDv5 of the code, so they are stable across re-seeds and across
-- machines: the same code always produces the same uuid.

alter table profiles           add column if not exists code text unique;
alter table elderly_profiles   add column if not exists code text unique;
alter table caregiver_profiles add column if not exists code text unique;
alter table care_requests      add column if not exists code text unique;

create index if not exists profiles_code_idx           on profiles(code);
create index if not exists elderly_profiles_code_idx   on elderly_profiles(code);
create index if not exists caregiver_profiles_code_idx on caregiver_profiles(code);
create index if not exists care_requests_code_idx      on care_requests(code);

-- Scenario labels used by the tester and the seed (V4 §40 lists the outcomes each must cover).
alter table care_requests add column if not exists scenario text;

-- Fields the workflow persists that the initial schema did not carry.
alter table caregiver_profiles add column if not exists display_name text;
alter table caregiver_profiles add column if not exists mean_rating numeric(3,2);
alter table caregiver_profiles add column if not exists skills text[] not null default '{}';
alter table caregiver_profiles add column if not exists skill_levels jsonb not null default '{}';
alter table caregiver_profiles add column if not exists certificates jsonb not null default '[]';
alter table caregiver_profiles add column if not exists condition_experience jsonb not null default '{}';
alter table caregiver_profiles add column if not exists languages text[] not null default '{}';
alter table caregiver_profiles add column if not exists availability jsonb not null default '[]';
alter table caregiver_profiles add column if not exists priority_preferences jsonb not null default '[]';

alter table care_requests add column if not exists tasks jsonb not null default '[]';
alter table care_requests add column if not exists requirements jsonb not null default '[]';
alter table care_requests add column if not exists continuity_preference text;
alter table care_requests add column if not exists environment jsonb not null default '{}';

alter table job_requests add column if not exists scores jsonb;
alter table job_requests add column if not exists caregiver_note text;

alter table jobs add column if not exists last_event_seq bigint;

alter table matching_candidates add column if not exists feature_values jsonb;
alter table matching_candidates add column if not exists bucket_values jsonb;
alter table matching_candidates add column if not exists hard_filter_results jsonb;

alter table care_reports add column if not exists completed_tasks jsonb not null default '[]';
alter table care_reports add column if not exists observations text;

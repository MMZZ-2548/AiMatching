-- TrustCare — initial schema
-- Source: Master System Spec V4 §35 (tables), §38 (RLS); Ecosystem Addendum V5 §17, §23, §27
-- Greenfield: project atsffbepeptelvtxkufv was empty (see docs/migration-audit.md)

create extension if not exists "pgcrypto";

-- ============================================================ enums

create type user_role          as enum ('FAMILY','CAREGIVER','ADMIN');
create type verification_state as enum ('UNVERIFIED','PENDING','VERIFIED','REJECTED');
create type mobility_level     as enum ('INDEPENDENT','SUPERVISION','WALKING_ASSIST','TRANSFER_ASSIST','WHEELCHAIR','BEDBOUND');
create type pref_strength      as enum ('MANDATORY','IMPORTANT','NICE_TO_HAVE','NOT_IMPORTANT');
create type request_visibility as enum ('PRIVATE','MATCHED_ONLY','OPEN_TO_CAREGIVERS');
create type request_status     as enum ('DRAFT','CONFIRMED','MATCHING','CLOSED','CANCELLED');
create type interest_side      as enum ('FAMILY','CAREGIVER');
create type job_request_status as enum ('PENDING','VIEWED','ACCEPTED','DECLINED','EXPIRED','CANCELLED');
create type care_plan_status   as enum ('DRAFT','CONFIRMED','CANCELLED');
create type job_status         as enum ('SCHEDULED','IN_PROGRESS','COMPLETED','CANCELLED');
create type care_state         as enum ('NORMAL','OBSERVE','VERIFY','ATTENTION','HIGH_RISK');
create type incident_status    as enum ('REPORTED','UNCONFIRMED','CONFIRMED','DISMISSED');
create type responsibility     as enum ('UNDETERMINED','CAREGIVER_RESPONSIBLE','FAMILY_RESPONSIBLE','EXTERNAL','NONE');
create type trust_status       as enum ('NEW','ESTABLISHED');
create type candidate_bucket   as enum ('RECOMMENDED_NEARBY','EXCEPTIONAL','FILTERED_OUT');
create type care_event_type    as enum (
  'CHECK_IN','CHECK_OUT','TASK_STARTED','TASK_COMPLETED','TASK_DELAYED',
  'GPS_UPDATE','GEOFENCE_EXIT','GEOFENCE_ENTER','ALERT_SENT','ALERT_ACK',
  'ALERT_TIMEOUT','SOS','NOTE_ADDED');

-- ============================================================ identity

create table profiles (
  id                 uuid primary key default gen_random_uuid(),
  auth_user_id       uuid unique,
  role               user_role not null,
  email              text unique not null,
  phone              text,
  display_name       text not null,
  relation_to_elderly text,
  created_at         timestamptz not null default now()
);

create table elderly_profiles (
  id                  uuid primary key default gen_random_uuid(),
  family_id           uuid not null references profiles(id) on delete cascade,
  display_name        text not null,
  age                 int check (age between 0 and 130),
  gender              text,
  basic_conditions    text[] not null default '{}',
  mobility_level      mobility_level not null default 'INDEPENDENT',
  allergies           text[] not null default '{}',
  medical_devices     text[] not null default '{}',
  fall_risk           boolean not null default false,
  preferred_language  text[] not null default '{}',
  care_location_address text,
  province            text, district text, subdistrict text,
  latitude            double precision,
  longitude           double precision,
  emergency_contact   text,
  notes               text,
  created_at          timestamptz not null default now()
);
create index on elderly_profiles(family_id);

-- ============================================================ caregiver

create table caregiver_profiles (
  id                      uuid primary key default gen_random_uuid(),
  profile_id              uuid unique not null references profiles(id) on delete cascade,
  age                     int, gender text,
  years_experience        numeric(4,1) not null default 0,
  work_history_summary    text,
  verification_status     verification_state not null default 'UNVERIFIED',
  -- location (V4 §10.C)
  base_address            text,
  base_latitude           double precision,
  base_longitude          double precision,
  service_radius_km       numeric(6,2) not null default 25,
  max_travel_time_minutes int not null default 60,
  transport_mode          text,
  -- rate (V4 §10.D)
  minimum_rate            numeric(10,2) not null default 0,
  expected_rate           numeric(10,2) not null default 0,
  travel_fee_policy       text,
  overtime_rate           numeric(10,2),
  -- availability envelope (V4 §10.B)
  max_hours_per_shift     int not null default 12,
  daytime_ok              boolean not null default true,
  nighttime_ok            boolean not null default false,
  -- job preferences (V4 §10.E)
  preferred_job_types     text[] not null default '{}',
  not_preferred_job_types text[] not null default '{}',
  general_care_ok         boolean not null default true,
  dementia_care_ok        boolean not null default false,
  bedbound_care_ok        boolean not null default false,
  hospital_escort_ok      boolean not null default false,
  mobility_heavy_job_ok   boolean not null default false,
  lifting_job_ok          boolean not null default false,
  live_in_ok              boolean not null default false,
  one_time_job_ok         boolean not null default true,
  recurring_job_ok        boolean not null default true,
  long_term_job_ok        boolean not null default false,
  -- communication (V4 §10.F)
  care_styles             text[] not null default '{}',
  communication_styles    text[] not null default '{}',
  -- environment (V4 §10.G)
  pet_home_ok             boolean not null default true,
  smoking_environment_ok  boolean not null default false,
  -- out-of-area opt-in (V5 §23)
  out_of_area_enabled          boolean not null default false,
  max_out_of_area_distance_km  numeric(6,2) not null default 0,
  travel_fee_per_km            numeric(8,2) not null default 0,
  accommodation_required_after_km numeric(6,2) not null default 150,
  accommodation_minimum        numeric(10,2) not null default 0,
  overnight_ok                 boolean not null default false,
  relocation_short_term_ok     boolean not null default false,
  -- trust (V4 §10.H)
  final_trust_score        numeric(5,2) not null default 0,
  trust_status             trust_status not null default 'NEW',
  completed_jobs           int not null default 0,
  review_count             int not null default 0,
  confirmed_incident_count int not null default 0,
  created_at               timestamptz not null default now()
);

create table caregiver_skills (
  caregiver_id uuid not null references caregiver_profiles(id) on delete cascade,
  skill_code   text not null,
  primary key (caregiver_id, skill_code)
);
create table caregiver_skill_levels (
  caregiver_id uuid not null references caregiver_profiles(id) on delete cascade,
  skill_code   text not null,
  level        int not null check (level between 1 and 5),
  primary key (caregiver_id, skill_code)
);
create table caregiver_certificates (
  id uuid primary key default gen_random_uuid(),
  caregiver_id uuid not null references caregiver_profiles(id) on delete cascade,
  credential_code text not null,
  issuer text, issued_at date, expires_at date,
  verified boolean not null default false
);
create table caregiver_condition_experience (
  caregiver_id uuid not null references caregiver_profiles(id) on delete cascade,
  condition_code text not null,
  years numeric(4,1) not null default 0,
  primary key (caregiver_id, condition_code)
);
create table caregiver_languages (
  caregiver_id uuid not null references caregiver_profiles(id) on delete cascade,
  language_code text not null,
  primary key (caregiver_id, language_code)
);
create table caregiver_availability (
  id uuid primary key default gen_random_uuid(),
  caregiver_id uuid not null references caregiver_profiles(id) on delete cascade,
  weekday int check (weekday between 0 and 6),   -- recurring
  specific_date date,                             -- or one-off
  start_time time not null,
  end_time   time not null,
  recurring boolean not null default true,
  check (recurring and weekday is not null or not recurring and specific_date is not null)
);
create index on caregiver_availability(caregiver_id);

create table caregiver_job_preferences (
  caregiver_id uuid not null references caregiver_profiles(id) on delete cascade,
  pref_key text not null,
  pref_value text,
  strength pref_strength not null default 'NICE_TO_HAVE',
  primary key (caregiver_id, pref_key)
);
-- V4 §17: caregiver picks top 3
create table caregiver_priority_preferences (
  caregiver_id uuid not null references caregiver_profiles(id) on delete cascade,
  priority_key text not null,
  rank int not null check (rank between 1 and 3),
  primary key (caregiver_id, priority_key)
);

-- V4 §17: family picks top 3
create table family_matching_preferences (
  family_id uuid not null references profiles(id) on delete cascade,
  priority_key text not null,
  rank int not null check (rank between 1 and 3),
  primary key (family_id, priority_key)
);

-- ============================================================ care request

create table care_requests (
  id                uuid primary key default gen_random_uuid(),
  family_id         uuid not null references profiles(id) on delete cascade,
  elderly_id        uuid not null references elderly_profiles(id) on delete cascade,
  care_date         date not null,
  care_date_end     date,
  start_time        time not null,
  end_time          time not null,
  conditions_relevant text[] not null default '{}',
  mobility_requirement mobility_level,
  location_address  text,
  latitude          double precision,
  longitude         double precision,
  budget            numeric(10,2),
  -- conditional flags (V4 §11)
  hospital_visit        boolean not null default false,
  transport_required    boolean not null default false,
  lifting_required      boolean not null default false,
  medical_device_support boolean not null default false,
  night_monitoring      boolean not null default false,
  live_in_required      boolean not null default false,
  recurring_job         boolean not null default false,
  gender_preference     text,
  minimum_experience    numeric(4,1),
  additional_notes      text,
  -- V5 §17
  visibility        request_visibility not null default 'MATCHED_ONLY',
  accept_out_of_area boolean not null default false,
  status            request_status not null default 'DRAFT',
  created_at        timestamptz not null default now()
);
create index on care_requests(family_id);
create index on care_requests(status, visibility);

create table care_request_tasks (
  id uuid primary key default gen_random_uuid(),
  care_request_id uuid not null references care_requests(id) on delete cascade,
  task_code text not null,
  must_do boolean not null default false,
  notes text
);
create table care_request_requirements (
  id uuid primary key default gen_random_uuid(),
  care_request_id uuid not null references care_requests(id) on delete cascade,
  requirement_type text not null,   -- SKILL | LANGUAGE | CREDENTIAL | GENDER | CARE_STYLE ...
  requirement_code text not null,
  minimum_level int,
  strength pref_strength not null default 'IMPORTANT'
);
create index on care_request_requirements(care_request_id);

create table care_request_task_expectations (
  id uuid primary key default gen_random_uuid(),
  care_request_id uuid not null references care_requests(id) on delete cascade,
  expectation_key text not null,
  expectation_value text
);

-- ============================================================ matching

create table matching_weight_profiles (
  id uuid primary key default gen_random_uuid(),
  weight_version text unique not null,
  family_weights jsonb not null,
  job_weights    jsonb not null,
  mutual_family_weight numeric(4,3) not null default 0.600,
  mutual_job_weight    numeric(4,3) not null default 0.400,
  created_at timestamptz not null default now()
);

create table matching_runs (
  id uuid primary key default gen_random_uuid(),
  care_request_id uuid references care_requests(id) on delete cascade,
  caregiver_id    uuid references caregiver_profiles(id) on delete cascade, -- set for CG→job direction
  direction       text not null check (direction in ('FAMILY_TO_CAREGIVER','CAREGIVER_TO_JOB')),
  score_version   text not null,
  weight_version  text not null,
  candidate_count int not null default 0,
  runtime_ms      int,
  created_at      timestamptz not null default now()
);
create index on matching_runs(care_request_id);

create table matching_candidates (
  id uuid primary key default gen_random_uuid(),
  matching_run_id uuid not null references matching_runs(id) on delete cascade,
  care_request_id uuid not null references care_requests(id) on delete cascade,
  caregiver_id    uuid not null references caregiver_profiles(id) on delete cascade,
  eligible        boolean not null,
  failed_filters  text[] not null default '{}',
  base_family_fit numeric(6,3),
  base_job_fit    numeric(6,3),
  base_mutual_fit numeric(6,3),
  final_family_fit numeric(6,3),
  final_job_fit    numeric(6,3),
  final_mutual_fit numeric(6,3),
  distance_km      numeric(8,2),
  travel_minutes   int,
  bucket           candidate_bucket not null,
  exceptional_match boolean not null default false,
  additional_cost_estimate jsonb,
  rank_in_bucket   int,
  created_at       timestamptz not null default now()
);
create index on matching_candidates(matching_run_id, bucket, rank_in_bucket);
create index on matching_candidates(care_request_id);

-- full feature snapshot per candidate (V4 §20)
create table matching_feature_snapshots (
  id uuid primary key default gen_random_uuid(),
  matching_candidate_id uuid not null references matching_candidates(id) on delete cascade,
  feature_values jsonb not null,
  bucket_values  jsonb not null,
  hard_filter_results jsonb not null
);

-- ============================================================ interest / mutual match

create table family_interests (
  id uuid primary key default gen_random_uuid(),
  care_request_id uuid not null references care_requests(id) on delete cascade,
  caregiver_id    uuid not null references caregiver_profiles(id) on delete cascade,
  interested boolean not null,
  created_at timestamptz not null default now(),
  unique (care_request_id, caregiver_id)
);
create table caregiver_interests (
  id uuid primary key default gen_random_uuid(),
  care_request_id uuid not null references care_requests(id) on delete cascade,
  caregiver_id    uuid not null references caregiver_profiles(id) on delete cascade,
  interested boolean not null,
  accept_exceptional_distance boolean not null default false,  -- V5 §23
  created_at timestamptz not null default now(),
  unique (care_request_id, caregiver_id)
);
create table mutual_matches (
  id uuid primary key default gen_random_uuid(),
  care_request_id uuid not null references care_requests(id) on delete cascade,
  caregiver_id    uuid not null references caregiver_profiles(id) on delete cascade,
  base_mutual_fit numeric(6,3),
  final_mutual_fit numeric(6,3),
  matched_at timestamptz not null default now(),
  unique (care_request_id, caregiver_id)
);

-- ============================================================ care plan / job

create table daily_care_plans (
  id uuid primary key default gen_random_uuid(),
  care_request_id uuid not null references care_requests(id) on delete cascade,
  plan_date date not null,
  shift_start time not null,
  shift_end   time not null,
  notes text,
  status care_plan_status not null default 'DRAFT',
  created_at timestamptz not null default now()
);
create table daily_care_tasks (
  id uuid primary key default gen_random_uuid(),
  care_plan_id uuid not null references daily_care_plans(id) on delete cascade,
  task_code text not null,
  description text,
  planned_time time,
  tolerance_minutes int not null default 30,
  critical_task boolean not null default false,
  evidence_required boolean not null default false
);

create table job_requests (
  id uuid primary key default gen_random_uuid(),
  care_request_id uuid not null references care_requests(id) on delete cascade,
  caregiver_id    uuid not null references caregiver_profiles(id) on delete cascade,
  care_plan_id    uuid references daily_care_plans(id),
  initiated_by    interest_side not null default 'FAMILY',
  status          job_request_status not null default 'PENDING',
  is_exceptional_distance boolean not null default false,
  additional_cost_estimate jsonb,
  accommodation_agreed boolean not null default false,   -- V5 §26 case 8
  agreement_reasons jsonb,
  decline_reason  text,
  sent_at    timestamptz not null default now(),
  viewed_at  timestamptz,
  responded_at timestamptz
);
create index on job_requests(caregiver_id, status);

create table jobs (
  id uuid primary key default gen_random_uuid(),
  job_request_id uuid unique not null references job_requests(id) on delete cascade,
  care_request_id uuid not null references care_requests(id),
  caregiver_id uuid not null references caregiver_profiles(id),
  status job_status not null default 'SCHEDULED',
  current_state care_state not null default 'NORMAL',
  check_in_at timestamptz, check_out_at timestamptz,
  created_at timestamptz not null default now()
);

-- ============================================================ chat

create table chat_threads (
  id uuid primary key default gen_random_uuid(),
  care_request_id uuid not null references care_requests(id) on delete cascade,
  caregiver_id    uuid not null references caregiver_profiles(id) on delete cascade,
  unlocked_by text not null default 'MUTUAL_MATCH',
  created_at timestamptz not null default now(),
  unique (care_request_id, caregiver_id)
);
create table chat_messages (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references chat_threads(id) on delete cascade,
  sender_role interest_side not null,
  sender_profile_id uuid references profiles(id),
  body text not null,
  is_system boolean not null default false,
  created_at timestamptz not null default now()
);
create index on chat_messages(thread_id, created_at);

-- ============================================================ realtime monitoring

create table care_events (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references jobs(id) on delete cascade,
  event_type care_event_type not null,
  payload jsonb not null default '{}',
  event_seq bigint,                       -- for out-of-order detection (V4 §44)
  dedupe_key text,
  occurred_at timestamptz not null default now(),
  created_at  timestamptz not null default now(),
  unique (job_id, dedupe_key)
);
create index on care_events(job_id, occurred_at);

create table care_state_transitions (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references jobs(id) on delete cascade,
  from_state care_state, to_state care_state not null,
  matched_rule text not null,
  reason text,
  rule_version text not null,
  created_at timestamptz not null default now()
);
create table alerts (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references jobs(id) on delete cascade,
  alert_type text not null,
  severity care_state not null,
  message text,
  acknowledged_at timestamptz,
  timed_out boolean not null default false,
  created_at timestamptz not null default now()
);

-- ============================================================ report / review / trust

create table care_reports (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references jobs(id) on delete cascade,
  completed_tasks   jsonb not null default '[]',
  delayed_tasks     jsonb not null default '[]',
  incomplete_tasks  jsonb not null default '[]',
  incidents_reported jsonb not null default '[]',
  observations text, notes text,
  check_in  timestamptz, check_out timestamptz,
  source text not null default 'TEXT',   -- TEXT | AUDIO
  transcript text,
  confirmed boolean not null default false,
  created_at timestamptz not null default now()
);
create table report_attachments (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null references care_reports(id) on delete cascade,
  storage_path text not null, mime_type text
);

create table family_reviews (
  id uuid primary key default gen_random_uuid(),
  job_id uuid unique not null references jobs(id) on delete cascade,
  caregiver_id uuid not null references caregiver_profiles(id) on delete cascade,
  professionalism int check (professionalism between 1 and 5),
  communication   int check (communication between 1 and 5),
  punctuality     int check (punctuality between 1 and 5),
  care_plan_adherence int check (care_plan_adherence between 1 and 5),
  attentiveness   int check (attentiveness between 1 and 5),
  overall_rating  int not null check (overall_rating between 1 and 5),
  would_rebook    boolean not null default false,
  would_recommend boolean not null default false,
  review_text text,
  created_at timestamptz not null default now()
);

create table incidents (
  id uuid primary key default gen_random_uuid(),
  job_id uuid references jobs(id) on delete set null,
  caregiver_id uuid not null references caregiver_profiles(id) on delete cascade,
  description text,
  status incident_status not null default 'REPORTED',
  responsibility responsibility not null default 'UNDETERMINED',
  confirmed_by uuid references profiles(id),
  confirmed_at timestamptz,
  created_at timestamptz not null default now()
);

create table trust_score_snapshots (
  id uuid primary key default gen_random_uuid(),
  caregiver_id uuid not null references caregiver_profiles(id) on delete cascade,
  trust_score numeric(5,2) not null,
  components jsonb not null,
  trust_status trust_status not null,
  trust_version text not null,
  created_at timestamptz not null default now()
);
create index on trust_score_snapshots(caregiver_id, created_at desc);

-- ============================================================ AI logs

create table ai_conversations (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid references profiles(id) on delete cascade,
  kind text not null,           -- INTAKE | ADVISOR
  elderly_id uuid references elderly_profiles(id),
  care_request_id uuid references care_requests(id),
  created_at timestamptz not null default now()
);
create table ai_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references ai_conversations(id) on delete cascade,
  role text not null,           -- user | assistant | system
  content text not null,
  created_at timestamptz not null default now()
);
create table ai_extraction_logs (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid references ai_conversations(id) on delete cascade,
  raw_input text, extracted jsonb, missing_fields text[],
  model text, created_at timestamptz not null default now()
);
create table transcription_logs (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid references profiles(id) on delete set null,
  context text, transcript text, model text,
  duration_ms int, created_at timestamptz not null default now()
);

-- ============================================================ travel matrix (benchmark adapters)

create table travel_matrix (
  from_key text not null,
  to_key   text not null,
  seconds  int not null,
  source   text not null default 'HAVERSINE',
  primary key (from_key, to_key, source)
);

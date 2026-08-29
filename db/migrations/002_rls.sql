-- TrustCare — Row Level Security
-- Source: Master System Spec V4 §38
-- Principle: the service-role key (SUPABASE_SECRET_KEY, server only) bypasses RLS; these policies
-- protect anything reached with the publishable key. V4 §38 forbids two things explicitly:
--   * a caregiver browsing full medical profiles of all families
--   * a family reading private caregiver verification documents unnecessarily

-- helper: current profile row for the authenticated user
create or replace function current_profile_id() returns uuid
language sql stable as $$
  select id from profiles where auth_user_id = auth.uid()
$$;

create or replace function current_role_is(r user_role) returns boolean
language sql stable as $$
  select exists (select 1 from profiles where auth_user_id = auth.uid() and role = r)
$$;

create or replace function current_caregiver_id() returns uuid
language sql stable as $$
  select cp.id from caregiver_profiles cp
  join profiles p on p.id = cp.profile_id
  where p.auth_user_id = auth.uid()
$$;

-- ============================================================ enable

alter table profiles                enable row level security;
alter table elderly_profiles        enable row level security;
alter table caregiver_profiles      enable row level security;
alter table caregiver_certificates  enable row level security;
alter table care_requests           enable row level security;
alter table care_request_tasks      enable row level security;
alter table care_request_requirements enable row level security;
alter table matching_candidates     enable row level security;
alter table family_interests        enable row level security;
alter table caregiver_interests     enable row level security;
alter table mutual_matches          enable row level security;
alter table daily_care_plans        enable row level security;
alter table job_requests            enable row level security;
alter table jobs                    enable row level security;
alter table chat_threads            enable row level security;
alter table chat_messages           enable row level security;
alter table care_events             enable row level security;
alter table care_reports            enable row level security;
alter table family_reviews          enable row level security;
alter table incidents               enable row level security;
alter table trust_score_snapshots   enable row level security;

-- ============================================================ profiles

create policy profiles_self on profiles
  for all using (auth_user_id = auth.uid()) with check (auth_user_id = auth.uid());
create policy profiles_admin on profiles
  for select using (current_role_is('ADMIN'));

-- ============================================================ elderly: family only (V4 §38)

create policy elderly_own on elderly_profiles
  for all using (family_id = current_profile_id()) with check (family_id = current_profile_id());

-- Caregivers never select elderly_profiles directly. The privacy-safe summary they see
-- (V4 §23, V5 §4) is assembled server-side and exposes only: age, gender, mobility_level,
-- relevant conditions, district/province. Never: address, allergies, medical_devices,
-- emergency_contact, notes, exact coordinates.

-- ============================================================ caregiver profile

create policy caregiver_own on caregiver_profiles
  for all using (profile_id = current_profile_id()) with check (profile_id = current_profile_id());

-- families may read caregiver profiles (they are the marketplace listing) but NOT certificates
create policy caregiver_public_read on caregiver_profiles
  for select using (current_role_is('FAMILY') and verification_status = 'VERIFIED');

create policy certificates_own on caregiver_certificates
  for all using (caregiver_id = current_caregiver_id()) with check (caregiver_id = current_caregiver_id());
create policy certificates_admin on caregiver_certificates
  for select using (current_role_is('ADMIN'));
-- deliberately no family policy: V4 §38 forbids family access to verification documents

-- ============================================================ care requests (V5 §17 visibility)

create policy care_requests_family on care_requests
  for all using (family_id = current_profile_id()) with check (family_id = current_profile_id());

create policy care_requests_caregiver_discovery on care_requests
  for select using (
    current_role_is('CAREGIVER')
    and status = 'CONFIRMED'
    and (
      visibility = 'OPEN_TO_CAREGIVERS'
      -- MATCHED_ONLY: visible only if this caregiver survived hard filters for it
      or (visibility = 'MATCHED_ONLY' and exists (
            select 1 from matching_candidates mc
            where mc.care_request_id = care_requests.id
              and mc.caregiver_id = current_caregiver_id()
              and mc.eligible))
      -- PRIVATE: only if the family sent this caregiver a direct request
      or (visibility = 'PRIVATE' and exists (
            select 1 from job_requests jr
            where jr.care_request_id = care_requests.id
              and jr.caregiver_id = current_caregiver_id()))
    )
  );

create policy cr_tasks_read on care_request_tasks for select using (
  exists (select 1 from care_requests cr where cr.id = care_request_id));
create policy cr_reqs_read on care_request_requirements for select using (
  exists (select 1 from care_requests cr where cr.id = care_request_id));

-- ============================================================ matching results

create policy candidates_family on matching_candidates for select using (
  exists (select 1 from care_requests cr
          where cr.id = care_request_id and cr.family_id = current_profile_id()));
create policy candidates_caregiver on matching_candidates for select using (
  caregiver_id = current_caregiver_id());

-- ============================================================ interest / mutual

create policy fam_interest_own on family_interests for all using (
  exists (select 1 from care_requests cr
          where cr.id = care_request_id and cr.family_id = current_profile_id()));
create policy fam_interest_cg_read on family_interests for select using (
  caregiver_id = current_caregiver_id());

create policy cg_interest_own on caregiver_interests for all using (
  caregiver_id = current_caregiver_id());
create policy cg_interest_fam_read on caregiver_interests for select using (
  exists (select 1 from care_requests cr
          where cr.id = care_request_id and cr.family_id = current_profile_id()));

create policy mutual_visible on mutual_matches for select using (
  caregiver_id = current_caregiver_id()
  or exists (select 1 from care_requests cr
             where cr.id = care_request_id and cr.family_id = current_profile_id()));

-- ============================================================ care plan / job request / job

create policy care_plan_family on daily_care_plans for all using (
  exists (select 1 from care_requests cr
          where cr.id = care_request_id and cr.family_id = current_profile_id()));
-- caregiver reads the plan only once a request exists for them (V4 §38: accepted job care plans)
create policy care_plan_caregiver on daily_care_plans for select using (
  exists (select 1 from job_requests jr
          where jr.care_request_id = daily_care_plans.care_request_id
            and jr.caregiver_id = current_caregiver_id()));

create policy job_requests_caregiver on job_requests for all using (
  caregiver_id = current_caregiver_id());
create policy job_requests_family on job_requests for all using (
  exists (select 1 from care_requests cr
          where cr.id = care_request_id and cr.family_id = current_profile_id()));

create policy jobs_party on jobs for all using (
  caregiver_id = current_caregiver_id()
  or exists (select 1 from care_requests cr
             where cr.id = care_request_id and cr.family_id = current_profile_id()));

-- ============================================================ chat (V4 §24 gate)

create policy chat_thread_party on chat_threads for all using (
  caregiver_id = current_caregiver_id()
  or exists (select 1 from care_requests cr
             where cr.id = care_request_id and cr.family_id = current_profile_id()));

create policy chat_msg_party on chat_messages for all using (
  exists (select 1 from chat_threads t where t.id = thread_id));

-- ============================================================ events / reports / reviews

create policy events_party on care_events for all using (
  exists (select 1 from jobs j where j.id = job_id));
create policy reports_party on care_reports for all using (
  exists (select 1 from jobs j where j.id = job_id));

create policy review_family_write on family_reviews for all using (
  exists (select 1 from jobs j join care_requests cr on cr.id = j.care_request_id
          where j.id = job_id and cr.family_id = current_profile_id()));
create policy review_caregiver_read on family_reviews for select using (
  caregiver_id = current_caregiver_id());

-- ============================================================ incidents / trust: admin decides

create policy incidents_admin on incidents for all using (current_role_is('ADMIN'));
create policy incidents_caregiver_read on incidents for select using (
  caregiver_id = current_caregiver_id());

create policy trust_read on trust_score_snapshots for select using (
  caregiver_id = current_caregiver_id() or current_role_is('FAMILY') or current_role_is('ADMIN'));

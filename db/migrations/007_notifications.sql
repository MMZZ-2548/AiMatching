-- Notifications (V5 §29).
--
-- Thirteen event types, seven addressed to a family and six to a caregiver. The recipient is
-- stored as a type plus an id rather than a single foreign key, because the two sides live in
-- different tables (profiles for a family, caregiver_profiles for a caregiver).
--
-- Every row carries the ids it refers to, so a client can navigate straight to the thing that
-- happened instead of having to search for it.

create type notification_recipient as enum ('FAMILY', 'CAREGIVER');

create type notification_type as enum (
  -- to the family
  'CAREGIVER_INTERESTED',
  'CAREGIVER_ACCEPTED',
  'CAREGIVER_DECLINED',
  'NEW_EXCEPTIONAL_CANDIDATE',
  'CHAT_MESSAGE_FROM_CAREGIVER',
  'CARE_PLAN_REQUIRED',
  'DAILY_REPORT_READY',
  -- to the caregiver
  'NEW_MATCHING_JOB',
  'FAMILY_INTERESTED',
  'DIRECT_JOB_REQUEST',
  'EXCEPTIONAL_DISTANCE_REQUEST',
  'CHAT_MESSAGE_FROM_FAMILY',
  'JOB_SCHEDULED'
);

create table notifications (
  id                uuid primary key default gen_random_uuid(),
  recipient_type    notification_recipient not null,
  recipient_id      uuid not null,
  type              notification_type not null,
  title             text not null,
  body              text,
  -- what it is about; any of these may be null depending on the type
  care_request_id   uuid references care_requests(id) on delete cascade,
  caregiver_id      uuid references caregiver_profiles(id) on delete cascade,
  job_request_id    uuid references job_requests(id) on delete cascade,
  job_id            uuid references jobs(id) on delete cascade,
  chat_thread_id    uuid references chat_threads(id) on delete cascade,
  data              jsonb not null default '{}',
  read_at           timestamptz,
  created_at        timestamptz not null default now()
);

create index notifications_recipient_idx on notifications(recipient_type, recipient_id, created_at desc);
create index notifications_unread_idx on notifications(recipient_type, recipient_id) where read_at is null;

alter table notifications enable row level security;

-- A family reads what was addressed to them; a caregiver reads what was addressed to them.
create policy notifications_family on notifications
  for select using (recipient_type = 'FAMILY' and recipient_id = current_profile_id());
create policy notifications_caregiver on notifications
  for select using (recipient_type = 'CAREGIVER' and recipient_id = current_caregiver_id());

-- Marking as read is the only field either side may change.
create policy notifications_family_read on notifications
  for update using (recipient_type = 'FAMILY' and recipient_id = current_profile_id());
create policy notifications_caregiver_read on notifications
  for update using (recipient_type = 'CAREGIVER' and recipient_id = current_caregiver_id());

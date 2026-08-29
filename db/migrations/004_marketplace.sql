-- Columns the two-sided marketplace needs.
--
-- A caregiver applying to a job writes a short message with the application, the same way a family
-- can attach a note to a job request. Without somewhere to keep it the application is anonymous.

alter table caregiver_interests add column if not exists message text;
alter table family_interests   add column if not exists message text;

-- Job requests can now originate from either side, so record which.
alter table job_requests add column if not exists origin text default 'FAMILY';

-- Care plan lines carry the family's own wording, not just a task code.
alter table daily_care_tasks add column if not exists spoken_time text;

-- The advisor conversation is tied to whoever was on screen.
alter table ai_conversations add column if not exists screen text;

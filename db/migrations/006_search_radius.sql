-- How far the family is willing to look.
--
-- Until now the only radius in the system belonged to the caregiver ("how far I will travel").
-- The family has the opposite question — "how far am I willing to look, and am I willing to pay
-- for the distance" — and it is a different number. Default 25 km matches the caregiver default so
-- existing requests behave unchanged.

alter table care_requests add column if not exists search_radius_km numeric(6,2) not null default 25;

-- Which of the two offers the family chose to pursue, so the decision is recorded rather than
-- inferred from whoever they happened to contact.
alter table care_requests add column if not exists distance_choice text;

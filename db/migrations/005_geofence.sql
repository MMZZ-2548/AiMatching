-- Geofence radius for the care location.
--
-- The monitoring rules already emit GEOFENCE_EXIT / GEOFENCE_ENTER (V4 §31); until now there was
-- no radius stored to draw or evaluate them against. Default 150 m: large enough to cover a house
-- and its yard without firing every time someone steps outside the door.

alter table care_requests add column if not exists geofence_radius_m int not null default 150;

-- Where the caregiver started from, so the job map can show both ends of the trip.
alter table jobs add column if not exists last_latitude double precision;
alter table jobs add column if not exists last_longitude double precision;

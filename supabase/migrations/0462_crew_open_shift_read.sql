-- 0462_crew_open_shift_read.sql
-- A13 People and Crew (ADR 0022 range 0460 to 0469). Members who may read shifts at any reach, Field
-- members included, see the published open shifts of their org so they can claim them (journey 66).
-- Drafts, canceled and assigned shifts of other people stay hidden. The policy reads only the row's
-- own columns (ADR 0016 item 14).

create policy shifts_open_read on app.shifts for select to authenticated
  using (membership_id is null and shift_state = 'Published' and deleted_at is null
         and private.capability_reach(org_id, 'crew.shift.read') is not null);

comment on policy shifts_open_read on app.shifts is 'Published open shifts are visible to every member who may read shifts at any reach, so crew can claim them.';

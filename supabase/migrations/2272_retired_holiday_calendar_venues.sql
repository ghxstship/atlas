-- 2272_retired_holiday_calendar_venues.sql
--
-- A134 (RRR-196), trace S4.5.6-26, ADR 0112. Retiring a holiday calendar ends its venue assignments with it. Until now
-- only app.holiday_calendars.deleted_at was set, so the calendar's live rows in app.holiday_calendar_venues still held
-- their venues under holiday_calendar_venues_venue_key: pay already skipped the retired calendar
-- (private.project_holiday_calendar_id reads only live calendars), but no other calendar could take those venues, and
-- the retired calendar, no longer listed, could not release them. Restoring the calendar from Trash leaves its venues
-- unassigned; they are assigned again, as a venue assignment, with no title, never goes to Trash itself (2270).

create or replace function private.end_retired_holiday_calendar_venues()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.deleted_at is not null and old.deleted_at is null then
    update app.holiday_calendar_venues a set deleted_at = new.deleted_at
    where a.holiday_calendar_id = new.id and a.deleted_at is null;
  end if;
  return null;
end;
$$;

comment on function private.end_retired_holiday_calendar_venues() is 'After update trigger on holiday_calendars: when a calendar is retired, its live venue assignments end at the same time, so those venues can take another calendar.';
revoke all on function private.end_retired_holiday_calendar_venues() from public, anon, authenticated;

create trigger t60_end_retired_holiday_calendar_venues after update of deleted_at on app.holiday_calendars
  for each row execute function private.end_retired_holiday_calendar_venues();

-- Assignments already held by a retired calendar end now.
update app.holiday_calendar_venues a set deleted_at = c.deleted_at
from app.holiday_calendars c
where c.id = a.holiday_calendar_id and c.deleted_at is not null and a.deleted_at is null;

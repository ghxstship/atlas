-- 2634_roster_self_entries.sql
-- R4 Crew roster core (RRR-182, ADR 0101 decision 7). Every engagement that names a person carries that person's own
-- roster entry, Accepted by both sides, so roster-aware reads (R5, R7, R8) treat the engaged person and the people a
-- party rosters alike. Client and Sponsor engagements carry none. The entry's person_id stays NULL: private.roster_people
-- resolves it from app.engagements.person_id, so a change of the engagement's person follows without a copy.

create or replace function private.ensure_self_roster_entry()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.deleted_at is not null or new.person_id is null or new.role_type in ('Client', 'Sponsor') then
    return null;
  end if;
  if exists (select 1 from app.engagement_roster_entries r where r.engagement_id = new.id and r.is_self and r.deleted_at is null) then
    return null;
  end if;
  perform private.begin_trusted_operation('roster_self_entry');
  perform private.begin_trusted_operation('roster_entry_transition');
  insert into app.engagement_roster_entries (engagement_id, is_self, entry_state, person_response, responded_at)
  values (new.id, true, 'Accepted', 'Accepted', now());
  perform private.end_trusted_operation('roster_entry_transition');
  perform private.end_trusted_operation('roster_self_entry');
  return null;
end;
$$;

comment on function private.ensure_self_roster_entry() is 'After an engagement is created or its person set: creates the engaged person''s own roster entry (is_self, Accepted by both sides) when the engagement names a person, is not Client or Sponsor and has none.';
revoke all on function private.ensure_self_roster_entry() from public, anon, authenticated;

create trigger t81_ensure_self_roster_entry after insert or update of person_id on app.engagements
  for each row execute function private.ensure_self_roster_entry();

-- Backfill: every live engagement that names a person and is still open.
do $$
begin
  perform private.begin_trusted_operation('roster_self_entry');
  perform private.begin_trusted_operation('roster_entry_transition');
  insert into app.engagement_roster_entries (engagement_id, is_self, entry_state, person_response, responded_at)
  select e.id, true, 'Accepted', 'Accepted', now()
  from app.engagements e
  where e.deleted_at is null and e.person_id is not null and e.role_type not in ('Client', 'Sponsor')
    and e.engagement_state in ('Onboarding', 'Blocked', 'Active', 'Closing')
    and not exists (select 1 from app.engagement_roster_entries r where r.engagement_id = e.id and r.is_self and r.deleted_at is null);
  perform private.end_trusted_operation('roster_entry_transition');
  perform private.end_trusted_operation('roster_self_entry');
end $$;

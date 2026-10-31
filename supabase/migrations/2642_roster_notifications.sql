-- 2642_roster_notifications.sql
-- R4 Crew roster core (RRR-182, ADR 0100 section 6). Three notification kinds, seeded by 2649:
--   * roster_entry.invited (assignments): a person is put on a roster, or claims an invitation, to the person;
--   * roster_entry.returned (approvals): a reviewer returns an entry, with the reason, to the roster's managers;
--   * roster_entry.declined (assignments): the person declines, to the roster's managers.
-- The managers' two open the engagement's Crew tab in Gateway (gatewayPath); the person's opens Gateway Home, where
-- they answer.
-- Each goes through private.notify in the producing org, with the entry as its subject and the names to show; a rostered
-- person is an external party of the org through 2641.

create or replace function private.roster_notification_args(p_roster_entry_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'personName', coalesce(rp.full_name, ''),
    'partyName', coalesce(a.name, ep.full_name, ''),
    'projectName', p.name,
    'orgName', o.name)
  from app.engagement_roster_entries r
  join app.engagements e on e.id = r.engagement_id
  join app.projects p on p.id = e.project_id
  join app.organizations o on o.id = e.org_id
  left join app.counterparties c on c.id = e.counterparty_id
  left join app.organizations a on a.id = c.organization_id
  left join app.people ep on ep.id = e.person_id
  left join app.people rp on rp.id = private.roster_entry_person_id(r.is_self, r.person_id, e.person_id)
  where r.id = p_roster_entry_id;
$$;

comment on function private.roster_notification_args(uuid) is 'The names a roster notification shows: the person, the party, the project and the producing org.';
revoke all on function private.roster_notification_args(uuid) from public, anon, authenticated;

create or replace function private.roster_crew_path(p_engagement_id uuid)
returns text
language sql
immutable
set search_path = ''
as $$
  select '/work/engagements/' || private.gateway_display_key('ENG', p_engagement_id) || '/crew';
$$;

comment on function private.roster_crew_path(uuid) is 'The Gateway path of an engagement''s Crew tab, where a roster manager''s notification opens.';
revoke all on function private.roster_crew_path(uuid) from public, anon, authenticated;

create or replace function private.notify_roster_entry_person()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_project uuid := (select e.project_id from app.engagements e where e.id = new.engagement_id);
begin
  if new.is_self or new.person_id is null or new.deleted_at is not null
     or (tg_op = 'UPDATE' and old.person_id is not distinct from new.person_id) then
    return null;
  end if;
  -- Adding oneself, or claiming one's own invitation, is not news to oneself.
  if new.person_id = private.current_person_id() then
    return null;
  end if;
  perform private.notify(new.org_id, new.person_id, 'roster_entry.invited', 'engagement_roster_entries', new.id, v_project,
    private.roster_notification_args(new.id));
  return null;
end;
$$;

comment on function private.notify_roster_entry_person() is 'After a roster entry gets its person (added from the team, or an invitation claimed): sends roster_entry.invited to the person, unless they added themselves or claimed the invitation themselves.';
revoke all on function private.notify_roster_entry_person() from public, anon, authenticated;

create trigger t97_notify_roster_entry_person after insert or update of person_id on app.engagement_roster_entries
  for each row execute function private.notify_roster_entry_person();

create or replace function private.notify_roster_entry_returned()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_entry app.engagement_roster_entries;
  v_project uuid;
  v_person uuid;
begin
  if new.to_state <> 'Returned' then
    return null;
  end if;
  select * into v_entry from app.engagement_roster_entries r where r.id = new.roster_entry_id;
  select e.project_id into v_project from app.engagements e where e.id = v_entry.engagement_id;
  for v_person in select m from private.roster_manager_ids(v_entry.engagement_id) m loop
    perform private.notify(v_entry.org_id, v_person, 'roster_entry.returned', 'engagement_roster_entries', v_entry.id, v_project,
      private.roster_notification_args(v_entry.id) || jsonb_build_object('reason', new.reason,
        'gatewayPath', private.roster_crew_path(v_entry.engagement_id)));
  end loop;
  return null;
end;
$$;

comment on function private.notify_roster_entry_returned() is 'After a roster entry is returned: sends roster_entry.returned, with the reason, to every manager of the engagement''s roster (private.roster_manager_ids).';
revoke all on function private.notify_roster_entry_returned() from public, anon, authenticated;

create trigger t97_notify_roster_entry_returned after insert on app.roster_entry_state_transitions
  for each row execute function private.notify_roster_entry_returned();

create or replace function private.notify_roster_entry_declined()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_project uuid := (select e.project_id from app.engagements e where e.id = new.engagement_id);
  v_person uuid;
begin
  if new.person_response <> 'Declined' or old.person_response = 'Declined' then
    return null;
  end if;
  for v_person in select m from private.roster_manager_ids(new.engagement_id) m loop
    perform private.notify(new.org_id, v_person, 'roster_entry.declined', 'engagement_roster_entries', new.id, v_project,
      private.roster_notification_args(new.id) || jsonb_build_object('gatewayPath', private.roster_crew_path(new.engagement_id)));
  end loop;
  return null;
end;
$$;

comment on function private.notify_roster_entry_declined() is 'After the person declines a roster entry: sends roster_entry.declined to every manager of the engagement''s roster.';
revoke all on function private.notify_roster_entry_declined() from public, anon, authenticated;

create trigger t97_notify_roster_entry_declined after update of person_response on app.engagement_roster_entries
  for each row execute function private.notify_roster_entry_declined();

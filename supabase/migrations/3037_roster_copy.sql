-- 3037_roster_copy.sql
-- B14 Event types and project setup (RRR-238; parity gap G-252; ADR 0153 decision D4; ADR 0101; block 3030 to 3039).
-- Reusing a roster from a past event, on the party's side in Gateway. The roster belongs to the party (ADR 0101; owner
-- decisions 0, 1 and 4), so the org never copies it: only someone who manages both rosters reuses one, and every reused
-- entry is a Draft the manager still submits, the org still reviews (sod_roster_reviewer) and each person still accepts.
--
--   * app.roster_copy_sources: the caller's other live rosterable engagements with the same producing org that they
--     manage, supplied by the same account (or, for an Artist, the same person), newest first, at most 20.
--   * app.copy_roster_from_engagement previews and commits the same rows. A known person who belongs to the team gets a
--     Draft entry with person_response Pending (accepted only when the person is the caller, as app.add_roster_entry
--     does); an unclaimed invitation is issued again to its address, which queues one email (1382) as
--     app.invite_to_roster does. Arrival windows move by the difference of the projects' first show days on the wall
--     clock of each entry's arrival zone, else the target project's; with either date unknown they are left out
--     (window_dropped). A preview runs inside a BEGIN ... EXCEPTION block that the sentinel XB001 rolls back, so it
--     writes nothing and queues no email.
--   * Two definitions the stacked branches overwrote are restored as their union, because B14 is where they first meet
--     (ADR 0153 Consequences): private.party_org_ids keeps R4's roster entries (2641) and A127's open offers (2200), and
--     api_external.engagement_up_next keeps R8's roster readers (2701) and P2's next_call_tbc (2790).
-- Consent (account_roster_sharing) follows R4 unchanged. No new table or view is created.

-- What the stacked branches overwrote ------------------------------------------------------------------------------------

create or replace function private.party_org_ids(p_person_id uuid)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select e.org_id from app.engagements e
  where e.person_id = p_person_id and e.deleted_at is null
  union
  select c.org_id from app.counterparties c
  join app.account_memberships m on m.org_id = c.organization_id and m.person_id = p_person_id and m.deleted_at is null
    and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now())
  where c.deleted_at is null
  union
  select r.org_id from app.engagement_roster_entries r
  where r.person_id = p_person_id and r.deleted_at is null and r.entry_state <> 'Withdrawn'
  union
  select a.org_id from app.applications a
  join app.offers o on o.application_id = a.id and o.deleted_at is null and o.offer_state in ('Sent', 'Countered')
  where a.applicant_person_id = p_person_id and a.deleted_at is null;
$$;

comment on function private.party_org_ids(uuid) is 'Orgs a person works with as an external party: through an engagement of their own, an active membership in an external account the org holds as a counterparty, a live roster entry on one of the org''s engagements (R4), or an application of their own with an offer still open (A127), so the offer''s notices reach them.';
revoke all on function private.party_org_ids(uuid) from public, anon, authenticated;

create or replace view api_external.engagement_up_next as
select e.id as engagement_id, e.project_id,
  v.name as venue_name, v.street_address as venue_street_address, v.locality as venue_locality, v.postal_code as venue_postal_code,
  case when exists (
    select 1 from app.memberships m
    where m.person_id = e.created_by and m.org_id = e.org_id and m.deleted_at is null
      and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now()))
  then cp.full_name end as contact_name,
  n.starts_at as next_call_at, n.time_zone as next_call_time_zone, n.call_kind as next_call_kind,
  n.start_tbc as next_call_tbc
from app.engagements e
join app.projects p on p.id = e.project_id
left join app.venues v on v.id = p.venue_id and v.deleted_at is null
left join app.people cp on cp.id = e.created_by
cross join lateral (select array(select s from private.engagement_scope(e.id) s) as areas) a
left join lateral (
  select x.starts_at, x.time_zone, x.call_kind, x.start_tbc
  from (
    select s.starts_at, s.time_zone, 'Shift'::text as call_kind, false as start_tbc
    from app.shifts s
    where s.engagement_id = e.id and s.deleted_at is null and s.shift_state in ('Published', 'Accepted') and s.starts_at > now()
    union all
    select d.starts_at, p.time_zone, 'Dock Slot'::text, false
    from app.dock_slots d
    where d.engagement_id = e.id and d.deleted_at is null and d.checked_in_at is null and d.starts_at > now()
    union all
    select c.planned_at, p.time_zone, 'Set'::text, c.start_tbc
    from app.engagement_cues ec
    join app.cues c on c.id = ec.cue_id and c.deleted_at is null
    join app.run_of_show r on r.id = c.run_of_show_id and r.deleted_at is null
    where ec.engagement_id = e.id and ec.deleted_at is null and c.planned_at > now() and c.called_at is null
  ) x
  where 'operational' = any (a.areas)
  order by x.starts_at
  limit 1
) n on true
where e.deleted_at is null
  and (e.id in (select private.my_engagement_ids('engagement'))
    or e.id in (select r.engagement_id from app.engagement_roster_entries r where r.id in (select private.my_roster_entry_ids('roster'))));

comment on view api_external.engagement_up_next is 'What Gateway Home''s Up Next card shows for the caller''s engagements (Section 4.4.4): the project''s venue, the org member who set up the engagement while they still belong to the org, and, while the operational area is open, the next call: a Published or Accepted shift, a dock slot not yet checked in or a set cue not yet called. A person on a roster reads the venue and the contact of their entries'' engagements; the party''s calls stay the party''s (R8).';
comment on column api_external.engagement_up_next.next_call_tbc is 'True when the next call is a set whose time is an estimate to be confirmed: show TBC, not the time. False for shifts and dock slots, and NULL when there is no next call.';

revoke all on api_external.engagement_up_next from public, anon;
grant select on api_external.engagement_up_next to authenticated, service_role;

-- Reusing a roster --------------------------------------------------------------------------------------------------------

create or replace function app.roster_copy_sources(p_engagement_id uuid)
returns table (
  engagement_id uuid,
  project_id uuid,
  project_name text,
  starts_on date,
  entries integer,
  invitations integer
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_target app.engagements;
  v_account uuid;
begin
  perform private.require_person();
  if not private.can_manage_roster(p_engagement_id) then
    raise exception using errcode = '42501', message = 'only the people who manage this engagement''s roster may reuse one';
  end if;
  select * into v_target from app.engagements e where e.id = p_engagement_id;
  select c.organization_id into v_account from app.counterparties c where c.id = v_target.counterparty_id;
  return query
  select e.id, p.id, p.name, p.starts_on,
    (select count(*)::integer from app.engagement_roster_entries r
     where r.engagement_id = e.id and r.deleted_at is null and not r.is_self and r.entry_state <> 'Withdrawn'),
    (select count(*)::integer from app.engagement_roster_entries r
     where r.engagement_id = e.id and r.deleted_at is null and not r.is_self and r.entry_state <> 'Withdrawn' and r.person_id is null)
  from app.engagements e
  join app.projects p on p.id = e.project_id and p.deleted_at is null
  left join app.counterparties c on c.id = e.counterparty_id
  where e.org_id = v_target.org_id and e.id <> v_target.id and e.deleted_at is null
    and e.role_type = v_target.role_type
    and ((v_account is not null and c.organization_id = v_account)
         or (v_target.role_type = 'Artist' and v_target.person_id is not null and e.person_id = v_target.person_id))
    and private.can_manage_roster(e.id)
  order by p.starts_on desc nulls last, e.created_at desc, e.id
  limit 20;
end;
$$;

comment on function app.roster_copy_sources(uuid) is 'Engagements whose roster can be reused on an engagement (G-252, ADR 0153 D4): the caller''s other live rosterable engagements of the same role with the same producing org that they manage (private.can_manage_roster), supplied by the same account or, for an Artist, naming the same person; newest first by the project''s first show day, at most 20, each with its live entries and its unclaimed invitations. Needs private.can_manage_roster on the engagement (42501).';
revoke all on function app.roster_copy_sources(uuid) from public, anon;
grant execute on function app.roster_copy_sources(uuid) to authenticated, service_role;

create or replace function app.copy_roster_from_engagement(
  p_engagement_id uuid,
  p_source_engagement_id uuid,
  p_commit boolean default false
)
returns table (
  source_entry_id uuid,
  label text,
  outcome text,
  skip_reason text,
  arrival_window tstzrange
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_me uuid := private.require_person();
  v_target app.engagements;
  v_source app.engagements;
  v_target_project app.projects;
  v_source_project app.projects;
  v_offset integer;
  v_rows jsonb := '[]'::jsonb;
  v_window tstzrange;
  v_zone_from text;
  v_zone_to text;
  v_dropped boolean;
  v_email text;
  v_entry uuid;
  r record;
begin
  select * into v_target from app.engagements e where e.id = p_engagement_id and e.deleted_at is null;
  perform private.assert_roster_manager(v_target);
  if private.roster_locked(v_target.id) then
    perform private.refuse('roster_locked', 'Names are locked on this engagement. Ask the producing organization to change the roster.');
  end if;
  select * into v_source from app.engagements e where e.id = p_source_engagement_id and e.deleted_at is null;
  if v_source.id is null or not private.can_manage_roster(v_source.id) then
    raise exception using errcode = '42501', message = 'only the people who manage both rosters may reuse one';
  end if;
  if not exists (select 1 from app.roster_copy_sources(v_target.id) x where x.engagement_id = v_source.id) then
    perform private.refuse('roster_copy_source', 'Reuse a roster of the same company or artist with the same organization.');
  end if;
  select * into v_target_project from app.projects p where p.id = v_target.project_id;
  select * into v_source_project from app.projects p where p.id = v_source.project_id;
  v_offset := v_target_project.starts_on - v_source_project.starts_on;

  begin
    for r in
      select x.id, x.person_id, x.role_code, x.arrival_window, x.arrival_time_zone, pe.full_name,
        (select i.email from app.roster_invitations i where i.roster_entry_id = x.id and i.deleted_at is null
         order by i.created_at desc, i.id desc limit 1) as last_email
      from app.engagement_roster_entries x
      left join app.people pe on pe.id = x.person_id
      where x.engagement_id = v_source.id and x.deleted_at is null and not x.is_self and x.entry_state <> 'Withdrawn'
      order by x.created_at, x.id
    loop
      v_dropped := r.arrival_window is not null and v_offset is null;
      v_window := null;
      if r.arrival_window is not null and v_offset is not null then
        v_zone_from := coalesce(r.arrival_time_zone, v_source_project.time_zone);
        v_zone_to := coalesce(r.arrival_time_zone, v_target_project.time_zone);
        v_window := tstzrange(private.shift_wall_clock(lower(r.arrival_window), v_offset, v_zone_from, v_zone_to),
          private.shift_wall_clock(upper(r.arrival_window), v_offset, v_zone_from, v_zone_to), '[)');
      end if;
      if r.person_id is not null then
        if r.person_id = v_target.person_id then
          v_rows := v_rows || jsonb_build_array(jsonb_build_object('source_entry_id', r.id, 'label', r.full_name,
            'outcome', 'skip', 'skip_reason', 'roster_person_is_engaged'));
        elsif exists (select 1 from app.engagement_roster_entries t
                      where t.engagement_id = v_target.id and t.person_id = r.person_id and t.deleted_at is null
                        and t.entry_state <> 'Withdrawn') then
          v_rows := v_rows || jsonb_build_array(jsonb_build_object('source_entry_id', r.id, 'label', r.full_name,
            'outcome', 'skip', 'skip_reason', 'already_on_roster'));
        elsif not private.roster_talent_eligible(v_target.id, r.person_id) then
          v_rows := v_rows || jsonb_build_array(jsonb_build_object('source_entry_id', r.id, 'label', r.full_name,
            'outcome', 'skip', 'skip_reason', 'not_in_team'));
        else
          perform private.insert_roster_entry(v_target.id, r.person_id, r.role_code, v_window,
            case when v_window is not null then r.arrival_time_zone end, null, r.person_id = v_me);
          v_rows := v_rows || jsonb_build_array(jsonb_build_object('source_entry_id', r.id, 'label', r.full_name,
            'outcome', 'copy', 'skip_reason', case when v_dropped then 'window_dropped' end, 'arrival_window', v_window));
        end if;
      elsif r.last_email is not null then
        v_email := r.last_email;
        if exists (
            select 1 from app.roster_invitations i join app.engagement_roster_entries t on t.id = i.roster_entry_id
            where t.engagement_id = v_target.id and t.deleted_at is null and t.entry_state <> 'Withdrawn' and i.email = v_email
              and i.claimed_at is null and i.declined_at is null and i.revoked_at is null and i.deleted_at is null) then
          v_rows := v_rows || jsonb_build_array(jsonb_build_object('source_entry_id', r.id, 'label', v_email,
            'outcome', 'skip', 'skip_reason', 'already_invited'));
        else
          v_entry := private.insert_roster_entry(v_target.id, null, r.role_code, v_window,
            case when v_window is not null then r.arrival_time_zone end, null, false);
          perform private.issue_roster_invitation(v_entry, v_email, interval '14 days');
          v_rows := v_rows || jsonb_build_array(jsonb_build_object('source_entry_id', r.id, 'label', v_email,
            'outcome', 'invite', 'skip_reason', case when v_dropped then 'window_dropped' end, 'arrival_window', v_window));
        end if;
      end if;
    end loop;
    if not coalesce(p_commit, false) then
      raise exception using errcode = 'XB001', message = 'roster copy preview undone';
    end if;
  exception when sqlstate 'XB001' then
    null;
  end;

  return query
  select (e.value ->> 'source_entry_id')::uuid, e.value ->> 'label', e.value ->> 'outcome', e.value ->> 'skip_reason',
    (e.value ->> 'arrival_window')::tstzrange
  from jsonb_array_elements(v_rows) with ordinality e (value, ord)
  order by e.ord;
end;
$$;

comment on function app.copy_roster_from_engagement(uuid, uuid, boolean) is 'Reuses the roster of a past engagement on an engagement (G-252, ADR 0153 D4), on the party''s side: for each live entry of the source that is not its self entry or Withdrawn, a person who belongs to the team (private.roster_talent_eligible) gets a Draft entry with person_response Pending, accepted only when the person is the caller (outcome copy); an unclaimed invitation is issued again to its latest address for 14 days, queuing one email (outcome invite); and the rest are skipped (roster_person_is_engaged, already_on_roster, not_in_team, already_invited). Arrival windows move by the difference of the projects'' starts_on on the wall clock of the entry''s arrival zone, else the target project''s; with either date unknown they are left out (window_dropped). Nothing is submitted. Needs the roster manager of both engagements (private.assert_roster_manager, roster_closed; 42501) and refuses a locked target (roster_locked) and a source app.roster_copy_sources does not list (roster_copy_source). Preview (p_commit false) writes nothing and queues no email, and returns the rows a commit returns.';
revoke all on function app.copy_roster_from_engagement(uuid, uuid, boolean) from public, anon;
grant execute on function app.copy_roster_from_engagement(uuid, uuid, boolean) to authenticated, service_role;

-- 2988_stacked_numbering_repairs.sql
-- B9 (RRR-233). A repair for this branch's stacked base only. On it A127's 2200 runs before R4's 2641 and R12's 2750, so
-- their later definitions drop what A127 added: the open-offer clause of private.party_org_ids (an applicant then gets no
-- offer.sent) and shiftState in private.notify_shift_change (a push then cannot tell a shift still Published). Both are
-- restated here with every clause, as batch-c's 5200 already does, where A127 runs after R4 and R12.
-- TRAIN NOTE: drop this file when B9 joins a merge train; there the renumbered A127 already carries both.

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

create or replace function private.notify_shift_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_worker uuid;
  v_kind text;
begin
  if new.deleted_at is not null or new.shift_state not in ('Published', 'Accepted') or new.ends_at <= now() then
    return null;
  end if;
  v_worker := private.shift_worker_person_id(new.membership_id, new.engagement_id, new.roster_entry_id);
  if v_worker is null or v_worker is not distinct from private.current_person_id() then
    return null;
  end if;
  if old.shift_state not in ('Published', 'Accepted')
     or v_worker is distinct from private.shift_worker_person_id(old.membership_id, old.engagement_id, old.roster_entry_id) then
    v_kind := 'shift.assigned';
  elsif new.starts_at is distinct from old.starts_at or new.ends_at is distinct from old.ends_at then
    v_kind := 'shift.changed';
  else
    return null;
  end if;
  perform private.notify(new.org_id, v_worker, v_kind, 'app.shifts', new.id, new.project_id,
    jsonb_build_object('title', private.shift_notification_title(new.id),
      'startsAt', to_char(new.starts_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
      'endsAt', to_char(new.ends_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
      'shiftState', new.shift_state::text));
  return null;
end;
$$;

comment on function private.notify_shift_change() is 'Tells a shift''s worker about it (1394): shift.assigned when a shift is published with them or a published or accepted shift becomes theirs (a reassignment, an approved swap, an approved claim or an agency placing its roster staff, R12), shift.changed when a published or accepted shift''s times move. Arguments: title, startsAt and endsAt as ISO instants, so a change to a shift starting within 12 hours bypasses quiet hours, and shiftState (A127), so a push offers Accept and Decline only on a shift still Published. Draft, canceled, deleted and finished shifts tell nobody, nor does a person''s own act, such as claiming an open shift first-come. An agency slot tells nobody until it is assigned.';
revoke all on function private.notify_shift_change() from public, anon, authenticated;

-- 2641_party_org_ids_roster.sql
-- R4 Crew roster core (RRR-182). private.party_org_ids (recreated from its only definition, 1131) also returns the orgs
-- where the person holds a live, non-withdrawn roster entry, so private.notify reaches a rostered person who has no
-- engagement or account membership of their own with the producing org, and they read those notifications in Gateway.

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
  where r.person_id = p_person_id and r.deleted_at is null and r.entry_state <> 'Withdrawn';
$$;

comment on function private.party_org_ids(uuid) is 'Orgs a person works with as an external party: through an engagement of their own, an active membership in an external account the org holds as a counterparty, or a live roster entry on one of the org''s engagements (R4).';
revoke all on function private.party_org_ids(uuid) from public, anon, authenticated;

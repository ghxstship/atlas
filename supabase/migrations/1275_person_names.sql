-- 1275_person_names.sql
-- A61 (finding A59-011): one name resolution for people across Atlas. app.people rows are readable only
-- for the signed-in person and members of the reader's orgs (private.visible_person_ids), so lists that
-- join an external person (Offers, Credentials, Scan Log, Certifications, record owners, Inbox actors)
-- showed "Unnamed person" while Pipeline, which reads app.engagement_board, named the same person.
--
-- app.person_names returns the display name, and nothing else, of each requested person the reader may
-- know by name:
--   * anyone private.visible_person_ids already shows (the reader and members of the reader's orgs), and
--   * an external person in the network of one of the reader's orgs (Section 4.8.3 Network): engaged by
--     the org, applied to one of its opportunities (the application shares the profile with the org), or
--     holding a credential or certification the org recorded.
-- Contact details stay on their own homes and follow their own rules; this reads full_name only.

create or replace function app.person_names(p_person_ids uuid[])
returns table (person_id uuid, full_name text)
language sql
stable
security definer
set search_path = ''
as $$
  select p.id, p.full_name
  from app.people p
  where p.id = any (p_person_ids)
    and p.deleted_at is null
    and (
      p.id in (select private.visible_person_ids())
      or exists (
        select 1 from app.engagements e
        where e.person_id = p.id and e.deleted_at is null and e.org_id in (select private.my_org_ids()))
      or exists (
        select 1 from app.applications a
        where a.applicant_person_id = p.id and a.deleted_at is null and a.org_id in (select private.my_org_ids()))
      or exists (
        select 1 from app.credentials c
        where c.holder_person_id = p.id and c.deleted_at is null and c.org_id in (select private.my_org_ids()))
      or exists (
        select 1 from app.certification_holders h
        where h.person_id = p.id and h.deleted_at is null and h.org_id in (select private.my_org_ids()))
    );
$$;

comment on function app.person_names(uuid[]) is 'Display names of the requested people the reader may know by name: members of the reader''s orgs, and people those orgs engage, received an application from, or recorded a credential or certification for (Section 4.8.3 Network). Returns full_name only.';

revoke all on function app.person_names(uuid[]) from public, anon;
grant execute on function app.person_names(uuid[]) to authenticated, service_role;

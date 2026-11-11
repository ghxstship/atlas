-- Demo seed (RRR-248, ADR 0156): the demo people have answered what Compass asks at first sign-in, so the journeys that
-- sign in as them start on their own screens. A throwaway account walks the questions themselves
-- (apps/compass/.maestro/flows/first-sign-in-acceptance.yaml). No demo person has an AI choice: Compass asks when one
-- first uses an AI feature.
do $$
begin
  insert into private.age_confirmations (person_id, user_id, minimum_age, surface)
  select p.id, p.user_id, 18, 'Compass' from app.people p
  where p.user_id is not null and p.deleted_at is null
    -- A service account has no age to give (private.minimum_age_met).
    and not exists (select 1 from app.service_accounts s where s.person_id = p.id)
  on conflict (person_id, minimum_age) do nothing;
  insert into app.legal_acceptances (org_id, person_id, user_id, document_slug, document_version)
  select null, p.id, p.user_id, d.slug, '1.0.0'
  from app.people p cross join (values ('mobile-eula'), ('worker-terms')) as d (slug)
  where p.user_id is not null and p.deleted_at is null
    and not exists (select 1 from app.service_accounts s where s.person_id = p.id)
    and not exists (
      select 1 from app.legal_acceptances a
      where a.person_id = p.id and a.org_id is null and a.document_slug = d.slug and a.deleted_at is null);
end $$;

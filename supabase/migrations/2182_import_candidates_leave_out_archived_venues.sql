-- 2182_import_candidates_leave_out_archived_venues.sql
-- A124 (RRR-169), trace row S4.10-02. 2180 moved venues archived through deleted_at to archived_at, and a live venue may
-- now share an archived venue's name. Import duplicate review (private.fuzzy_candidates, 0530) filtered venues on
-- deleted_at only, so archived venues would come back as candidates to merge an import row into. It restates its
-- latest definition (0530) with archived venues left out; counterparties are unchanged.

create or replace function private.fuzzy_candidates(p_org_id uuid, p_target_code text, p_name text, p_address text default null)
returns table (candidate_table text, candidate_id uuid, similarity numeric)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_probe text := lower(btrim(coalesce(p_name, '') || ' ' || coalesce(p_address, '')));
begin
  if p_target_code = 'venues' then
    return query
    select 'app.venues'::text, v.id, round(extensions.similarity(
      lower(btrim(v.name || ' ' || concat_ws(' ', v.street_address, v.locality, v.postal_code))), v_probe)::numeric, 3)
    from app.venues v
    where v.org_id = p_org_id and v.deleted_at is null and v.archived_at is null
      and extensions.similarity(lower(btrim(v.name || ' ' || concat_ws(' ', v.street_address, v.locality, v.postal_code))), v_probe) >= 0.85
    order by 3 desc;
  elsif p_target_code = 'counterparties' then
    return query
    select 'app.counterparties'::text, c.id, round(extensions.similarity(lower(o.name), lower(btrim(p_name)))::numeric, 3)
    from app.counterparties c join app.organizations o on o.id = c.organization_id
    where c.org_id = p_org_id and c.deleted_at is null
      and extensions.similarity(lower(o.name), lower(btrim(p_name))) >= 0.85
    order by 3 desc;
  end if;
end;
$$;

comment on function private.fuzzy_candidates(uuid, text, text, text) is 'Existing rows of the org whose name plus address is at least 0.85 similar (pg_trgm) to an import row (Section 4.6.2 step 5). Strong keys are matched exactly before this runs. Archived venues are left out (A124, 2182).';
revoke all on function private.fuzzy_candidates(uuid, text, text, text) from public, anon, authenticated;

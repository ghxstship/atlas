-- Owner decisions of 2026-10-24 on Linear RRR-67: every org receives all 34 Standard Library SOPs and all 34
-- documents. Migration 1612 held back 14 SOPs and 11 documents written from the real CSMIA26 activation; migration
-- 2001 anonymized their client and generalized their site, the agencies that permitted it and its permit numbers, so
-- nothing is withheld any more.
--
-- private.standard_library_withheld (latest definition 1612) now lists nothing, so private.adopt_standard_library
-- copies every row, app.standard_library_status counts every row, and canon serves every row as it always did. Every
-- org that already holds Standard Library copies receives the 25 now: the adoption copies only rows the org never
-- held, so its own edits and removals stay as they are. An org that never adopted keeps the "Adopt Standard Library"
-- action, which copies all of them.
--
-- Third migration of the orchestrator's fourth block, 2000 to 2009 (ADR 0022 amendment of 2026-10-24).

create or replace function private.standard_library_withheld(p_library text)
returns text[]
language sql
immutable
parallel safe
set search_path = ''
as $$
  select '{}'::text[];
$$;

comment on function private.standard_library_withheld(text) is 'Record ids of the Standard Library rows of a library that no org receives. Empty for every library since the owner''s RRR-67 decisions of 2026-10-24: the 14 SOPs and 11 documents written from the CSMIA26 activation were generalized (migration 2001) and released (migration 2002). private.adopt_standard_library and app.standard_library_status still consult it.';
revoke all on function private.standard_library_withheld(text) from public, anon, authenticated;

do $$
declare
  v_org uuid;
begin
  for v_org in
    select o.id from app.organizations o
    where o.deleted_at is null
      and (exists (select 1 from app.sops s where s.org_id = o.id and s.std_sop_id is not null)
        or exists (select 1 from app.documents d where d.org_id = o.id and d.std_document_id is not null))
    order by o.id
  loop
    perform private.adopt_standard_library(v_org);
  end loop;
end $$;

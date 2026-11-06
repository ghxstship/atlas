-- 2996_pool_invitation_import_target.sql
-- B10 Crew onboarding, recruitment and account-free field access (RRR-234, gap G-132, Section 4.6.2, ADR 0149
-- decision 5). Freelancer lists import as pool invitations: every row invites an email address into a Talent pool
-- (2995), and nothing ever writes a person or a profile (ADR 0019 item 10).
--   * Target pool_invitations, org-wide like every pool object (opportunities.pool.write), with fuzzy matching. Its
--     sort order is the highest on this base plus one. None of P3's destination functions change: it names no
--     destination.
--   * Fields: email (required, the strong key, matched inside the row's pool), pool_name, invitee_name, work_phone,
--     role, rate, rate_currency, rate_type and note. The worker resolves the pool, phone, role and rate (2996's
--     worker case in packages/data/src/import-worker.ts).
--   * app.import_jobs.number_format: which of four number formats the uploader chose for amounts (1,234.56,
--     1.234,56, 1 234,56 or 1'234.56). It sets the separators only; the phone region comes from the org.
--   * app.import_jobs.talent_pool_id: the pool for rows without pool_name, only for this target and only a live Talent
--     pool of the org (t44_guard_import_job_pool). Both columns are fixed once the import exists.
--   * app.import_strong_key_match (from 2800) matches a pool invitation on its email inside its pool, pending rows
--     only (no outcome, not deleted, expired included); an expired match is reissued by the worker.
--   * private.fuzzy_candidates (from 2800, its latest definition on this base; A124's 2182 is not merged here and
--     leaves the venue arm to it) compares the invitee name with the org's pending pool invitations and with the names
--     of live members of its Talent pools. In merge review, Merged means the row is Skipped: the person is already
--     invited or in a pool.
--   * app.undo_import_batch stays as 2800 left it: a claimed or declined invitation was edited after the import and
--     is kept and listed; unanswered ones are soft-deleted (2996's pgTAP checks both).
-- No table becomes Trash-eligible here, so private.sync_trash_tables() is not called (ADR 0110).

-- 1. The target -----------------------------------------------------------------------------------------------------

insert into private.import_targets (code, target_table, write_capability, fuzzy_match, sort_order, destination)
select 'pool_invitations', 'app.talent_pool_invitations', 'opportunities.pool.write', true, max(t.sort_order) + 1, null
from private.import_targets t;

insert into private.import_target_fields (target_code, field_name, required, strong_key) values
  ('pool_invitations', 'email', true, true),
  ('pool_invitations', 'pool_name', false, false),
  ('pool_invitations', 'invitee_name', false, false),
  ('pool_invitations', 'work_phone', false, false),
  ('pool_invitations', 'role', false, false),
  ('pool_invitations', 'rate', false, false),
  ('pool_invitations', 'rate_currency', false, false),
  ('pool_invitations', 'rate_type', false, false),
  ('pool_invitations', 'note', false, false);

-- 2. Import jobs carry the number format and the default pool ----------------------------------------------------------

alter table app.import_jobs add column number_format text not null default 'comma-dot';
alter table app.import_jobs add constraint import_jobs_number_format
  check (number_format in ('comma-dot', 'dot-comma', 'space-comma', 'apostrophe-dot'));
comment on column app.import_jobs.number_format is 'How amounts in the file are written: comma-dot (1,234.56), dot-comma (1.234,56), space-comma (1 234,56) or apostrophe-dot (1''234.56). It sets the group and decimal separators only. Fixed once the import exists.';

alter table app.import_jobs add column talent_pool_id uuid references app.talent_pools (id);
create index import_jobs_talent_pool_idx on app.import_jobs (talent_pool_id);
call private.add_cross_org_references('app.import_jobs', array['app.talent_pools', 'talent_pool_id']);
comment on column app.import_jobs.talent_pool_id is 'Talent pool a pool invitation import puts rows without a pool name into; NULL for every other target. Fixed once the import exists.';

create or replace function private.guard_import_job_pool()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    if new.talent_pool_id is distinct from old.talent_pool_id or new.number_format is distinct from old.number_format then
      perform private.refuse('import_job_immutable', 'An import keeps its file and target; start a new import instead.');
    end if;
    return new;
  end if;
  if new.talent_pool_id is not null then
    if new.target_code <> 'pool_invitations' then
      perform private.refuse('import_pool_unexpected', 'Only a pool invitation import names a pool.');
    end if;
    if not exists (select 1 from app.talent_pools p
                   where p.id = new.talent_pool_id and p.org_id = new.org_id and p.deleted_at is null and p.pool_kind = 'Talent') then
      perform private.refuse('import_pool_unknown', 'Choose a live Talent pool of the organization.');
    end if;
  end if;
  return new;
end;
$$;

comment on function private.guard_import_job_pool() is 'Import jobs: a default pool only for the pool_invitations target and only a live Talent pool of the org; the pool and the number format never change after the import exists.';
revoke all on function private.guard_import_job_pool() from public, anon, authenticated;

create trigger t44_guard_import_job_pool before insert or update on app.import_jobs
  for each row execute function private.guard_import_job_pool();

-- The worker has no session and writes a Restricted rate only for a creator who may read it.
create or replace function app.import_job_can_write_rates(p_import_job_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select private.person_capability_reach(j.created_by, j.org_id, 'data.restricted.read.payroll', true) = 'organization'
    from app.import_jobs j where j.id = p_import_job_id and j.deleted_at is null), false);
$$;

comment on function app.import_job_can_write_rates(uuid) is 'Import worker API (service role): true when the person who created the import holds data.restricted.read.payroll org-wide, so a pool invitation row may carry a standing rate (B10).';
revoke all on function app.import_job_can_write_rates(uuid) from public, anon, authenticated;
grant execute on function app.import_job_can_write_rates(uuid) to service_role;

-- 3. Strong keys (from 2800) -----------------------------------------------------------------------------------------

create or replace function app.import_strong_key_match(p_import_job_id uuid, p_keys jsonb)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_job app.import_jobs;
  v_id uuid;
begin
  select * into v_job from app.import_jobs j where j.id = p_import_job_id and j.deleted_at is null;
  if v_job.id is null then
    perform private.refuse('import_job_unknown', 'No such import.');
  end if;
  if v_job.target_code = 'cues' then
    if p_keys ? 'position' then
      select c.id into v_id from app.cues c
      where c.run_of_show_id = v_job.run_of_show_id and c.deleted_at is null
        and c.position = (p_keys ->> 'position')::integer
      limit 1;
    elsif p_keys ? 'label' then
      select c.id into v_id from app.cues c
      where c.run_of_show_id = v_job.run_of_show_id and c.deleted_at is null
        and c.label = p_keys ->> 'label'
        and c.planned_at is not distinct from (p_keys ->> 'planned_at')::timestamptz
      order by c.position
      limit 1;
    end if;
  elsif v_job.target_code = 'guest_list_entries' then
    if p_keys ? 'guest_name' then
      select g.id into v_id from app.guest_list_entries g
      where g.project_id = v_job.project_id and g.deleted_at is null
        and lower(btrim(g.guest_name)) = lower(btrim(p_keys ->> 'guest_name'))
        and g.scope_node_id is not distinct from (p_keys ->> 'scope_node_id')::uuid
      order by g.created_at
      limit 1;
    end if;
  elsif v_job.target_code = 'pool_invitations' then
    -- Email inside the row's pool, pending only: a claimed, declined or revoked invitation never matches.
    if p_keys ? 'email' and p_keys ? 'talent_pool_id' then
      select i.id into v_id from app.talent_pool_invitations i
      where i.org_id = v_job.org_id and i.talent_pool_id = (p_keys ->> 'talent_pool_id')::uuid
        and i.email = lower(btrim(p_keys ->> 'email'))
        and i.claimed_at is null and i.declined_at is null and i.revoked_at is null and i.deleted_at is null
      limit 1;
    end if;
  end if;
  return v_id;
end;
$$;

comment on function app.import_strong_key_match(uuid, jsonb) is 'Import worker API (service role): the existing row a cue, guest list or pool invitation import row matches exactly on its strong keys, or NULL. Cues match on position, or without one on label and planned time; guests on the trimmed name, case-insensitively, and the show; pool invitations on the lowercased email inside the row''s pool, pending ones only, expired included (B10). A NULL show or time matches only NULL. The destination always comes from the import, never from the sheet.';
revoke all on function app.import_strong_key_match(uuid, jsonb) from public, anon, authenticated;
grant execute on function app.import_strong_key_match(uuid, jsonb) to service_role;

-- 4. Fuzzy candidates (from 2800) ------------------------------------------------------------------------------------

create or replace function private.fuzzy_candidates(p_org_id uuid, p_target_code text, p_name text, p_address text default null, p_project_id uuid default null)
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
    where v.org_id = p_org_id and v.deleted_at is null
      and extensions.similarity(lower(btrim(v.name || ' ' || concat_ws(' ', v.street_address, v.locality, v.postal_code))), v_probe) >= 0.85
    order by 3 desc;
  elsif p_target_code = 'counterparties' then
    return query
    select 'app.counterparties'::text, c.id, round(extensions.similarity(lower(o.name), lower(btrim(p_name)))::numeric, 3)
    from app.counterparties c join app.organizations o on o.id = c.organization_id
    where c.org_id = p_org_id and c.deleted_at is null
      and extensions.similarity(lower(o.name), lower(btrim(p_name))) >= 0.85
    order by 3 desc;
  elsif p_target_code = 'guest_list_entries' then
    return query
    select 'app.guest_list_entries'::text, g.id, round(extensions.similarity(lower(btrim(g.guest_name)), lower(btrim(p_name)))::numeric, 3)
    from app.guest_list_entries g
    where g.org_id = p_org_id and g.project_id = p_project_id and g.deleted_at is null
      and extensions.similarity(lower(btrim(g.guest_name)), lower(btrim(p_name))) >= 0.85
    order by 3 desc;
  elsif p_target_code = 'pool_invitations' then
    -- Someone already invited by another address, or already in one of the org's Talent pools (B10).
    return query
    select x.candidate_table, x.candidate_id, x.similarity from (
      select 'app.talent_pool_invitations'::text as candidate_table, i.id as candidate_id,
        round(extensions.similarity(lower(btrim(i.invitee_name)), lower(btrim(p_name)))::numeric, 3) as similarity
      from app.talent_pool_invitations i
      where i.org_id = p_org_id and i.deleted_at is null and i.invitee_name is not null
        and i.claimed_at is null and i.declined_at is null and i.revoked_at is null
        and extensions.similarity(lower(btrim(i.invitee_name)), lower(btrim(p_name))) >= 0.85
      union all
      select 'app.pool_members'::text, m.id,
        round(extensions.similarity(lower(btrim(pe.full_name)), lower(btrim(p_name)))::numeric, 3)
      from app.pool_members m
      join app.talent_pools tp on tp.id = m.talent_pool_id and tp.deleted_at is null and tp.pool_kind = 'Talent'
      join app.people pe on pe.id = m.person_id
      where m.org_id = p_org_id and m.deleted_at is null
        and extensions.similarity(lower(btrim(pe.full_name)), lower(btrim(p_name))) >= 0.85
    ) x
    order by 3 desc;
  end if;
end;
$$;

comment on function private.fuzzy_candidates(uuid, text, text, text, uuid) is 'Existing rows of the org whose name plus address is at least 0.85 similar (pg_trgm) to an import row (Section 4.6.2 step 5); for a guest list import, live guests of the import''s project by name; for a pool invitation import, pending pool invitations by invitee name and live members of the org''s Talent pools by their name (B10). Strong keys are matched exactly before this runs.';
revoke all on function private.fuzzy_candidates(uuid, text, text, text, uuid) from public, anon, authenticated;

-- 2713_sponsor_supplied_assets.sql
-- R9 Sponsor-supplied brand assets (RRR-189; prompt line 562, journey 47). Until now the org uploaded every brand asset
-- and the sponsor approved it in Gateway (1133). A sponsor now supplies its own logo or artwork from Gateway and the
-- org approves it in Atlas; the review runs the other way, through the same lifecycle and ledger.
--
--   1. app.sponsor_asset_files (append-only): the party-uploads documents of each revision of an asset.
--   2. app.supply_sponsor_asset: the sponsor side (private.sponsor_side_open) creates a Sponsor Supplied asset with
--      1 to 10 files from the entitlement's folder and submits it.
--   3. app.resubmit_sponsor_asset: the sponsor resubmits a Returned Sponsor Supplied asset with new files, which go at
--      the next revision (stamped inside the sponsor_asset_review operation of 1133).
--   4. app.respond_sponsor_asset (from 1133) refuses Sponsor Supplied assets: the sponsor does not approve its own.
--   5. app.transition_sponsor_asset (from 0492): on a Sponsor Supplied asset the org only approves, returns or cancels
--      a Submitted one; resubmitting is the sponsor's.

-- 1. Files -----------------------------------------------------------------------------------------------------------

create table app.sponsor_asset_files (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  sponsor_asset_id uuid not null references app.sponsor_assets (id),
  revision integer not null,
  document_id uuid not null references app.documents (id),
  position smallint not null,
  constraint sponsor_asset_files_revision check (revision >= 0),
  constraint sponsor_asset_files_position check (position between 1 and 10)
);
create unique index sponsor_asset_files_document_key on app.sponsor_asset_files (document_id);
create unique index sponsor_asset_files_position_key on app.sponsor_asset_files (sponsor_asset_id, revision, position);

call private.install_domain_table('app.sponsor_asset_files', 'app.sponsor_assets', 'sponsor_asset_id',
  array['app.documents', 'document_id'], true);
call private.install_policies('app.sponsor_asset_files',
  $$sponsor_asset_id in (select a.id from app.sponsor_assets a join app.sponsor_entitlements s on s.id = a.sponsor_entitlement_id
    where s.project_id in (select private.project_ids_with('vendors.vendor.read')))$$);
call private.describe('app.sponsor_asset_files', 'Files of a sponsor-supplied brand asset, by revision (R9): documents the sponsor uploaded to party-uploads under the entitlement. Written only by app.supply_sponsor_asset and app.resubmit_sponsor_asset; append-only.', array[
  'sponsor_asset_id', 'Asset the file belongs to.',
  'revision', 'Revision of the asset the file was supplied with: 0 first, one more on each resubmission.',
  'document_id', 'Document of the uploaded file; attached once.',
  'position', 'Order within the revision, 1 to 10.'
]);
call private.install_default_retention('app.sponsor_asset_files');

create or replace function private.guard_sponsor_asset_file()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.in_trusted_operation('supply_sponsor_asset') then
    perform private.refuse('sponsor_asset_files_invalid', 'Files are supplied with app.supply_sponsor_asset or app.resubmit_sponsor_asset.');
  end if;
  return new;
end;
$$;
comment on function private.guard_sponsor_asset_file() is 'Sponsor asset files (R9): written only inside the supply_sponsor_asset operation (sponsor_asset_files_invalid).';
revoke all on function private.guard_sponsor_asset_file() from public, anon, authenticated;
create trigger t40_guard_sponsor_asset_file before insert on app.sponsor_asset_files
  for each row execute function private.guard_sponsor_asset_file();

-- The documents a sponsor attaches: from the entitlement's folder, not attached yet, 1 to 10 of them.
create or replace function private.assert_sponsor_asset_documents(p_sponsor_entitlement_id uuid, p_document_ids uuid[])
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_entitlement app.sponsor_entitlements;
  v_prefix text;
begin
  if coalesce(cardinality(p_document_ids), 0) not between 1 and 10 then
    perform private.refuse('sponsor_asset_files_required', 'Attach 1 to 10 files.');
  end if;
  select s.* into v_entitlement from app.sponsor_entitlements s where s.id = p_sponsor_entitlement_id;
  v_prefix := format('storage://party-uploads/%s/sponsor-asset/%s/', v_entitlement.org_id, v_entitlement.id);
  if (select count(distinct d.id) from app.documents d
      where d.id = any (p_document_ids) and d.org_id = v_entitlement.org_id and d.deleted_at is null
        and exists (select 1 from app.document_versions v where v.document_id = d.id and starts_with(v.storage_uri, v_prefix))
        and not exists (select 1 from app.sponsor_asset_files f where f.document_id = d.id)) <> cardinality(p_document_ids) then
    perform private.refuse('sponsor_asset_files_invalid', 'Each file is uploaded for this entitlement and attached once.');
  end if;
end;
$$;
comment on function private.assert_sponsor_asset_documents(uuid, uuid[]) is 'R9: 1 to 10 distinct documents (sponsor_asset_files_required), each registered from party-uploads under <org>/sponsor-asset/<entitlement>/ and not attached to an asset yet (sponsor_asset_files_invalid).';
revoke all on function private.assert_sponsor_asset_documents(uuid, uuid[]) from public, anon, authenticated;

-- 2. Supplying ------------------------------------------------------------------------------------------------------

create or replace function app.supply_sponsor_asset(
  p_sponsor_entitlement_id uuid,
  p_asset_kind app.sponsor_asset_kind,
  p_title text,
  p_usage_note text,
  p_due_on date,
  p_document_ids uuid[]
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_doc uuid;
  v_i integer := 0;
begin
  perform private.require_person();
  if not private.sponsor_side_open(p_sponsor_entitlement_id) then
    raise exception using errcode = '42501', message = 'only the sponsor supplies assets for this entitlement';
  end if;
  perform private.assert_sponsor_asset_documents(p_sponsor_entitlement_id, p_document_ids);
  perform private.begin_trusted_operation('supply_sponsor_asset');
  insert into app.sponsor_assets (sponsor_entitlement_id, asset_kind, title, usage_note, due_on, asset_source)
  values (p_sponsor_entitlement_id, p_asset_kind, btrim(coalesce(p_title, '')), nullif(btrim(coalesce(p_usage_note, '')), ''),
    p_due_on, 'Sponsor Supplied')
  returning id into v_id;
  foreach v_doc in array p_document_ids loop
    v_i := v_i + 1;
    insert into app.sponsor_asset_files (sponsor_asset_id, revision, document_id, position) values (v_id, 0, v_doc, v_i);
  end loop;
  perform private.end_trusted_operation('supply_sponsor_asset');
  perform private.transition_lifecycle('sponsor_asset', 'app.sponsor_assets', 'asset_state', 'app.sponsor_asset_state_transitions',
    'sponsor_asset_id', v_id, 'Proposed', 'Submitted', 'Supplied by the sponsor.');
  return v_id;
end;
$$;
comment on function app.supply_sponsor_asset(uuid, app.sponsor_asset_kind, text, text, date, uuid[]) is 'The sponsor side (an Account Owner or Admin of the sponsor while its Sponsor engagement is in the operational area, private.sponsor_side_open; 42501 otherwise) supplies a brand asset for an entitlement (R9): 1 to 10 documents from the entitlement''s party-uploads folder (sponsor_asset_files_required, sponsor_asset_files_invalid) become revision 0 of a Sponsor Supplied asset, which moves from Proposed to Submitted for the org to approve. Returns the asset id.';
revoke all on function app.supply_sponsor_asset(uuid, app.sponsor_asset_kind, text, text, date, uuid[]) from public, anon;
grant execute on function app.supply_sponsor_asset(uuid, app.sponsor_asset_kind, text, text, date, uuid[]) to authenticated, service_role;

-- 3. Resubmitting ------------------------------------------------------------------------------------------------------

create or replace function app.resubmit_sponsor_asset(p_sponsor_asset_id uuid, p_document_ids uuid[], p_reason text default null)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_row app.sponsor_assets;
  v_entry uuid;
  v_doc uuid;
  v_i integer := 0;
begin
  perform private.require_person();
  select a.* into v_row from app.sponsor_assets a where a.id = p_sponsor_asset_id and a.deleted_at is null for update;
  if v_row.id is null or v_row.asset_source <> 'Sponsor Supplied' or not private.sponsor_side_open(v_row.sponsor_entitlement_id) then
    raise exception using errcode = '42501', message = 'only the sponsor resubmits this asset';
  end if;
  perform private.assert_sponsor_asset_documents(v_row.sponsor_entitlement_id, p_document_ids);
  v_entry := private.transition_lifecycle('sponsor_asset', 'app.sponsor_assets', 'asset_state', 'app.sponsor_asset_state_transitions',
    'sponsor_asset_id', v_row.id, 'Returned', 'Submitted', coalesce(nullif(btrim(coalesce(p_reason, '')), ''), 'Resubmitted by the sponsor.'));
  perform private.begin_trusted_operation('sponsor_asset_review');
  update app.sponsor_assets set revision = revision + 1 where id = v_row.id;
  perform private.end_trusted_operation('sponsor_asset_review');
  perform private.begin_trusted_operation('supply_sponsor_asset');
  foreach v_doc in array p_document_ids loop
    v_i := v_i + 1;
    insert into app.sponsor_asset_files (sponsor_asset_id, revision, document_id, position) values (v_row.id, v_row.revision + 1, v_doc, v_i);
  end loop;
  perform private.end_trusted_operation('supply_sponsor_asset');
  return v_entry;
end;
$$;
comment on function app.resubmit_sponsor_asset(uuid, uuid[], text) is 'The sponsor side resubmits a Returned Sponsor Supplied asset with 1 to 10 new files from the entitlement''s folder (R9): compare-and-set from Returned to Submitted with the reason in the ledger, the revision one higher (inside sponsor_asset_review, as 1133 does) and the files at that revision. Anyone else, or an Org Supplied asset, gets 42501. Returns the ledger entry id.';
revoke all on function app.resubmit_sponsor_asset(uuid, uuid[], text) from public, anon;
grant execute on function app.resubmit_sponsor_asset(uuid, uuid[], text) to authenticated, service_role;

-- 4. The sponsor answers only for the org's assets, from 1133 ----------------------------------------------------------------

create or replace function app.respond_sponsor_asset(
  p_sponsor_asset_id uuid,
  p_expected app.review_state,
  p_next app.review_state,
  p_reason text
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
  v_row app.sponsor_assets;
  v_entry uuid;
begin
  select * into v_row from app.sponsor_assets a where a.id = p_sponsor_asset_id and a.deleted_at is null for update;
  -- A draft the org has not submitted is not the sponsor's to see, so it is answered like a missing one.
  if v_row.id is null or v_row.asset_state = 'Proposed' or not private.sponsor_side_open(v_row.sponsor_entitlement_id) then
    raise exception using errcode = '42501', message = 'only the sponsor answers for this asset';
  end if;
  if v_row.asset_source = 'Sponsor Supplied' then
    perform private.refuse('sponsor_asset_source', 'The org approves the assets the sponsor supplies; resubmit a returned one with new files.');
  end if;
  if not ((p_expected = 'Submitted' and p_next in ('Approved', 'Returned')) or (p_expected = 'Returned' and p_next = 'Submitted')) then
    perform private.refuse('sponsor_asset_response', 'A sponsor approves or returns a submitted asset, or resubmits a returned one.');
  end if;
  if p_next = 'Returned' and nullif(btrim(p_reason), '') is null then
    perform private.refuse('sponsor_asset_return_reason', 'Say what to change when returning an asset.');
  end if;
  v_entry := private.transition_lifecycle('sponsor_asset', 'app.sponsor_assets', 'asset_state', 'app.sponsor_asset_state_transitions',
    'sponsor_asset_id', p_sponsor_asset_id, p_expected::text, p_next::text,
    coalesce(nullif(btrim(p_reason), ''), case p_next when 'Approved' then 'Approved by the sponsor.' else 'Resubmitted by the sponsor.' end));
  perform private.begin_trusted_operation('sponsor_asset_review');
  if p_next in ('Approved', 'Returned') then
    update app.sponsor_assets set decided_by = v_person, decided_at = now() where id = p_sponsor_asset_id;
  else
    update app.sponsor_assets set revision = revision + 1 where id = p_sponsor_asset_id;
  end if;
  perform private.end_trusted_operation('sponsor_asset_review');
  return v_entry;
end;
$$;
comment on function app.respond_sponsor_asset(uuid, app.review_state, app.review_state, text) is 'The sponsor''s answer on a brand asset the org supplied (journey 47): an Account Owner or Admin of the sponsor account, while its Sponsor engagement is in the operational area, approves or returns a Submitted asset (a return says what to change) or resubmits a Returned one as a new revision. A Sponsor Supplied asset is the org''s to decide and is refused with sponsor_asset_source (R9). Compare-and-set; the move is recorded in the asset''s ledger and emits sponsor_asset.state_changed.';
revoke all on function app.respond_sponsor_asset(uuid, app.review_state, app.review_state, text) from public, anon;
grant execute on function app.respond_sponsor_asset(uuid, app.review_state, app.review_state, text) to authenticated, service_role;

-- 5. The org's moves on a sponsor's asset, from 0492 ----------------------------------------------------------------------------

create or replace function app.transition_sponsor_asset(p_sponsor_asset_id uuid, p_expected app.review_state, p_next app.review_state, p_reason text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
  v_row app.sponsor_assets;
  v_project uuid;
  v_entry uuid;
begin
  select * into v_row from app.sponsor_assets a where a.id = p_sponsor_asset_id and a.deleted_at is null for update;
  v_project := (select s.project_id from app.sponsor_entitlements s where s.id = v_row.sponsor_entitlement_id);
  if v_row.id is null or not private.can_on_project(v_project, 'vendors.entitlement.write') then
    raise exception using errcode = '42501', message = 'vendors.entitlement.write is required on the project';
  end if;
  if v_row.asset_source = 'Sponsor Supplied' and not (p_expected = 'Submitted' and p_next in ('Approved', 'Returned', 'Canceled')) then
    perform private.refuse('sponsor_asset_source', 'The org approves, returns or cancels a submitted asset the sponsor supplied; the sponsor resubmits it.');
  end if;
  if p_next in ('Approved', 'Returned') then
    perform private.assert_separation('sod_approval_requester', v_person, v_row.created_by);
  end if;
  v_entry := private.transition_lifecycle('sponsor_asset', 'app.sponsor_assets', 'asset_state', 'app.sponsor_asset_state_transitions',
    'sponsor_asset_id', p_sponsor_asset_id, p_expected::text, p_next::text, p_reason);
  perform private.begin_trusted_operation('sponsor_asset_review');
  if p_next in ('Approved', 'Returned') then
    update app.sponsor_assets set decided_by = v_person, decided_at = now() where id = p_sponsor_asset_id;
  elsif p_expected = 'Returned' and p_next = 'Submitted' then
    update app.sponsor_assets set revision = revision + 1 where id = p_sponsor_asset_id;
  end if;
  perform private.end_trusted_operation('sponsor_asset_review');
  return v_entry;
end;
$$;
comment on function app.transition_sponsor_asset(uuid, app.review_state, app.review_state, text) is 'Submits, approves, returns or cancels a sponsor asset with compare-and-set: vendors.entitlement.write on the project; approving or returning is never done by the uploader (sod_approval_requester). On a Sponsor Supplied asset the org only approves, returns or cancels a Submitted one; every other move is refused with sponsor_asset_source (R9).';
revoke all on function app.transition_sponsor_asset(uuid, app.review_state, app.review_state, text) from public, anon;
grant execute on function app.transition_sponsor_asset(uuid, app.review_state, app.review_state, text) to authenticated, service_role;

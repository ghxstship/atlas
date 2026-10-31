-- 3040_ai_intake_batches.sql
-- B15 Aurora intake and drafting extensions (RRR-239; parity gaps G-59, G-177, G-225, G-173, G-240; ADR 0154). An
-- intake batch is the subject of the extraction requests that read many files into one preview: itineraries into a
-- Travel fulfillment's segments (3041), or booking contracts and riders sorted by act into Artist engagements (3042).
-- Each file is one metered request about the batch; the batch's suggestions are written together by its apply RPC.
--
--   1. app.ai_intake_kind and app.ai_intake_batches: who opened the batch, on which project, how many files it takes,
--      and when it closed. Read by its creator and by audit.log.read holders; written only by the RPCs below.
--   2. app.start_ai_intake checks the capabilities of the kind, the plan and the extraction switch, and that the files
--      fit in this month's allowance, before any file is read. app.close_ai_intake rejects what is left.
--   3. t41_guard_intake_request on app.ai_requests: a request about a batch is the batch creator's own extraction
--      request, while the batch is open (aurora_intake_closed) and below its file count (aurora_intake_full). Failed
--      requests do not count, so a file that failed can be read again; every attempt is still metered.
--   4. t13_aurora_batch_apply_only on app.ai_suggestions: a suggestion of an intake batch, or of a drafting request about
--      an advance recipient (3044), is confirmed only inside the trusted operation aurora_batch_apply, so a batch or an
--      answer is never written piecemeal (ai_suggestion_batch_apply). Rejecting stays allowed. This adds a trigger
--      instead of redefining app.transition_ai_suggestion again (2830).
--   5. app.ai_suggestion_fields.restricted_capability: app.ai_propose_suggestion (from 0650, no later redefinition) sets
--      it itself from private.ai_restricted_fields, never from the caller, and refuses aurora_field_restricted when a
--      Restricted field carries a value the caller may not read. Only a field with a value or an excerpt is marked: a
--      NO_ANSWER fee stays readable with its reason. The read policy hides a marked field from anyone without the
--      capability, audit.log.read holders included. ai_suggestion_fields_value_or_refusal is unchanged.
--   6. Comments on app.ai_settings.extraction_enabled (0650), drafting_enabled and app.ai_suggestions.operation_id
--      (2830), extended with the new kinds.
-- 3045 to 3049 are reserved and unused.

-- 1. Batches ---------------------------------------------------------------------------------------------------------------

create type app.ai_intake_kind as enum ('Itineraries', 'Contracts and Riders');
comment on type app.ai_intake_kind is 'What an Aurora intake batch reads (B15): travel Itineraries into a Travel fulfillment''s segments, or booking Contracts and Riders sorted by act into Artist engagements. Labels come from the aurora catalog keyed by this value.';

create table app.ai_intake_batches (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  project_id uuid not null references app.projects (id),
  intake_kind app.ai_intake_kind not null,
  fulfillment_id uuid references app.fulfillments (id),
  file_count smallint not null,
  closed_at timestamptz,
  constraint ai_intake_batches_file_count check (file_count between 1 and 25),
  constraint ai_intake_batches_fulfillment_kind check (fulfillment_id is null or intake_kind = 'Itineraries')
);

create index ai_intake_batches_project_id_idx on app.ai_intake_batches (project_id);
create index ai_intake_batches_fulfillment_id_idx on app.ai_intake_batches (fulfillment_id);

call private.install_domain_table('app.ai_intake_batches', 'app.projects', 'project_id', array['app.fulfillments', 'fulfillment_id']);
call private.describe('app.ai_intake_batches', 'An Aurora intake batch (B15, ADR 0154): the subject of the extraction requests that read many files into one preview, one metered request per file. Opened by app.start_ai_intake, written together by app.apply_itinerary_intake or app.apply_contract_intake, and closed by them or by app.close_ai_intake. Read by the person who opened it and by audit.log.read holders.', array[
  'project_id', 'Project the files are read for.',
  'intake_kind', 'Itineraries or Contracts and Riders.',
  'fulfillment_id', 'Travel fulfillment of the same project the segments are filed under, for Itineraries; null otherwise.',
  'file_count', 'Files the batch reads, 1 to 25: the most requests about it that do not fail.',
  'closed_at', 'When the batch was applied or closed; null while open. A closed batch takes no more requests.'
]);
call private.install_policies('app.ai_intake_batches',
  'created_by = (select private.current_person_id()) or org_id in (select private.orgs_with_capability(''audit.log.read''))');
call private.install_audit_trail('app.ai_intake_batches');
call private.install_default_retention('app.ai_intake_batches');

create trigger t39_ai_intake_batch_project before insert or update on app.ai_intake_batches
  for each row execute function private.assert_same_project('app.fulfillments', 'fulfillment_id');

create or replace function private.guard_ai_intake_batch()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.project_id is distinct from old.project_id or new.intake_kind is distinct from old.intake_kind
     or new.fulfillment_id is distinct from old.fulfillment_id or new.file_count is distinct from old.file_count
     or new.created_by is distinct from old.created_by then
    perform private.refuse('aurora_intake_immutable', 'An intake batch keeps its project, kind, fulfillment and file count.');
  end if;
  if old.closed_at is not null and new.closed_at is distinct from old.closed_at then
    perform private.refuse('aurora_intake_closed', 'This intake is closed. Start a new one to read more files.');
  end if;
  return new;
end;
$$;

comment on function private.guard_ai_intake_batch() is 'Before update on app.ai_intake_batches: the project, kind, fulfillment, file count and creator never change, and a closed batch stays closed (aurora_intake_closed).';

create trigger t40_guard_ai_intake_batch before update on app.ai_intake_batches
  for each row execute function private.guard_ai_intake_batch();

-- 2. Starting and closing --------------------------------------------------------------------------------------------------

create or replace function app.start_ai_intake(
  p_project_id uuid,
  p_kind app.ai_intake_kind,
  p_file_count integer,
  p_fulfillment_id uuid default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_me uuid := private.current_person_id();
  v_org uuid;
  v_id uuid;
begin
  select p.org_id into v_org from app.projects p where p.id = p_project_id and p.deleted_at is null;
  if v_me is null or v_org is null or not private.is_member(v_org) then
    raise exception using errcode = '42501', message = 'an intake needs an active membership in the project''s org';
  end if;
  if p_kind = 'Itineraries' and not private.can_on_project(p_project_id, 'hospitality.fulfillment.write') then
    raise exception using errcode = '42501', message = 'importing itineraries needs hospitality.fulfillment.write on the project';
  end if;
  if p_kind = 'Contracts and Riders' and not (private.can_on_project(p_project_id, 'opportunities.engagement.write')
     and private.can_on_project(p_project_id, 'advancing.rider.write')) then
    raise exception using errcode = '42501', message = 'importing contracts and riders needs opportunities.engagement.write and advancing.rider.write on the project';
  end if;
  if p_fulfillment_id is not null and (p_kind <> 'Itineraries' or not exists (
       select 1 from app.fulfillments f
       where f.id = p_fulfillment_id and f.project_id = p_project_id and f.fulfillment_kind = 'Travel' and f.deleted_at is null)) then
    perform private.refuse('travel_fulfillment_kind', 'A travel segment belongs to a Travel fulfillment.');
  end if;
  if not private.org_has_feature(v_org, 'aurora_ai') then
    perform private.refuse('aurora_not_in_plan', 'Aurora AI is not in this org''s plan. Upgrade to Core or above to use it.');
  end if;
  if not private.ai_feature_enabled(v_org, 'extraction') then
    perform private.refuse('aurora_feature_off', 'An Admin has not turned on extraction in Settings, AI Features.');
  end if;
  -- Every file is one request, so the whole batch must fit in what is left of this month's allowance.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('aurora:' || v_org::text, 0));
  perform private.assert_within_plan_limit(v_org, 'aurora_requests_per_month', private.ai_requests_this_month(v_org) + p_file_count);

  insert into app.ai_intake_batches (project_id, intake_kind, fulfillment_id, file_count)
  values (p_project_id, p_kind, p_fulfillment_id, p_file_count)
  returning id into v_id;
  return v_id;
end;
$$;

comment on function app.start_ai_intake(uuid, app.ai_intake_kind, integer, uuid) is 'Opens an Aurora intake batch for the caller (B15). Itineraries need hospitality.fulfillment.write on the project, Contracts and Riders need opportunities.engagement.write and advancing.rider.write; otherwise 42501. A fulfillment, Itineraries only, is a live Travel fulfillment of the project (travel_fulfillment_kind otherwise). Refuses aurora_not_in_plan and aurora_feature_off (extraction), and XR001 plan_limit_exceeded when the files do not fit in this month''s aurora_requests_per_month. A file count outside 1 to 25 violates ai_intake_batches_file_count. Meters nothing: each file is metered when it is read.';

create or replace function app.close_ai_intake(p_batch_id uuid)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_batch app.ai_intake_batches;
  v_id uuid;
  v_rejected integer := 0;
begin
  select * into v_batch from app.ai_intake_batches b where b.id = p_batch_id and b.deleted_at is null for update;
  if v_batch.id is null or v_batch.created_by is distinct from private.current_person_id() then
    raise exception using errcode = '42501', message = 'only the person who opened an intake closes it';
  end if;
  if v_batch.closed_at is not null then
    perform private.refuse('aurora_intake_closed', 'This intake is closed. Start a new one to read more files.');
  end if;
  for v_id in
    select s.id from app.ai_suggestions s join app.ai_requests r on r.id = s.request_id
    where r.subject_table = 'app.ai_intake_batches' and r.subject_id = p_batch_id
      and s.suggestion_state = 'Proposed' and s.deleted_at is null
    order by s.created_at, s.id
  loop
    perform app.transition_ai_suggestion(v_id, 'Proposed', 'Rejected', 'Left out when the intake was closed.');
    v_rejected := v_rejected + 1;
  end loop;
  update app.ai_intake_batches set closed_at = now() where id = p_batch_id;
  return v_rejected;
end;
$$;

comment on function app.close_ai_intake(uuid) is 'Closes the caller''s own open intake batch (42501 for anyone else, aurora_intake_closed when already closed): every Proposed suggestion of its requests is Rejected and closed_at is stamped. Returns the number rejected. Calls no model and meters nothing.';

-- 3. Requests about a batch ------------------------------------------------------------------------------------------------

create or replace function private.guard_intake_request()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_batch app.ai_intake_batches;
  v_used integer;
begin
  if new.subject_table is distinct from 'app.ai_intake_batches' then
    return new;
  end if;
  -- The row lock serializes requests about one batch, so two files cannot both take its last place.
  select * into v_batch from app.ai_intake_batches b where b.id = new.subject_id and b.deleted_at is null for update;
  if v_batch.id is null or v_batch.org_id is distinct from new.org_id or v_batch.created_by is distinct from new.person_id then
    raise exception using errcode = '42501', message = 'only the person who opened an intake reads files into it';
  end if;
  if new.feature <> 'extraction' then
    raise exception using errcode = '42501', message = 'an intake batch takes extraction requests only';
  end if;
  if v_batch.closed_at is not null then
    perform private.refuse('aurora_intake_closed', 'This intake is closed. Start a new one to read more files.');
  end if;
  select count(*) into v_used from app.ai_requests r
  where r.subject_table = 'app.ai_intake_batches' and r.subject_id = v_batch.id
    and r.outcome <> 'Failed' and r.deleted_at is null;
  if v_used >= v_batch.file_count then
    perform private.refuse('aurora_intake_full', format('This intake reads %s files and has read them all. Start a new one for more.', v_batch.file_count));
  end if;
  return new;
end;
$$;

comment on function private.guard_intake_request() is 'Before insert on app.ai_requests (B15): a request about an intake batch is an extraction request of the batch''s own creator in its org (42501 otherwise), while the batch is open (aurora_intake_closed) and fewer of its requests than file_count have not Failed (aurora_intake_full). The refusal aborts app.ai_begin_request, so no request or usage row is left.';

create trigger t41_guard_intake_request before insert on app.ai_requests
  for each row execute function private.guard_intake_request();

-- 4. Batch-applied suggestions ---------------------------------------------------------------------------------------------

create or replace function private.aurora_batch_apply_only()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.suggestion_state = 'Confirmed' and old.suggestion_state is distinct from 'Confirmed'
     and not private.in_trusted_operation('aurora_batch_apply') and exists (
       select 1 from app.ai_requests r
       where r.id = new.request_id
         and ((r.feature = 'extraction' and r.subject_table = 'app.ai_intake_batches')
           or (r.feature = 'drafting' and r.subject_table = 'app.advance_recipients'))) then
    perform private.refuse('ai_suggestion_batch_apply', 'Add these together from the Aurora preview, so nothing is written piecemeal.');
  end if;
  return new;
end;
$$;

comment on function private.aurora_batch_apply_only() is 'Before update of suggestion_state on app.ai_suggestions (B15, ADR 0154): a suggestion of an extraction request about an intake batch, or of a drafting request about an advance recipient, is Confirmed only inside the trusted operation aurora_batch_apply (its apply RPC), refused ai_suggestion_batch_apply otherwise. Rejecting it stays allowed.';

create trigger t13_aurora_batch_apply_only before update of suggestion_state on app.ai_suggestions
  for each row execute function private.aurora_batch_apply_only();

-- 5. Restricted proposed fields --------------------------------------------------------------------------------------------

create table private.ai_restricted_fields (
  operation_id text not null,
  field_path text not null,
  capability text not null references app.capabilities (code),
  primary key (operation_id, field_path)
);
create index ai_restricted_fields_capability_idx on private.ai_restricted_fields (capability);

comment on table private.ai_restricted_fields is 'Proposed fields whose value is Restricted (B15): app.ai_propose_suggestion marks such a field with the capability that reads it and refuses a value from a caller without it.';
comment on column private.ai_restricted_fields.operation_id is 'Operation of the suggestion, for example aurora.applyContracts.';
comment on column private.ai_restricted_fields.field_path is 'Field of that suggestion, for example fee_minor.';
comment on column private.ai_restricted_fields.capability is 'Capability that reads the value.';

alter table private.ai_restricted_fields enable row level security;
revoke all on private.ai_restricted_fields from public, anon, authenticated;
grant select on private.ai_restricted_fields to service_role;

insert into private.ai_restricted_fields (operation_id, field_path, capability) values
  ('aurora.applyContracts', 'fee_minor', 'data.restricted.read.payroll');

alter table app.ai_suggestion_fields add column restricted_capability text,
  add constraint ai_suggestion_fields_restricted_capability check (
    restricted_capability is null or restricted_capability in ('data.restricted.read.payroll'));
comment on column app.ai_suggestion_fields.restricted_capability is 'Capability that reads this field, when its value is Restricted (B15): a contract''s fee needs data.restricted.read.payroll. Set by app.ai_propose_suggestion from private.ai_restricted_fields, never by the caller; the field is hidden from anyone without it.';

-- From 0650 (no later redefinition), with the Restricted fields added.
create or replace function app.ai_propose_suggestion(
  p_request_id uuid,
  p_operation_id text,
  p_target_id uuid,
  p_summary text,
  p_fields jsonb
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_request app.ai_requests;
  v_suggestion uuid;
  v_field jsonb;
  v_position smallint := 0;
  v_capability text;
  v_has_value boolean;
begin
  select * into v_request from app.ai_requests r where r.id = p_request_id and r.deleted_at is null;
  if v_request.id is null or v_request.person_id is distinct from private.current_person_id() then
    raise exception using errcode = '42501', message = 'only the person who asked receives its suggestions';
  end if;
  if v_request.outcome <> 'Answered' then
    perform private.refuse('ai_suggestion_needs_answer', 'Only an answered request can propose a change.');
  end if;
  if jsonb_typeof(coalesce(p_fields, '[]'::jsonb)) <> 'array' then
    perform private.refuse('ai_suggestion_fields_shape', 'Fields come as a list.');
  end if;

  insert into app.ai_suggestions (request_id, operation_id, target_id, summary)
  values (p_request_id, p_operation_id, p_target_id, private.ai_redact(btrim(p_summary)))
  returning id into v_suggestion;

  for v_field in select value from jsonb_array_elements(coalesce(p_fields, '[]'::jsonb)) loop
    v_has_value := v_field ? 'value' and jsonb_typeof(v_field -> 'value') <> 'null';
    select f.capability into v_capability from private.ai_restricted_fields f
    where f.operation_id = p_operation_id and f.field_path = v_field ->> 'field_path';
    if v_capability is not null and v_has_value and not private.has_capability(v_request.org_id, v_capability) then
      perform private.refuse('aurora_field_restricted', 'This value is Restricted and was not read for you.');
    end if;
    -- A field with neither a value nor an excerpt holds nothing Restricted, so its reason stays readable.
    if not v_has_value and nullif(btrim(v_field ->> 'source_excerpt'), '') is null then
      v_capability := null;
    end if;
    insert into app.ai_suggestion_fields (suggestion_id, field_path, proposed_value, confidence, refusal, missing, source_excerpt,
      position, restricted_capability)
    values (v_suggestion, v_field ->> 'field_path',
      case when v_has_value then v_field -> 'value' end,
      (v_field ->> 'confidence')::numeric, v_field ->> 'refusal', v_field ->> 'missing',
      private.ai_redact(v_field ->> 'source_excerpt'), v_position, v_capability);
    v_position := v_position + 1;
    v_capability := null;
  end loop;

  perform private.emit_event(v_request.org_id, 'ai_suggestion.proposed', 'ai_suggestions', v_suggestion, null,
    jsonb_build_object('operation_id', p_operation_id, 'feature', v_request.feature));
  return v_suggestion;
end;
$$;

comment on function app.ai_propose_suggestion(uuid, text, uuid, text, jsonb) is 'Stores a change an answered request proposes, with its fields (field_path, value, confidence, or refusal NO_ANSWER with missing, and source_excerpt). Only the person who asked. Nothing is written to the target until they confirm. A field listed in private.ai_restricted_fields for the operation gets its restricted_capability set here when it carries a value or an excerpt, never from the caller, and a value in it from a caller without that capability refuses aurora_field_restricted (B15).';

call private.install_policies('app.ai_suggestion_fields',
  'private.ai_suggestion_visible(suggestion_id) and (restricted_capability is null or private.has_capability(org_id, restricted_capability))');

-- 6. Comments --------------------------------------------------------------------------------------------------------------

comment on column app.ai_settings.extraction_enabled is 'Document extraction from riders, insurance certificates, invoices, receipts and quotes, and, in intake batches, from itineraries, booking contracts and riders, with the line items of invoices and receipts.';
comment on column app.ai_settings.drafting_enabled is 'Drafting of SOPs, advance packets, emails, day sheets, change order descriptions, running orders, risk assessments, advance answers, event plans, event briefs, approval packs and waste plans.';
comment on column app.ai_suggestions.operation_id is 'Public API operation that performs the change, for example records.create or savedViews.create. A drafted list''s suggestions (drafting requests about app.run_of_show or app.projects) are applied together by app.apply_drafted_list. An intake batch''s suggestions (aurora.applyItineraries, aurora.applyContracts, riders.create and riderLines.create on extraction requests about app.ai_intake_batches) are applied together by app.apply_itinerary_intake or app.apply_contract_intake, and a drafted advance answer (aurora.applyAdvanceAnswer, a drafting request about app.advance_recipients) by app.apply_drafted_advance_answer.';

-- Privileges ---------------------------------------------------------------------------------------------------------------

revoke all on function private.guard_ai_intake_batch() from public, anon, authenticated;
revoke all on function private.guard_intake_request() from public, anon, authenticated;
revoke all on function private.aurora_batch_apply_only() from public, anon, authenticated;
revoke all on function app.start_ai_intake(uuid, app.ai_intake_kind, integer, uuid) from public, anon;
revoke all on function app.close_ai_intake(uuid) from public, anon;
revoke all on function app.ai_propose_suggestion(uuid, text, uuid, text, jsonb) from public, anon;

grant execute on function app.start_ai_intake(uuid, app.ai_intake_kind, integer, uuid) to authenticated, service_role;
grant execute on function app.close_ai_intake(uuid) to authenticated, service_role;
grant execute on function app.ai_propose_suggestion(uuid, text, uuid, text, jsonb) to authenticated, service_role;

-- ADR 0110: the batches carry no title, so the sync adds nothing; it runs so Trash is registered by the migrations.
select private.sync_trash_tables();

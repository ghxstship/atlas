-- 0650_aurora_core.sql
-- A25 AI Features (ADR 0004 range 0650 to 0699). Aurora AI is the name of the Section 4.7 features (ADR 0020).
--
--   * app.ai_settings          one row per org with a switch per feature; every feature is off until an Admin
--                              (org.ai.write) turns it on, and an absent row means every feature is off
--   * app.ai_requests          one row per model call: who asked, for which feature, with which configured model,
--                              and the prompt and output with personal data redacted (Section 4.7 guardrails)
--   * app.ai_usage             the metering ledger the plan allowance counts (ADR 0020): one row per authorized
--                              request with its token counts
--   * app.ai_suggestions       changes a feature proposes, pending human confirmation; nothing is written until the
--                              person who asked confirms (Section 4.7: confirmation before writes)
--   * app.ai_suggestion_fields the proposed field values with a confidence score each, or NO_ANSWER when the
--                              source does not support a value (the silence rule, Section 3.7)
--
-- Gating (ADR 0020): app.ai_begin_request checks membership, private.org_has_feature(org, 'aurora_ai'), the org's
-- switch for the feature, then private.assert_within_plan_limit(org, 'aurora_requests_per_month', used + 1), under a
-- per-org advisory lock so concurrent requests cannot overrun the allowance.
--
-- What is never sent to a model (Section 4.7, Section 14.3): every Restricted column in private.column_classifications
-- and every table in private.ai_excluded_tables (medical encounters). app.ai_never_send lists both for packages/ai.
--
-- Policies take column values as arguments and never re-read the table being scanned (ADR 0016 item 14).

-- Enums ---------------------------------------------------------------------------------------------------------------

create type app.ai_feature as enum ('assistant', 'plain_language', 'extraction', 'drafting', 'summaries', 'mapping');
comment on type app.ai_feature is 'Aurora AI features (Section 4.7): the assistant, ask in plain language, document extraction, drafting, summaries and mapping help. Labels come from the aurora catalog keyed by this value.';

create type app.ai_request_outcome as enum ('Pending', 'Answered', 'No Answer', 'Failed');
comment on type app.ai_request_outcome is 'How a model call ended: still running (Pending), Answered, No Answer when the data did not support an answer (Section 3.7), or Failed.';

create type app.ai_suggestion_state as enum ('Proposed', 'Confirmed', 'Applied', 'Rejected', 'Expired');
comment on type app.ai_suggestion_state is 'AI suggestion lifecycle: Proposed and waiting for the person who asked, Confirmed by them, Applied once the public API accepted the write, Rejected by them, or Expired unanswered. Confirmed returns to Proposed when the API refuses the write.';

insert into private.lifecycle_transition_rules (lifecycle, from_state, to_state) values
  ('ai_suggestion', 'Proposed', 'Confirmed'),
  ('ai_suggestion', 'Proposed', 'Rejected'),
  ('ai_suggestion', 'Proposed', 'Expired'),
  ('ai_suggestion', 'Confirmed', 'Applied'),
  ('ai_suggestion', 'Confirmed', 'Proposed');

insert into private.domain_event_types (code, subject, description) values
  ('ai_suggestion.proposed', 'ai_suggestions', 'An AI feature proposed a change for a person to confirm.'),
  ('ai_suggestion.confirmed', 'ai_suggestions', 'A person confirmed an AI suggestion.'),
  ('ai_suggestion.applied', 'ai_suggestions', 'A confirmed AI suggestion was written through the public API.'),
  ('ai_suggestion.rejected', 'ai_suggestions', 'A person rejected an AI suggestion.'),
  ('ai_settings.changed', 'ai_settings', 'An Admin turned an AI feature on or off.');

-- Never sent ------------------------------------------------------------------------------------------------------------

create table private.ai_excluded_tables (
  table_name text primary key,
  reason text not null,
  constraint ai_excluded_tables_name_format check (table_name ~ '^[a-z_]+\.[a-z_]+$'),
  constraint ai_excluded_tables_reason_length check (char_length(btrim(reason)) between 1 and 300)
);

comment on table private.ai_excluded_tables is 'Tables no AI feature ever reads or sends to a model, whole, whatever their column classification (Section 4.7, Section 14.3).';
comment on column private.ai_excluded_tables.table_name is 'Schema-qualified table or view.';
comment on column private.ai_excluded_tables.reason is 'Why the table is excluded.';

alter table private.ai_excluded_tables enable row level security;
revoke all on private.ai_excluded_tables from public, anon, authenticated;
grant select on private.ai_excluded_tables to service_role;

insert into private.ai_excluded_tables (table_name, reason) values
  ('app.medical_encounters', 'Medical encounter records are excluded from AI features (Section 14.3).'),
  ('app.medical_encounters_masked', 'Medical encounter records are excluded from AI features (Section 14.3).');

create view app.ai_never_send as
select e.table_name, null::text as column_name, e.reason from private.ai_excluded_tables e
union all
select c.table_name, c.column_name, 'Restricted columns are never sent to a model (Section 4.7).'
from private.column_classifications c
where c.classification = 'Restricted';

call private.describe('app.ai_never_send', 'Everything packages/ai strips before a model call: whole excluded tables (column_name null) and every Restricted column (Section 4.7).', array[
  'table_name', 'Schema-qualified table or view.',
  'column_name', 'Restricted column, or null when the whole table is excluded.',
  'reason', 'Why it is never sent.'
]);
revoke all on app.ai_never_send from public, anon;
grant select on app.ai_never_send to authenticated, service_role;

-- Redaction ---------------------------------------------------------------------------------------------------------------
-- packages/ai redacts before it calls the database; this function repeats the pattern pass in the database so a
-- client that skipped it still cannot store an email address, phone number, card number or government identifier.

create or replace function private.ai_redact(p_text text)
returns text
language sql
immutable
set search_path = ''
as $$
  select regexp_replace(
    regexp_replace(
      regexp_replace(
        regexp_replace(p_text,
          '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}', '[email]', 'g'),
        '\m\d{3}-\d{2}-\d{4}\M', '[government id]', 'g'),
      '\m(?:\d[ -]?){13,19}\M', '[card number]', 'g'),
    '(?:\+\d{1,3}[ .-]?)?\(?\d{3}\)?[ .-]\d{3}[ .-]\d{4}\M', '[phone]', 'g');
$$;

comment on function private.ai_redact(text) is 'Replaces email addresses, US Social Security numbers, card-length digit runs and phone numbers with labels. The database pass behind the packages/ai redactor.';

-- Settings ----------------------------------------------------------------------------------------------------------------

create table app.ai_settings (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  assistant_enabled boolean not null default false,
  plain_language_enabled boolean not null default false,
  extraction_enabled boolean not null default false,
  drafting_enabled boolean not null default false,
  summaries_enabled boolean not null default false,
  mapping_enabled boolean not null default false
);

create unique index ai_settings_org_key on app.ai_settings (org_id);

call private.install_domain_table('app.ai_settings');
call private.describe('app.ai_settings', 'Aurora AI switches, one row per org (Section 4.7). Every feature is off until an Admin holding org.ai.write turns it on; an org without a row has every feature off. A feature can be turned on only while the plan includes aurora_ai (ADR 0020).', array[
  'assistant_enabled', 'The assistant (Cmd or Ctrl+J in Atlas, the More menu in Compass).',
  'plain_language_enabled', 'Ask in plain language: a sentence becomes a saved view or filter.',
  'extraction_enabled', 'Document extraction from riders, insurance certificates, invoices, receipts and quotes.',
  'drafting_enabled', 'Drafting of SOPs, advance packets, emails, day sheets and change order descriptions.',
  'summaries_enabled', 'Summaries of record activity, a project''s week and gate readiness.',
  'mapping_enabled', 'Mapping help for import columns and unknown scanned codes.'
]);
call private.install_policies('app.ai_settings',
  'org_id in (select private.my_org_ids())',
  'private.has_capability(org_id, ''org.ai.write'')');

create or replace function private.guard_ai_settings()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (new.assistant_enabled or new.plain_language_enabled or new.extraction_enabled
      or new.drafting_enabled or new.summaries_enabled or new.mapping_enabled)
     and not private.org_has_feature(new.org_id, 'aurora_ai') then
    perform private.refuse('aurora_not_in_plan', 'Aurora AI is not in this org''s plan. Upgrade to Core or above to turn features on.');
  end if;
  return new;
end;
$$;

comment on function private.guard_ai_settings() is 'Before insert or update on app.ai_settings: refuses turning any feature on while the plan lacks aurora_ai. Turning features off is always allowed.';

create trigger t40_guard_ai_settings before insert or update on app.ai_settings
  for each row execute function private.guard_ai_settings();

create trigger t90_emit_ai_settings after insert or update on app.ai_settings
  for each row execute function private.emit_row_event('ai_settings.changed', '-',
    'assistant_enabled', 'plain_language_enabled', 'extraction_enabled', 'drafting_enabled', 'summaries_enabled', 'mapping_enabled');

create or replace function private.ai_feature_enabled(p_org_id uuid, p_feature app.ai_feature)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select case p_feature
      when 'assistant' then s.assistant_enabled
      when 'plain_language' then s.plain_language_enabled
      when 'extraction' then s.extraction_enabled
      when 'drafting' then s.drafting_enabled
      when 'summaries' then s.summaries_enabled
      when 'mapping' then s.mapping_enabled
    end
    from app.ai_settings s where s.org_id = p_org_id and s.deleted_at is null), false);
$$;

comment on function private.ai_feature_enabled(uuid, app.ai_feature) is 'True when an Admin has turned the feature on for the org. No settings row means off (Section 3.7: an absent claim refuses).';

-- Requests ----------------------------------------------------------------------------------------------------------------

create table app.ai_requests (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  person_id uuid not null references app.people (id),
  feature app.ai_feature not null,
  model text not null,
  subject_table text,
  subject_id uuid,
  outcome app.ai_request_outcome not null default 'Pending',
  prompt_redacted text,
  output_redacted text,
  failure_code text,
  completed_at timestamptz,
  constraint ai_requests_model_format check (model ~ '^[a-z0-9][a-z0-9.-]{1,99}$'),
  constraint ai_requests_subject_pair check ((subject_table is null) = (subject_id is null)),
  constraint ai_requests_subject_format check (subject_table is null or subject_table ~ '^[a-z_]+\.[a-z_]+$'),
  constraint ai_requests_completion check ((outcome = 'Pending') = (completed_at is null)),
  constraint ai_requests_failure check ((outcome = 'Failed') = (failure_code is not null)),
  constraint ai_requests_failure_format check (failure_code is null or failure_code ~ '^[a-z][a-z_]{1,63}$'),
  constraint ai_requests_prompt_length check (prompt_redacted is null or char_length(prompt_redacted) <= 200000),
  constraint ai_requests_output_length check (output_redacted is null or char_length(output_redacted) <= 200000)
);

create index ai_requests_person_idx on app.ai_requests (person_id);

call private.install_domain_table('app.ai_requests');
create index ai_requests_org_created_idx on app.ai_requests (org_id, created_at desc);
call private.describe('app.ai_requests', 'One row per Aurora AI model call (Section 4.7): who asked, for which feature, with which configured model, about which record, and the prompt and output with personal data redacted. Written only by app.ai_begin_request and app.ai_complete_request. Kept under the audit retention rules; customer data is never used for training.', array[
  'person_id', 'Person who asked, set from the session. The model acted with their permissions only.',
  'feature', 'Feature that made the call.',
  'model', 'Model identifier read from configuration at call time, for example claude-sonnet-5-5.',
  'subject_table', 'Table of the record the request was about, or null.',
  'subject_id', 'Record the request was about, or null.',
  'outcome', 'Pending, Answered, No Answer or Failed.',
  'prompt_redacted', 'Prompt as sent, with personal data replaced by labels. Restricted fields were never in it.',
  'output_redacted', 'Model output, with personal data replaced by labels.',
  'failure_code', 'Why a Failed request failed, for example model_timeout.',
  'completed_at', 'When the request finished; null while Pending.'
]);
call private.install_policies('app.ai_requests',
  'person_id = (select private.current_person_id()) or org_id in (select private.orgs_with_capability(''audit.log.read''))');
revoke update on app.ai_requests from authenticated;

-- ai_request_is_mine reads app.ai_requests, never app.ai_usage, so the usage policy does not re-read its own table.
create or replace function private.ai_request_is_mine(p_request_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from app.ai_requests r
    where r.id = p_request_id and r.person_id = private.current_person_id() and r.deleted_at is null);
$$;

comment on function private.ai_request_is_mine(uuid) is 'True when the signed-in person made the request. Policies on usage and suggestions pass the request id column.';

-- Usage -------------------------------------------------------------------------------------------------------------------

create table app.ai_usage (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  request_id uuid not null references app.ai_requests (id) on delete cascade,
  metered_at timestamptz not null default now(),
  input_tokens integer,
  output_tokens integer,
  constraint ai_usage_input_tokens check (input_tokens is null or input_tokens >= 0),
  constraint ai_usage_output_tokens check (output_tokens is null or output_tokens >= 0)
);

create unique index ai_usage_request_key on app.ai_usage (request_id);
create index ai_usage_org_metered_idx on app.ai_usage (org_id, metered_at);

call private.install_domain_table('app.ai_usage', 'app.ai_requests', 'request_id');
call private.describe('app.ai_usage', 'Aurora AI metering (ADR 0020): one row per authorized request. The monthly allowance aurora_requests_per_month counts these rows by metered_at in UTC months. Token counts arrive when the request completes. Kept for billing after request content is purged.', array[
  'request_id', 'Request metered.',
  'metered_at', 'When the request was authorized and counted.',
  'input_tokens', 'Input tokens the model reported, or null until the request completes.',
  'output_tokens', 'Output tokens the model reported, or null until the request completes.'
]);
call private.install_policies('app.ai_usage',
  'org_id in (select private.orgs_with_capability(''org.usage.read'')) or private.ai_request_is_mine(request_id)');

create or replace function private.ai_requests_this_month(p_org_id uuid)
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  select count(*) from app.ai_usage u
  where u.org_id = p_org_id
    and u.metered_at >= (date_trunc('month', now() at time zone 'UTC') at time zone 'UTC');
$$;

comment on function private.ai_requests_this_month(uuid) is 'Aurora requests the org has made in the current UTC calendar month (ADR 0020).';

-- Suggestions -------------------------------------------------------------------------------------------------------------

create table app.ai_suggestions (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  request_id uuid not null references app.ai_requests (id) on delete cascade,
  operation_id text not null,
  target_id uuid,
  summary text not null,
  suggestion_state app.ai_suggestion_state not null default 'Proposed',
  expires_at timestamptz not null default now() + interval '7 days',
  applied_id uuid,
  constraint ai_suggestions_operation_format check (operation_id ~ '^[a-z][A-Za-z0-9]*\.[a-z][A-Za-z0-9]*$'),
  constraint ai_suggestions_summary_length check (char_length(btrim(summary)) between 1 and 1000)
);

create index ai_suggestions_request_idx on app.ai_suggestions (request_id);
create index ai_suggestions_state_idx on app.ai_suggestions (org_id, suggestion_state, expires_at);

call private.install_domain_table('app.ai_suggestions', 'app.ai_requests', 'request_id');
call private.describe('app.ai_suggestions', 'A change an Aurora feature proposes (Section 4.7). Nothing is written until the person who asked confirms; the confirmed write then goes through the public API operation named here with their own token, so it can never do more than they can. The summary says exactly what will change.', array[
  'request_id', 'Request that proposed the change.',
  'operation_id', 'Public API operation that performs the change, for example records.create or savedViews.create.',
  'target_id', 'Record the change updates, or null when it creates one.',
  'summary', 'What will change, in one or two sentences, shown on the confirmation step.',
  'suggestion_state', 'Proposed, Confirmed, Applied, Rejected or Expired. Changes only through app.transition_ai_suggestion.',
  'expires_at', 'After this time the suggestion can no longer be confirmed.',
  'applied_id', 'Record the public API wrote or updated, set when the suggestion is Applied.'
]);
create or replace function private.ai_suggestion_visible(p_suggestion_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from app.ai_suggestions s join app.ai_requests r on r.id = s.request_id
    where s.id = p_suggestion_id
      and (r.person_id = private.current_person_id()
        or s.org_id in (select private.orgs_with_capability('audit.log.read'))));
$$;

comment on function private.ai_suggestion_visible(uuid) is 'True when the signed-in person may read a suggestion: they asked for it, or they read the org audit log. Policies on the suggestion ledger and fields pass the suggestion id column.';

call private.install_policies('app.ai_suggestions',
  'private.ai_request_is_mine(request_id) or org_id in (select private.orgs_with_capability(''audit.log.read''))');
revoke update on app.ai_suggestions from authenticated;
call private.install_lifecycle('app.ai_suggestions', 'suggestion_id', 'suggestion_state', 'ai_suggestion', 'Proposed',
  'private.ai_suggestion_visible(suggestion_id)');

create table app.ai_suggestion_fields (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  suggestion_id uuid not null references app.ai_suggestions (id) on delete cascade,
  field_path text not null,
  proposed_value jsonb,
  confidence numeric(4, 3),
  refusal text,
  missing text,
  source_excerpt text,
  position smallint not null,
  constraint ai_suggestion_fields_path_format check (field_path ~ '^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$'),
  constraint ai_suggestion_fields_confidence_range check (confidence is null or confidence between 0 and 1),
  constraint ai_suggestion_fields_refusal_values check (refusal is null or refusal = 'NO_ANSWER'),
  constraint ai_suggestion_fields_value_or_refusal check (
    (refusal is null and proposed_value is not null and confidence is not null and missing is null)
    or (refusal is not null and proposed_value is null and confidence is null and missing is not null)),
  constraint ai_suggestion_fields_missing_length check (missing is null or char_length(btrim(missing)) between 1 and 500),
  constraint ai_suggestion_fields_excerpt_length check (source_excerpt is null or char_length(source_excerpt) <= 2000),
  constraint ai_suggestion_fields_position check (position >= 0)
);

create unique index ai_suggestion_fields_path_key on app.ai_suggestion_fields (suggestion_id, field_path);

call private.install_domain_table('app.ai_suggestion_fields', 'app.ai_suggestions', 'suggestion_id');
call private.describe('app.ai_suggestion_fields', 'Proposed field values of an AI suggestion, each with a confidence score and provenance agent (rank 40, Section 3.8). A field the source does not support carries NO_ANSWER and what is missing instead of a guessed value (Section 3.7). The value is the model''s output (a provider payload).', array[
  'suggestion_id', 'Suggestion the field belongs to.',
  'field_path', 'API field the value is for, for example title or insurance.expires_on.',
  'proposed_value', 'Proposed value as JSON; null when the field is NO_ANSWER.',
  'confidence', 'Confidence from 0 to 1; null when the field is NO_ANSWER.',
  'refusal', 'NO_ANSWER when the source does not support a value; otherwise null.',
  'missing', 'What the source lacks, when the field is NO_ANSWER.',
  'source_excerpt', 'The passage of the source the value was read from, redacted, so the person can check it.',
  'position', 'Order on the confirmation step.'
]);
call private.install_policies('app.ai_suggestion_fields', 'private.ai_suggestion_visible(suggestion_id)');

-- RPCs --------------------------------------------------------------------------------------------------------------------

create or replace function app.ai_begin_request(
  p_org_id uuid,
  p_feature app.ai_feature,
  p_model text,
  p_subject_table text default null,
  p_subject_id uuid default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_me uuid := private.current_person_id();
  v_request uuid;
begin
  if v_me is null or not private.is_member(p_org_id) then
    raise exception using errcode = '42501', message = 'Aurora requests need an active membership in the org';
  end if;
  if not private.org_has_feature(p_org_id, 'aurora_ai') then
    perform private.refuse('aurora_not_in_plan', 'Aurora AI is not in this org''s plan. Upgrade to Core or above to use it.');
  end if;
  if not private.ai_feature_enabled(p_org_id, p_feature) then
    perform private.refuse('aurora_feature_off', format('An Admin has not turned on %s in Settings, AI Features.', replace(p_feature::text, '_', ' ')));
  end if;
  -- One request at a time per org passes the count, so concurrent requests cannot overrun the allowance.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('aurora:' || p_org_id::text, 0));
  perform private.assert_within_plan_limit(p_org_id, 'aurora_requests_per_month', private.ai_requests_this_month(p_org_id) + 1);

  insert into app.ai_requests (org_id, person_id, feature, model, subject_table, subject_id)
  values (p_org_id, v_me, p_feature, p_model, p_subject_table, p_subject_id)
  returning id into v_request;
  insert into app.ai_usage (request_id) values (v_request);
  return v_request;
end;
$$;

comment on function app.ai_begin_request(uuid, app.ai_feature, text, text, uuid) is 'Authorizes and meters one Aurora request (ADR 0020): active membership, aurora_ai in the plan, the feature turned on, and the monthly allowance (XR001 plan_limit_exceeded when it is used up). Returns the request id the caller completes with app.ai_complete_request.';

create or replace function app.ai_complete_request(
  p_request_id uuid,
  p_outcome app.ai_request_outcome,
  p_prompt text,
  p_output text,
  p_input_tokens integer default null,
  p_output_tokens integer default null,
  p_failure_code text default null
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_request app.ai_requests;
begin
  select * into v_request from app.ai_requests r where r.id = p_request_id and r.deleted_at is null for update;
  if v_request.id is null or v_request.person_id is distinct from private.current_person_id() then
    raise exception using errcode = '42501', message = 'only the person who asked completes a request';
  end if;
  if v_request.outcome <> 'Pending' then
    perform private.refuse('ai_request_already_complete', 'This request has already finished.');
  end if;
  if p_outcome = 'Pending' then
    perform private.refuse('ai_request_outcome_required', 'A finished request is Answered, No Answer or Failed.');
  end if;
  update app.ai_requests set
    outcome = p_outcome,
    prompt_redacted = private.ai_redact(p_prompt),
    output_redacted = private.ai_redact(p_output),
    failure_code = p_failure_code,
    completed_at = now()
  where id = p_request_id;
  update app.ai_usage set input_tokens = p_input_tokens, output_tokens = p_output_tokens
  where request_id = p_request_id;
end;
$$;

comment on function app.ai_complete_request(uuid, app.ai_request_outcome, text, text, integer, integer, text) is 'Records how a request ended, with the prompt and output redacted again by private.ai_redact, and the token counts. Only the person who asked, once.';

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
    insert into app.ai_suggestion_fields (suggestion_id, field_path, proposed_value, confidence, refusal, missing, source_excerpt, position)
    values (v_suggestion, v_field ->> 'field_path',
      case when v_field ? 'value' and jsonb_typeof(v_field -> 'value') <> 'null' then v_field -> 'value' end,
      (v_field ->> 'confidence')::numeric, v_field ->> 'refusal', v_field ->> 'missing',
      private.ai_redact(v_field ->> 'source_excerpt'), v_position);
    v_position := v_position + 1;
  end loop;

  perform private.emit_event(v_request.org_id, 'ai_suggestion.proposed', 'ai_suggestions', v_suggestion, null,
    jsonb_build_object('operation_id', p_operation_id, 'feature', v_request.feature));
  return v_suggestion;
end;
$$;

comment on function app.ai_propose_suggestion(uuid, text, uuid, text, jsonb) is 'Stores a change an answered request proposes, with its fields (field_path, value, confidence, or refusal NO_ANSWER with missing, and source_excerpt). Only the person who asked. Nothing is written to the target until they confirm.';

create or replace function app.transition_ai_suggestion(
  p_suggestion_id uuid,
  p_expected app.ai_suggestion_state,
  p_next app.ai_suggestion_state,
  p_reason text,
  p_applied_id uuid default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_suggestion app.ai_suggestions;
  v_entry uuid;
begin
  select * into v_suggestion from app.ai_suggestions s where s.id = p_suggestion_id and s.deleted_at is null;
  if v_suggestion.id is null or not private.ai_request_is_mine(v_suggestion.request_id) then
    raise exception using errcode = '42501', message = 'only the person who asked decides on a suggestion';
  end if;
  if p_next = 'Expired' then
    perform private.refuse('ai_suggestion_expiry_system', 'Suggestions expire on their own; reject it instead.');
  end if;
  if p_next = 'Confirmed' and v_suggestion.expires_at <= now() then
    perform private.refuse('ai_suggestion_expired', 'This suggestion has expired. Ask again to get a fresh one.');
  end if;
  if (p_next = 'Applied') <> (p_applied_id is not null) then
    perform private.refuse('ai_suggestion_applied_id', 'An applied suggestion names the record the API wrote, and only then.');
  end if;

  v_entry := private.transition_lifecycle('ai_suggestion', 'app.ai_suggestions', 'suggestion_state',
    'app.ai_suggestion_state_transitions', 'suggestion_id', p_suggestion_id, p_expected::text, p_next::text, p_reason);
  if p_next = 'Applied' then
    perform private.begin_trusted_operation('ai_suggestion_transition');
    update app.ai_suggestions set applied_id = p_applied_id where id = p_suggestion_id;
    perform private.end_trusted_operation('ai_suggestion_transition');
  end if;
  if p_next in ('Confirmed', 'Applied', 'Rejected') then
    perform private.emit_event(v_suggestion.org_id, 'ai_suggestion.' || lower(p_next::text), 'ai_suggestions',
      p_suggestion_id, null, jsonb_build_object('operation_id', v_suggestion.operation_id));
  end if;
  return v_entry;
end;
$$;

comment on function app.transition_ai_suggestion(uuid, app.ai_suggestion_state, app.ai_suggestion_state, text, uuid) is 'Moves a suggestion with compare-and-set: the person who asked confirms or rejects it, marks it Applied with the record the public API wrote, or returns it to Proposed when the API refused the write. Expiry belongs to private.expire_ai_suggestions.';

create or replace function private.expire_ai_suggestions()
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_count integer := 0;
begin
  for v_id in
    select s.id from app.ai_suggestions s
    where s.suggestion_state = 'Proposed' and s.expires_at <= now() and s.deleted_at is null
  loop
    perform private.transition_lifecycle('ai_suggestion', 'app.ai_suggestions', 'suggestion_state',
      'app.ai_suggestion_state_transitions', 'suggestion_id', v_id, 'Proposed', 'Expired', 'Expired unanswered.');
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

comment on function private.expire_ai_suggestions() is 'Moves every Proposed suggestion past its expiry to Expired. Run by the platform job runner; returns the number expired.';

create or replace function app.ai_allowance(p_org_id uuid)
returns table (used bigint, allowance bigint, plan_includes_aurora boolean)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.is_member(p_org_id) then
    raise exception using errcode = '42501', message = 'Aurora allowance needs an active membership in the org';
  end if;
  return query select private.ai_requests_this_month(p_org_id),
    private.plan_limit(p_org_id, 'aurora_requests_per_month'),
    private.org_has_feature(p_org_id, 'aurora_ai');
end;
$$;

comment on function app.ai_allowance(uuid) is 'This month''s Aurora requests for the org, its monthly allowance (null when unlimited) and whether the plan includes Aurora AI. Members only.';

create or replace function app.ai_enabled_features(p_org_id uuid)
returns setof app.ai_feature
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  -- plpgsql resolves 'aurora_ai' at call time: the enum value arrives in 0901, after this migration.
  if not private.is_member(p_org_id) or not private.org_has_feature(p_org_id, 'aurora_ai') then
    return;
  end if;
  return query select f from unnest(enum_range(null::app.ai_feature)) as f
    where private.ai_feature_enabled(p_org_id, f);
end;
$$;

comment on function app.ai_enabled_features(uuid) is 'Features a member may use right now: turned on by an Admin and included in the plan. Empty for non-members.';

-- Retention -----------------------------------------------------------------------------------------------------------------
-- Request logs follow the audit retention rule (7 years from creation, Section 4.7). Usage, suggestions, their fields and
-- their ledger leave with the request they belong to.

alter table app.ai_suggestion_state_transitions
  drop constraint ai_suggestion_state_transitions_suggestion_id_fkey,
  add constraint ai_suggestion_state_transitions_suggestion_id_fkey
    foreign key (suggestion_id) references app.ai_suggestions (id) on delete cascade;

call private.install_default_retention('app.ai_settings');
insert into private.retention_policies (table_name, basis, time_column, retention, purge_method, rationale) values
  ('app.ai_requests', 'Age', 'created_at', interval '7 years', 'Delete', 'Aurora prompt and output logs, redacted, kept under the audit retention rule.'),
  ('app.ai_usage', 'Age', 'metered_at', interval '7 years', 'Delete', 'Aurora metering kept as long as the request log it counts.'),
  ('app.ai_suggestions', 'Age', 'created_at', interval '7 years', 'Delete', 'Kept as long as the request that proposed it.'),
  ('app.ai_suggestion_fields', 'Age', 'created_at', interval '7 years', 'Delete', 'Kept as long as their suggestion.'),
  ('app.ai_suggestion_state_transitions', 'Age', 'created_at', interval '7 years', 'Delete', 'Confirmation evidence kept as long as the suggestion.')
on conflict (table_name) do nothing;

-- Privileges --------------------------------------------------------------------------------------------------------------

revoke all on function private.ai_redact(text) from public, anon;
revoke all on function private.guard_ai_settings() from public, anon, authenticated;
revoke all on function private.ai_feature_enabled(uuid, app.ai_feature) from public, anon, authenticated;
revoke all on function private.ai_request_is_mine(uuid) from public, anon;
revoke all on function private.ai_requests_this_month(uuid) from public, anon, authenticated;
revoke all on function private.ai_suggestion_visible(uuid) from public, anon;
revoke all on function private.expire_ai_suggestions() from public, anon, authenticated;
revoke all on function app.ai_begin_request(uuid, app.ai_feature, text, text, uuid) from public, anon;
revoke all on function app.ai_complete_request(uuid, app.ai_request_outcome, text, text, integer, integer, text) from public, anon;
revoke all on function app.ai_propose_suggestion(uuid, text, uuid, text, jsonb) from public, anon;
revoke all on function app.transition_ai_suggestion(uuid, app.ai_suggestion_state, app.ai_suggestion_state, text, uuid) from public, anon;
revoke all on function app.ai_allowance(uuid) from public, anon;
revoke all on function app.ai_enabled_features(uuid) from public, anon;

grant execute on function private.ai_redact(text) to authenticated, service_role;
grant execute on function private.ai_request_is_mine(uuid) to authenticated, service_role;
grant execute on function private.ai_suggestion_visible(uuid) to authenticated, service_role;
grant execute on function private.expire_ai_suggestions() to service_role;
grant execute on function app.ai_begin_request(uuid, app.ai_feature, text, text, uuid) to authenticated, service_role;
grant execute on function app.ai_complete_request(uuid, app.ai_request_outcome, text, text, integer, integer, text) to authenticated, service_role;
grant execute on function app.ai_propose_suggestion(uuid, text, uuid, text, jsonb) to authenticated, service_role;
grant execute on function app.transition_ai_suggestion(uuid, app.ai_suggestion_state, app.ai_suggestion_state, text, uuid) to authenticated, service_role;
grant execute on function app.ai_allowance(uuid) to authenticated, service_role;
grant execute on function app.ai_enabled_features(uuid) to authenticated, service_role;

-- 6506_public_form_links.sql
-- B2 (RRR-226, ADR 0141; parity gap G-293). A tokenised public mode for workforce forms (0803), which before this took
-- submissions from members only (anon had no path by design). A form link lets people outside the org answer one
-- Published form: a supplier's safety check-in, a guest survey, an incident report from a venue's staff.
--   * app.form_links: one link and 6-digit access code per audience (Section 7.5 invariant 8): an expiry within 90
--     days, an optional project the responses belong to, a cap of 1 to 1000 in any 24 hours, an optional total cap and
--     one response per email by default. Only holders of knowledge.sop.publish in the org make, regenerate and revoke
--     them, and only for a Published form whose current version has no photo field, signature or GPS stamp
--     (form_link_unsupported): those stay member-only.
--   * Spam controls: the open checks the token and code as open_live_link does (form_link.failure and
--     form_link.hop_failure); a grant (xfrg_) lasts 2 hours; a submit under 3 seconds after the grant is refused; 10
--     submits an hour per relayed address and 500 per reaching address; the rolling cap and total cap are counted from
--     app.form_submissions under the link's row lock (no stored count); one response per email; answers of at most
--     32 KB; and a hidden website field (a honeypot) answers ok and stores nothing. There is no CAPTCHA by design: it
--     would need an external service account.
--   * app.form_submissions takes link responses: no member submitter, the link, and the respondent's name and email
--     (Confidential). A link response is always filed Submitted and becomes a project record only when a holder of
--     knowledge.sop.publish or the approver role approves it (app.decide_form_submission): a recorded departure from
--     Section 4.9's wording for member submissions (ADR 0141 decision 5).
--   * app.submit_form keeps its exact signature and behavior (it is replayed by apply_sync_mutation, 0807); its answer
--     validation and scoring move into private.check_form_answers, which the public submit calls too, so both refuse
--     with the same codes.
-- Each redefined function starts from its latest definition (0803).

insert into private.domain_event_types (code, subject, description) values
  ('form_link.created', 'form_links', 'A public link was made for a published form.'),
  ('form_link.regenerated', 'form_links', 'A public form link was regenerated: a new token and access code.'),
  ('form_link.revoked', 'form_links', 'A public form link was revoked.')
on conflict (code) do nothing;

insert into private.read_only_exempt_tables (table_name, rationale) values
  ('app.form_links', 'Revoking a form link withdraws access; new links and regeneration are refused by the form link RPCs.')
on conflict (table_name) do nothing;

create table app.form_links (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  form_template_id uuid not null references app.form_templates (id),
  project_id uuid references app.projects (id),
  note text,
  token_hash bytea not null,
  token_hint text not null,
  access_code_hash bytea not null,
  expires_at timestamptz not null,
  daily_cap integer not null default 200,
  max_responses integer,
  one_per_email boolean not null default true,
  failed_attempts smallint not null default 0,
  rotated_at timestamptz,
  revoked_at timestamptz,
  revoked_by uuid references app.people (id),
  constraint form_links_note_length check (note is null or char_length(btrim(note)) between 1 and 200),
  constraint form_links_token_hash_length check (octet_length(token_hash) = 32),
  constraint form_links_code_hash_length check (octet_length(access_code_hash) = 32),
  constraint form_links_token_hint check (token_hint ~ '^[0-9a-f]{4}$'),
  constraint form_links_daily_cap check (daily_cap between 1 and 1000),
  constraint form_links_max_responses check (max_responses is null or max_responses between 1 and 10000),
  constraint form_links_failed_attempts check (failed_attempts between 0 and 5),
  constraint form_links_revoked check ((revoked_at is null) = (revoked_by is null)),
  constraint form_links_template_key unique (id, form_template_id),
  constraint form_links_project_key unique (id, project_id)
);

create unique index form_links_token_key on app.form_links (token_hash);
create index form_links_template_idx on app.form_links (form_template_id);
create index form_links_project_idx on app.form_links (project_id);
create index form_links_revoked_by_idx on app.form_links (revoked_by);

call private.install_domain_table('app.form_links', 'app.form_templates', 'form_template_id', array['app.projects', 'project_id']);
call private.describe('app.form_links', 'Public links to a Published form (ADR 0141): people outside the org open it with a 6-digit access code and answer it without an account. Responses are filed Submitted and become project records only when approved. The token and code are returned once and stored only as hashes. Made by app.create_form_link, changed only by app.regenerate_form_link and app.revoke_form_link, opened by api_public.open_form_link.', array[
  'form_template_id', 'Form the link answers; Published, with no photo field, signature or GPS stamp.',
  'project_id', 'Project the responses belong to, when the link names one; an approved response becomes a record there.',
  'note', 'What the link is for, for the team. Never shown on the public page.',
  'token_hash', 'SHA-256 of the link token (xfrm_ and 256 random bits in hex). Never readable by signed-in callers.',
  'token_hint', 'Last four characters of the token, to tell links apart.',
  'access_code_hash', 'SHA-256 of the token, a colon and the 6-digit access code. Never readable by signed-in callers.',
  'expires_at', 'When the link stops opening: after it was made and at most 90 days ahead.',
  'daily_cap', 'Most responses the link takes in any 24 hours, 1 to 1000; counted from app.form_submissions.',
  'max_responses', 'Most responses the link takes in all, 1 to 10000, or none.',
  'one_per_email', 'True when each email address answers the link once.',
  'failed_attempts', 'Wrong access codes since the link was made or regenerated; the link locks at 5 until regenerated.',
  'rotated_at', 'When the link was last regenerated.',
  'revoked_at', 'When the link was revoked; a revoked link never opens again.',
  'revoked_by', 'Person who revoked the link.'
]);
call private.install_audit_trail('app.form_links');
call private.install_default_retention('app.form_links', interval '2 years');

call private.install_policies('app.form_links',
  $$org_id in (select private.orgs_with_capability('knowledge.sop.publish')) and private.is_member(org_id)$$);
revoke select, insert, update, delete on app.form_links from authenticated;
grant select (id, org_id, form_template_id, project_id, note, token_hint, expires_at, daily_cap, max_responses, one_per_email,
  failed_attempts, rotated_at, revoked_at, revoked_by, created_at, created_by, updated_at, updated_by, deleted_at)
  on app.form_links to authenticated;

create or replace function private.guard_form_link()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.in_trusted_operation('form_link_service') then
    perform private.refuse('form_link_immutable', 'A form link is made, opened, regenerated and revoked only through its RPCs.');
  end if;
  if tg_op = 'UPDATE' and (new.form_template_id <> old.form_template_id or new.project_id is distinct from old.project_id) then
    perform private.refuse('form_link_immutable', 'A form link keeps its form and project; make a new link instead.');
  end if;
  if tg_op = 'UPDATE' and old.revoked_at is not null and new.revoked_at is distinct from old.revoked_at then
    perform private.refuse('form_link_revoked', 'A revoked form link stays revoked. Make a new link instead.');
  end if;
  return new;
end;
$$;

comment on function private.guard_form_link() is 'Form links: rows are inserted and changed only inside the form link RPCs (trusted operation form_link_service); a link keeps its form and project, and a revoked link stays revoked.';
revoke all on function private.guard_form_link() from public, anon, authenticated;

create trigger t40_guard_form_link before insert or update on app.form_links
  for each row execute function private.guard_form_link();

create table private.form_link_grants (
  grant_hash bytea primary key,
  org_id uuid not null references app.organizations (id),
  form_link_id uuid not null references app.form_links (id),
  issued_at timestamptz not null default now(),
  expires_at timestamptz not null,
  constraint form_link_grants_hash_length check (octet_length(grant_hash) = 32)
);

create index form_link_grants_org_idx on private.form_link_grants (org_id);
create index form_link_grants_link_idx on private.form_link_grants (form_link_id);
create index form_link_grants_expires_idx on private.form_link_grants (expires_at);

comment on table private.form_link_grants is 'Grants a correct form link access code earns (ADR 0141): kept by Gateway in an HttpOnly cookie on /forms/{token} for 2 hours. issued_at gives the minimum fill time (3 seconds). Only the SHA-256 is stored; regenerating or revoking the link deletes them.';
comment on column private.form_link_grants.grant_hash is 'SHA-256 of the grant (xfrg_ and 256 random bits in hex).';
comment on column private.form_link_grants.org_id is 'Org of the link; deleting the org (1351) takes the grant with it.';
comment on column private.form_link_grants.form_link_id is 'Form link the grant opens.';
comment on column private.form_link_grants.issued_at is 'When the grant was issued; a submit less than 3 seconds later is refused.';
comment on column private.form_link_grants.expires_at is 'When the grant stops working: the link''s expiry or 2 hours after the open, whichever comes first.';

alter table private.form_link_grants enable row level security;
revoke all on private.form_link_grants from public, anon, authenticated;
grant select on private.form_link_grants to service_role;

create table private.retired_form_link_tokens (
  token_hash bytea primary key,
  retired_at timestamptz not null default now(),
  constraint retired_form_link_tokens_hash_length check (octet_length(token_hash) = 32)
);

create index retired_form_link_tokens_retired_idx on private.retired_form_link_tokens (retired_at);

comment on table private.retired_form_link_tokens is 'SHA-256 hashes of form link tokens regenerated away or revoked, kept a year so an old link answers form_link_invalid without counting as a failed guess (as P1''s retired live link tokens).';
comment on column private.retired_form_link_tokens.token_hash is 'SHA-256 of the retired token.';
comment on column private.retired_form_link_tokens.retired_at is 'When the token was regenerated away or revoked.';

alter table private.retired_form_link_tokens enable row level security;
revoke all on private.retired_form_link_tokens from public, anon, authenticated;
grant select on private.retired_form_link_tokens to service_role;

select cron.schedule('xos_prune_form_link_tokens', '55 4 * * *', $$
  delete from private.retired_form_link_tokens where retired_at < now() - interval '1 year';
  delete from private.form_link_grants where expires_at < now() - interval '1 day';
$$);

insert into private.trash_excluded_tables (table_name, rationale) values
  ('form_links', 'Revoked, replaced, never restored: a revoked form link never opens again; a new link is made instead.')
on conflict (table_name) do nothing;

select private.sync_trash_tables();

-- Link responses on form submissions ------------------------------------------------------------------------------------

alter table app.form_submissions
  alter column submitted_by_membership_id drop not null,
  add column form_link_id uuid,
  add column respondent_name text,
  add column respondent_email text,
  add constraint form_submissions_form_link_fkey foreign key (form_link_id, form_template_id)
    references app.form_links (id, form_template_id),
  add constraint form_submissions_form_link_project_fkey foreign key (form_link_id, project_id)
    references app.form_links (id, project_id),
  add constraint form_submissions_one_submitter check (num_nonnulls(submitted_by_membership_id, form_link_id) = 1
    and (form_link_id is null) = (respondent_name is null) and (form_link_id is null) = (respondent_email is null)),
  add constraint form_submissions_respondent_name_length check (respondent_name is null
    or char_length(btrim(respondent_name)) between 1 and 200),
  add constraint form_submissions_respondent_email_format check (respondent_email is null
    or (respondent_email = lower(btrim(respondent_email)) and respondent_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'
        and char_length(respondent_email) <= 320));

create index form_submissions_form_link_idx on app.form_submissions (form_link_id, created_at);
create index form_submissions_form_link_template_idx on app.form_submissions (form_link_id, form_template_id);
create index form_submissions_form_link_project_idx on app.form_submissions (form_link_id, project_id);
create index form_submissions_form_link_email_idx on app.form_submissions (form_link_id, lower(respondent_email));

comment on column app.form_submissions.submitted_by_membership_id is 'Member who submitted; null for a response through a public form link (6506).';
comment on column app.form_submissions.form_link_id is 'Public form link a response came through (ADR 0141); null for a member''s submission.';
comment on column app.form_submissions.respondent_name is 'Name the outside respondent gave, for a link response only.';
comment on column app.form_submissions.respondent_email is 'Email the outside respondent gave, lower case, for a link response only. Confidential.';

insert into private.column_classifications (table_name, column_name, classification, read_capability) values
  ('app.form_submissions', 'respondent_email', 'Confidential', null)
on conflict (table_name, column_name) do nothing;

-- Redefined from 0803: link responses are inserted in the form link service, and a submitter, member or link, never
-- changes once set.
create or replace function private.guard_form_submission()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' and not (private.in_trusted_operation('submit_form') or private.in_trusted_operation('form_link_service')) then
    perform private.refuse('form_submission_rpc', 'Forms are submitted through app.submit_form.');
  end if;
  if tg_op = 'UPDATE' and (new.answers <> old.answers or new.form_template_version_id <> old.form_template_version_id
     or new.submitted_by_membership_id is distinct from old.submitted_by_membership_id
     or new.form_link_id is distinct from old.form_link_id or new.respondent_name is distinct from old.respondent_name
     or new.respondent_email is distinct from old.respondent_email or new.score is distinct from old.score
     or new.signed_at is distinct from old.signed_at or new.latitude is distinct from old.latitude
     or new.project_id is distinct from old.project_id
     or (old.record_id is not null and new.record_id is distinct from old.record_id)) then
    perform private.refuse('form_submission_fixed', 'A submission keeps its answers, score, signature and GPS stamp.');
  end if;
  return new;
end;
$$;
comment on function private.guard_form_submission() is 'Form submissions are created only by app.submit_form, or by api_public.submit_public_form for a public link response (6506), and keep their answers, score, signature, GPS stamp, project and submitter (the member, or the link and the respondent''s name and email).';
revoke all on function private.guard_form_submission() from public, anon, authenticated;

-- Answer validation and scoring, moved out of app.submit_form (0803) with the same rules, so the public submit refuses
-- with the same codes.
create or replace function private.check_form_answers(
  p_fields jsonb,
  p_answers jsonb,
  out o_score numeric,
  out o_max numeric,
  out o_scored boolean
)
language plpgsql
stable
set search_path = ''
as $$
declare
  v_field jsonb;
  v_answer jsonb;
  v_kind text;
  v_points jsonb;
  v_choice text;
begin
  o_score := 0;
  o_max := 0;
  o_scored := false;
  if jsonb_typeof(p_answers) is distinct from 'object' then
    perform private.refuse('form_answers', 'Answers come as an object keyed by field key.');
  end if;
  for v_field in select jsonb_array_elements(p_fields) loop
    v_kind := v_field ->> 'kind';
    v_answer := p_answers -> (v_field ->> 'key');
    if not private.form_field_shown(v_field, p_answers) then
      if v_answer is not null and v_answer <> 'null'::jsonb then
        perform private.refuse('form_answer_hidden', format('%s is hidden by its condition; leave it empty.', v_field ->> 'label'));
      end if;
      continue;
    end if;
    if v_field ? 'points' then
      o_scored := true;
      o_max := o_max + coalesce((select max(value::numeric) from jsonb_each_text(v_field -> 'points')), 0);
    end if;
    if v_answer is null or v_answer = 'null'::jsonb or v_answer = '""'::jsonb or v_answer = '[]'::jsonb then
      if coalesce((v_field ->> 'required')::boolean, false) then
        perform private.refuse('form_answer_required',
          format('%s is required.%s', v_field ->> 'label', case when v_kind = 'photo' then ' Add at least one photo.' else '' end));
      end if;
      continue;
    end if;
    if (v_kind in ('text', 'long_text', 'date', 'choice') and jsonb_typeof(v_answer) <> 'string')
       or (v_kind = 'number' and jsonb_typeof(v_answer) <> 'number')
       or (v_kind = 'yes_no' and jsonb_typeof(v_answer) <> 'boolean')
       or (v_kind in ('multi_choice', 'photo') and jsonb_typeof(v_answer) <> 'array') then
      perform private.refuse('form_answer_type', format('%s has the wrong kind of answer.', v_field ->> 'label'));
    end if;
    if v_kind = 'choice' and not ((v_field -> 'choices') @> jsonb_build_array(v_answer)) then
      perform private.refuse('form_answer_choice', format('%s takes one of its listed choices.', v_field ->> 'label'));
    end if;
    if v_kind = 'multi_choice' and not ((v_field -> 'choices') @> v_answer) then
      perform private.refuse('form_answer_choice', format('%s takes only its listed choices.', v_field ->> 'label'));
    end if;
    if v_kind = 'date' then
      if (v_answer #>> '{}') !~ '^\d{4}-\d{2}-\d{2}$' then
        perform private.refuse('form_answer_date', format('%s takes a date as YYYY-MM-DD.', v_field ->> 'label'));
      end if;
    end if;
    if v_kind = 'photo' then
      if exists (select 1 from jsonb_array_elements(v_answer) p (path)
                 where jsonb_typeof(p.path) <> 'string' or char_length(p.path #>> '{}') > 500 or (p.path #>> '{}') !~ '^[a-z0-9][a-z0-9/_.-]*$') then
        perform private.refuse('form_answer_photo', format('%s takes uploaded photo paths.', v_field ->> 'label'));
      end if;
    end if;
    if v_kind in ('text', 'long_text') then
      if char_length(v_answer #>> '{}') > (case when v_kind = 'text' then 500 else 10000 end) then
        perform private.refuse('form_answer_length', format('%s is too long.', v_field ->> 'label'));
      end if;
    end if;
    if v_field ? 'points' then
      v_points := v_field -> 'points';
      if v_kind = 'multi_choice' then
        for v_choice in select jsonb_array_elements_text(v_answer) loop
          o_score := o_score + coalesce((v_points ->> v_choice)::numeric, 0);
        end loop;
      else
        o_score := o_score + coalesce((v_points ->> (v_answer #>> '{}'))::numeric, 0);
      end if;
    end if;
  end loop;
end;
$$;

comment on function private.check_form_answers(jsonb, jsonb) is 'Validates answers against a form version''s fields and scores them, with app.submit_form''s rules (0803): answers as an object keyed by field key (form_answers), hidden fields left empty (form_answer_hidden), required shown fields answered (form_answer_required), answers of the field''s kind (form_answer_type), listed choices (form_answer_choice), dates as YYYY-MM-DD (form_answer_date), uploaded photo paths (form_answer_photo) and text up to 500 or long text up to 10000 characters (form_answer_length). Answers the points earned, the points available on the shown fields, and whether any shown field scores. Called by app.submit_form and api_public.submit_public_form (6506).';
revoke all on function private.check_form_answers(jsonb, jsonb) from public, anon, authenticated;

create or replace function app.submit_form(
  p_template_id uuid,
  p_answers jsonb,
  p_project_id uuid default null,
  p_location jsonb default null,
  p_signature jsonb default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_template app.form_templates;
  v_version app.form_template_versions;
  v_mine uuid;
  v_checked record;
  v_record uuid;
  v_id uuid;
begin
  perform private.require_person();
  select * into v_template from app.form_templates t where t.id = p_template_id and t.deleted_at is null;
  if v_template.id is null or v_template.id not in (select private.readable_form_template_ids()) then
    raise exception using errcode = '42501', message = 'the form does not exist or is not visible';
  end if;
  if v_template.template_state <> 'Published' then
    perform private.refuse('form_not_published', 'This form is not taking submissions.');
  end if;
  v_mine := private.require_membership_in(v_template.org_id);
  select * into v_version from app.form_template_versions v where v.form_template_id = p_template_id and v.version = v_template.current_version;
  if jsonb_typeof(p_answers) is distinct from 'object' then
    perform private.refuse('form_answers', 'Answers come as an object keyed by field key.');
  end if;
  if p_project_id is not null and not exists (select 1 from app.projects p where p.id = p_project_id and p.org_id = v_template.org_id
       and p.id in (select private.readable_project_ids())) then
    raise exception using errcode = '42501', message = 'the project does not exist or is not visible';
  end if;

  select * into v_checked from private.check_form_answers(v_version.fields, p_answers);

  if v_version.requires_location and (p_location is null or p_location ->> 'latitude' is null or p_location ->> 'longitude' is null) then
    perform private.refuse('form_location_required', 'This form needs a GPS stamp; allow location and submit again.');
  end if;
  if v_version.requires_signature and (p_signature is null or coalesce(btrim(p_signature ->> 'signer_name'), '') = ''
       or coalesce(p_signature ->> 'signature_path', '') = '') then
    perform private.refuse('form_signature_required', 'This form needs a signature and the signer''s name.');
  end if;

  if p_project_id is not null then
    insert into app.records (org_id, project_id, record_kind, record_subtype, title, xyz, xyz_basis)
    values (v_template.org_id, p_project_id, v_template.record_kind, v_template.record_subtype, left(btrim(v_template.name), 200), 'Y', 'Declared')
    returning id into v_record;
  end if;

  perform private.begin_trusted_operation('submit_form');
  insert into app.form_submissions (form_template_id, form_template_version_id, project_id, record_id, submitted_by_membership_id,
    answers, score, max_score, passed, latitude, longitude, accuracy_m, signer_name, signature_path, signed_at)
  values (p_template_id, v_version.id, p_project_id, v_record, v_mine, p_answers,
    case when v_checked.o_scored then v_checked.o_score end, case when v_checked.o_scored then v_checked.o_max end,
    case when v_version.pass_score is not null and v_checked.o_scored then v_checked.o_score >= v_version.pass_score end,
    (p_location ->> 'latitude')::numeric, (p_location ->> 'longitude')::numeric, (p_location ->> 'accuracy_m')::numeric,
    case when p_signature is not null then btrim(p_signature ->> 'signer_name') end,
    case when p_signature is not null then p_signature ->> 'signature_path' end,
    case when p_signature is not null then now() end)
  returning id into v_id;
  perform private.end_trusted_operation('submit_form');

  if v_template.approver_role_id is null then
    perform private.begin_trusted_operation('form_submission_transition');
    update app.form_submissions set submission_state = 'Recorded' where id = v_id;
    perform private.end_trusted_operation('form_submission_transition');
    insert into app.form_submission_state_transitions (form_submission_id, from_state, to_state, reason)
    values (v_id, 'Submitted', 'Recorded', 'The form needs no approval.');
  end if;

  perform private.emit_event(v_template.org_id, 'form_submission.submitted', 'form_submissions', v_id, p_project_id,
    jsonb_build_object('form_template_id', p_template_id, 'version', v_version.version, 'record_id', v_record,
      'score', case when v_checked.o_scored then v_checked.o_score end));
  return v_id;
end;
$$;
comment on function app.submit_form(uuid, jsonb, uuid, jsonb, jsonb) is 'Submits a published form as the signed-in member. Answers are keyed by field key; hidden fields must stay empty, required shown fields must be answered, choices must be listed and photos are uploaded field-media paths (private.check_form_answers, 6506). p_location {latitude, longitude, accuracy_m} and p_signature {signer_name, signature_path} are required when the form says so. Scores the answers, makes a record of the form''s kind and subtype when a project is given, and files it as Submitted (with an approver role) or Recorded. Returns the submission id.';
revoke all on function app.submit_form(uuid, jsonb, uuid, jsonb, jsonb) from public, anon;
grant execute on function app.submit_form(uuid, jsonb, uuid, jsonb, jsonb) to authenticated, service_role;

-- Redefined from 0803: approving a link response on a project makes its record, as a member's submission makes one when
-- it is submitted.
create or replace function app.decide_form_submission(p_submission_id uuid, p_approve boolean, p_note text default null)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_submission app.form_submissions;
  v_template app.form_templates;
  v_mine uuid;
  v_ledger uuid;
  v_record uuid;
begin
  perform private.require_person();
  select * into v_submission from app.form_submissions s where s.id = p_submission_id and s.deleted_at is null;
  if v_submission.id is null or v_submission.id not in (select private.readable_form_submission_ids()) then
    raise exception using errcode = '42501', message = 'the submission does not exist or is not visible';
  end if;
  select * into v_template from app.form_templates t where t.id = v_submission.form_template_id;
  v_mine := private.my_membership_in(v_submission.org_id);
  if not (private.has_capability(v_submission.org_id, 'knowledge.sop.publish')
          or exists (select 1 from app.membership_roles mr where mr.role_id = v_template.approver_role_id
                     and mr.membership_id = v_mine and mr.deleted_at is null)) then
    perform private.refuse('form_approval_authority', 'Only a holder of the form''s approver role decides its submissions.');
  end if;
  if v_mine = v_submission.submitted_by_membership_id then
    perform private.refuse('sod_form_submitter', 'The person who submitted a form cannot approve or reject it.');
  end if;
  if not p_approve and coalesce(btrim(p_note), '') = '' then
    perform private.refuse('form_rejection_note', 'Say why the submission is rejected, so the submitter can fix it.');
  end if;
  v_ledger := private.transition_lifecycle('form_submission', 'app.form_submissions', 'submission_state',
    'app.form_submission_state_transitions', 'form_submission_id', p_submission_id, 'Submitted',
    case when p_approve then 'Approved' else 'Rejected' end, coalesce(nullif(btrim(p_note), ''), 'Approved.'));
  if p_approve and v_submission.form_link_id is not null and v_submission.project_id is not null and v_submission.record_id is null then
    insert into app.records (org_id, project_id, record_kind, record_subtype, title, xyz, xyz_basis)
    values (v_submission.org_id, v_submission.project_id, v_template.record_kind, v_template.record_subtype,
      left(btrim(v_template.name), 200), 'Y', 'Declared')
    returning id into v_record;
  end if;
  update app.form_submissions set decided_by_membership_id = v_mine, decision_note = nullif(btrim(p_note), ''),
    record_id = coalesce(record_id, v_record)
  where id = p_submission_id;
  perform private.emit_event(v_submission.org_id, 'form_submission.decided', 'form_submissions', p_submission_id, v_submission.project_id,
    jsonb_build_object('approved', p_approve, 'record_id', coalesce(v_submission.record_id, v_record)));
  return v_ledger;
end;
$$;
comment on function app.decide_form_submission(uuid, boolean, text) is 'Approves or rejects a submitted form as a holder of its approver role or knowledge.sop.publish, never the submitter. A rejection needs a note. Approving a public link response on a project makes its record of the form''s kind and subtype (6506; ADR 0141 decision 5). Returns the ledger entry id.';
revoke all on function app.decide_form_submission(uuid, boolean, text) from public, anon;
grant execute on function app.decide_form_submission(uuid, boolean, text) to authenticated, service_role;

-- Making, regenerating and revoking links -------------------------------------------------------------------------------

create or replace function app.create_form_link(
  p_template_id uuid,
  p_expires_at timestamptz,
  p_project_id uuid default null,
  p_daily_cap integer default 200,
  p_max_responses integer default null,
  p_one_per_email boolean default true,
  p_note text default null
)
returns table (form_link_id uuid, token text, access_code text, expires_at timestamptz)
language plpgsql
volatile
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_template app.form_templates;
  v_version app.form_template_versions;
  v_token text := 'xfrm_' || encode(extensions.gen_random_bytes(32), 'hex');
  v_code text := private.new_live_link_code();
  v_id uuid;
begin
  perform private.require_person();
  select * into v_template from app.form_templates t where t.id = p_template_id and t.deleted_at is null;
  if v_template.id is null or not private.is_member(v_template.org_id)
     or v_template.id not in (select private.readable_form_template_ids()) then
    raise exception using errcode = '42501', message = 'the form does not exist or is not visible';
  end if;
  if not private.has_capability(v_template.org_id, 'knowledge.sop.publish') then
    raise exception using errcode = '42501', message = 'knowledge.sop.publish is required';
  end if;
  if private.org_read_only(v_template.org_id) then
    perform private.refuse('org_read_only', 'This organization is canceled and read-only. The Owner can reactivate it in Settings, Danger zone, during the 30 days.');
  end if;
  if v_template.template_state <> 'Published' then
    perform private.refuse('form_not_published', 'Publish the form before you share it by link.');
  end if;
  select * into v_version from app.form_template_versions v where v.form_template_id = v_template.id and v.version = v_template.current_version;
  if v_version.requires_signature or v_version.requires_location
     or exists (select 1 from jsonb_array_elements(v_version.fields) f where f ->> 'kind' = 'photo') then
    perform private.refuse('form_link_unsupported', 'Forms with photos, signatures or a GPS stamp are filled in by members only.');
  end if;
  if p_project_id is not null and not exists (
    select 1 from app.projects p where p.id = p_project_id and p.org_id = v_template.org_id and p.deleted_at is null
      and p.id in (select private.readable_project_ids())) then
    raise exception using errcode = '42501', message = 'the project does not exist or is not visible';
  end if;
  if p_expires_at is null or p_expires_at <= now() or p_expires_at > now() + interval '90 days' then
    perform private.refuse('form_link_expiry_range', 'A form link expires after now and within 90 days.');
  end if;
  perform private.begin_trusted_operation('form_link_service');
  insert into app.form_links as l (form_template_id, project_id, note, token_hash, token_hint, access_code_hash, expires_at,
    daily_cap, max_responses, one_per_email)
  values (v_template.id, p_project_id, nullif(btrim(coalesce(p_note, '')), ''), private.share_token_hash(v_token), right(v_token, 4),
    private.share_code_hash(v_token, v_code), p_expires_at, coalesce(p_daily_cap, 200), p_max_responses, coalesce(p_one_per_email, true))
  returning l.id into v_id;
  perform private.end_trusted_operation('form_link_service');
  perform private.emit_event(v_template.org_id, 'form_link.created', 'form_links', v_id, p_project_id,
    jsonb_build_object('form_template_id', v_template.id, 'expires_at', p_expires_at));
  return query select v_id, v_token, v_code, p_expires_at;
end;
$$;

comment on function app.create_form_link(uuid, timestamptz, uuid, integer, integer, boolean, text) is 'Makes a public link to a form (ADR 0141): needs membership of its org and knowledge.sop.publish, an org that is not read-only, a Published form (form_not_published) whose current version has no photo field, signature or GPS stamp (form_link_unsupported), a project the caller reads in the same org when one is named, and an expiry after now and within 90 days. Returns the token and the 6-digit access code once; only their hashes are kept.';
revoke all on function app.create_form_link(uuid, timestamptz, uuid, integer, integer, boolean, text) from public, anon;
grant execute on function app.create_form_link(uuid, timestamptz, uuid, integer, integer, boolean, text) to authenticated, service_role;

create or replace function private.manageable_form_link(p_id uuid)
returns app.form_links
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_link app.form_links;
begin
  perform private.require_person();
  select * into v_link from app.form_links l where l.id = p_id and l.deleted_at is null for update;
  if v_link.id is null or not private.is_member(v_link.org_id) or not private.has_capability(v_link.org_id, 'knowledge.sop.publish') then
    raise exception using errcode = '42501', message = 'form link not found';
  end if;
  return v_link;
end;
$$;

comment on function private.manageable_form_link(uuid) is 'Locks and returns a form link the signed-in person may regenerate or revoke: a member of its org holding knowledge.sop.publish; otherwise raises form link not found.';
revoke all on function private.manageable_form_link(uuid) from public, anon, authenticated;

create or replace function app.regenerate_form_link(p_id uuid)
returns table (token text, access_code text, expires_at timestamptz)
language plpgsql
volatile
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_link app.form_links := private.manageable_form_link(p_id);
  v_token text := 'xfrm_' || encode(extensions.gen_random_bytes(32), 'hex');
  v_code text := private.new_live_link_code();
begin
  if v_link.revoked_at is not null then
    perform private.refuse('form_link_revoked', 'A revoked form link stays revoked. Make a new link instead.');
  end if;
  if private.org_read_only(v_link.org_id) then
    perform private.refuse('org_read_only', 'This organization is canceled and read-only. The Owner can reactivate it in Settings, Danger zone, during the 30 days.');
  end if;
  insert into private.retired_form_link_tokens (token_hash) values (v_link.token_hash) on conflict do nothing;
  perform private.begin_trusted_operation('form_link_service');
  update app.form_links
  set token_hash = private.share_token_hash(v_token), token_hint = right(v_token, 4),
    access_code_hash = private.share_code_hash(v_token, v_code), failed_attempts = 0, rotated_at = now()
  where id = v_link.id;
  perform private.end_trusted_operation('form_link_service');
  delete from private.form_link_grants g where g.form_link_id = v_link.id;
  perform private.emit_event(v_link.org_id, 'form_link.regenerated', 'form_links', v_link.id, v_link.project_id, '{}'::jsonb);
  return query select v_token, v_code, v_link.expires_at;
end;
$$;

comment on function app.regenerate_form_link(uuid) is 'Regenerates a public form link (ADR 0141): a new token and access code returned once, wrong-code attempts reset (which unlocks a locked link) and every grant dropped. The old token stays retired a year, so it answers form_link_invalid without counting a failure. Refused for a revoked link and in a read-only org. Needs knowledge.sop.publish.';
revoke all on function app.regenerate_form_link(uuid) from public, anon;
grant execute on function app.regenerate_form_link(uuid) to authenticated, service_role;

create or replace function app.revoke_form_link(p_id uuid)
returns timestamptz
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
  v_link app.form_links := private.manageable_form_link(p_id);
begin
  if v_link.revoked_at is not null then
    return v_link.revoked_at;
  end if;
  insert into private.retired_form_link_tokens (token_hash) values (v_link.token_hash) on conflict do nothing;
  perform private.begin_trusted_operation('form_link_service');
  update app.form_links set revoked_at = now(), revoked_by = v_person where id = v_link.id;
  perform private.end_trusted_operation('form_link_service');
  delete from private.form_link_grants g where g.form_link_id = v_link.id;
  perform private.emit_event(v_link.org_id, 'form_link.revoked', 'form_links', v_link.id, v_link.project_id, '{}'::jsonb);
  return now();
end;
$$;

comment on function app.revoke_form_link(uuid) is 'Revokes a public form link so it never opens again (ADR 0141); responses already in stay. Idempotent. Allowed in a read-only org, since it withdraws access. Needs knowledge.sop.publish.';
revoke all on function app.revoke_form_link(uuid) from public, anon;
grant execute on function app.revoke_form_link(uuid) to authenticated, service_role;

-- Opening, reading and answering a link ----------------------------------------------------------------------------------

create or replace function private.form_link_rate_limited(p_hop text, p_subject text)
returns boolean
language sql
volatile
security definer
set search_path = ''
as $$
  select private.rate_limit_exceeded('form_link.failure', p_subject, 20, interval '10 minutes')
    or private.rate_limit_exceeded('form_link.hop_failure', p_hop, 2000, interval '15 minutes');
$$;

comment on function private.form_link_rate_limited(text, text) is 'True when an address used up its form link failures: 20 per relayed address in 10 minutes, or 2000 per reaching address in 15 minutes.';
revoke all on function private.form_link_rate_limited(text, text) from public, anon, authenticated;

create or replace function private.note_form_link_failure(p_hop text, p_subject text)
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  select private.note_rate_event('form_link.failure', p_subject);
  select private.note_rate_event('form_link.hop_failure', p_hop);
$$;

comment on function private.note_form_link_failure(text, text) is 'Counts one failed form link lookup or wrong code against the relayed and the reaching address.';
revoke all on function private.note_form_link_failure(text, text) from public, anon, authenticated;

create or replace function api_public.open_form_link(p_token text, p_access_code text default null, p_client_address text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_subjects record;
  v_hash bytea;
  v_link app.form_links;
  v_grant text;
  v_grant_expires timestamptz;
begin
  perform private.require_read_write();
  select * into v_subjects from private.live_link_subjects(p_client_address);
  if private.form_link_rate_limited(v_subjects.o_hop, v_subjects.o_subject) then
    return private.live_link_refusal('form_link_rate_limited');
  end if;
  if p_token is not null and p_token ~ '^xfrm_[0-9a-f]{64}$' then
    v_hash := private.share_token_hash(p_token);
    select * into v_link from app.form_links l where l.token_hash = v_hash for update;
  end if;
  if v_link.id is null then
    if v_hash is null or not exists (select 1 from private.retired_form_link_tokens r where r.token_hash = v_hash) then
      perform private.note_form_link_failure(v_subjects.o_hop, v_subjects.o_subject);
    end if;
    return private.live_link_refusal('form_link_invalid');
  end if;
  if v_link.revoked_at is not null or v_link.deleted_at is not null then
    return private.live_link_refusal('form_link_invalid');
  end if;
  if v_link.failed_attempts >= 5 then
    perform private.note_form_link_failure(v_subjects.o_hop, v_subjects.o_subject);
    return private.live_link_refusal('form_link_locked');
  end if;
  if v_link.expires_at <= now() then
    return private.live_link_refusal('form_link_expired');
  end if;
  if nullif(btrim(coalesce(p_access_code, '')), '') is null then
    return private.live_link_refusal('form_link_access_code_required');
  end if;
  if v_link.access_code_hash <> private.share_code_hash(p_token, p_access_code) then
    perform private.begin_trusted_operation('form_link_service');
    update app.form_links l set failed_attempts = least(l.failed_attempts + 1, 5) where l.id = v_link.id;
    perform private.end_trusted_operation('form_link_service');
    perform private.note_form_link_failure(v_subjects.o_hop, v_subjects.o_subject);
    return private.live_link_refusal(case when v_link.failed_attempts + 1 >= 5 then 'form_link_locked' else 'form_link_access_code' end);
  end if;
  if (select t.template_state from app.form_templates t where t.id = v_link.form_template_id) <> 'Published' then
    return private.live_link_refusal('form_not_published');
  end if;

  delete from private.form_link_grants g where g.expires_at < now() - interval '1 day';
  v_grant := 'xfrg_' || encode(extensions.gen_random_bytes(32), 'hex');
  v_grant_expires := least(v_link.expires_at, now() + interval '2 hours');
  insert into private.form_link_grants (grant_hash, org_id, form_link_id, expires_at)
  values (private.share_token_hash(v_grant), v_link.org_id, v_link.id, v_grant_expires);
  return jsonb_build_object('status', 'ok', 'grant', v_grant, 'grant_expires_at', v_grant_expires);
end;
$$;

comment on function api_public.open_form_link(text, text, text) is 'Opens a public form link without an account (ADR 0141; Section 7.5 invariant 8). Refuses a read-only (GET) call first; then, unless the address used up its failures (20 per relayed address p_client_address in 10 minutes, 2000 per reaching address in 15; form_link_rate_limited), locks the link and checks it: unknown, revoked or deleted (form_link_invalid; a regenerated token never counts a failure), locked after 5 wrong codes (form_link_locked), expired (form_link_expired), code missing (form_link_access_code_required) or wrong (form_link_access_code, counted), and a form no longer Published (form_not_published). Answers JSON: status refused with the reason, or status ok with a grant valid for 2 hours or until the link expires.';
revoke all on function api_public.open_form_link(text, text, text) from public;
grant execute on function api_public.open_form_link(text, text, text) to anon, authenticated, service_role;

create or replace function private.form_link_reader(
  p_token text,
  p_grant text,
  p_client_address text,
  out o_link app.form_links,
  out o_issued_at timestamptz,
  out o_reason text
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_subjects record;
  v_hash bytea;
  v_grant_hash bytea;
begin
  perform private.require_read_write();
  select * into v_subjects from private.live_link_subjects(p_client_address);
  if p_token is not null and p_token ~ '^xfrm_[0-9a-f]{64}$' then
    v_hash := private.share_token_hash(p_token);
    select * into o_link from app.form_links l where l.token_hash = v_hash;
  end if;
  v_grant_hash := case when p_grant ~ '^xfrg_[0-9a-f]{64}$' then private.share_token_hash(p_grant) end;
  if o_link.id is not null and v_grant_hash is not null then
    select g.issued_at into o_issued_at from private.form_link_grants g
    where g.grant_hash = v_grant_hash and g.form_link_id = o_link.id and g.expires_at > now();
  end if;
  if o_issued_at is null and private.form_link_rate_limited(v_subjects.o_hop, v_subjects.o_subject) then
    o_reason := 'form_link_rate_limited';
    return;
  end if;
  if o_link.id is null then
    if v_hash is null or not exists (select 1 from private.retired_form_link_tokens r where r.token_hash = v_hash) then
      perform private.note_form_link_failure(v_subjects.o_hop, v_subjects.o_subject);
    end if;
    o_reason := 'form_link_invalid';
  elsif o_link.revoked_at is not null or o_link.deleted_at is not null then
    o_reason := 'form_link_invalid';
  elsif o_link.expires_at <= now() then
    o_reason := 'form_link_expired';
  elsif o_issued_at is null then
    o_reason := 'form_link_grant';
  elsif (select t.template_state from app.form_templates t where t.id = o_link.form_template_id) <> 'Published' then
    o_reason := 'form_not_published';
  end if;
end;
$$;

comment on function private.form_link_reader(text, text, text) is 'Checks a public form read or submit: refuses a read-only transaction first, then the address failure limits (only without a valid grant), the token (form_link_invalid, form_link_expired), the grant (form_link_grant) and that the form is still Published (form_not_published). Answers the link and when its grant was issued, or the reason.';
revoke all on function private.form_link_reader(text, text, text) from public, anon, authenticated;

create or replace function api_public.public_form(p_token text, p_grant text, p_client_address text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_read record;
  v_link app.form_links;
begin
  select * into v_read from private.form_link_reader(p_token, p_grant, p_client_address);
  if v_read.o_reason is not null then
    return private.live_link_refusal(v_read.o_reason);
  end if;
  v_link := v_read.o_link;
  return (
    select jsonb_build_object(
      'status', 'ok',
      'meta', jsonb_build_object(
        'brand_name', coalesce(b.display_name, o.name),
        'brand_logo_light_path', b.logo_light_path,
        'brand_logo_dark_path', b.logo_dark_path,
        'brand_accent_hex', b.accent_hex,
        'brand_suppress_powered_by', coalesce(b.suppress_powered_by, false),
        'expires_at', v_link.expires_at),
      'name', t.name,
      'description', t.description,
      'fields', coalesce((
        select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
            'key', f ->> 'key', 'label', f ->> 'label', 'kind', f ->> 'kind',
            'required', coalesce((f ->> 'required')::boolean, false), 'choices', f -> 'choices', 'show_if', f -> 'show_if'))
          order by n)
        from jsonb_array_elements(v.fields) with ordinality as x (f, n)), '[]'::jsonb))
    from app.form_templates t
    join app.form_template_versions v on v.form_template_id = t.id and v.version = t.current_version
    join app.organizations o on o.id = t.org_id
    left join app.org_brands b on b.org_id = t.org_id and b.deleted_at is null
    where t.id = v_link.form_template_id);
end;
$$;

comment on function api_public.public_form(text, text, text) is 'Reads a public form with its grant (ADR 0141; Section 7.5 invariant 8). Refuses as private.form_link_reader does. Answers JSON: meta (the brand''s Public columns and the link''s expiry), the form''s name and description, and the current version''s fields with only key, label, kind, required, choices and show_if. Never points, the passing score, the record kind or the approver.';
revoke all on function api_public.public_form(text, text, text) from public;
grant execute on function api_public.public_form(text, text, text) to anon, authenticated, service_role;

create or replace function api_public.submit_public_form(
  p_token text,
  p_grant text,
  p_respondent_name text,
  p_respondent_email text,
  p_answers jsonb,
  p_website text default null,
  p_client_address text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_subjects record;
  v_read record;
  v_link app.form_links;
  v_template app.form_templates;
  v_version app.form_template_versions;
  v_checked record;
  v_name text := btrim(coalesce(p_respondent_name, ''));
  v_email text := lower(btrim(coalesce(p_respondent_email, '')));
  v_id uuid;
begin
  perform private.require_read_write();
  select * into v_subjects from private.live_link_subjects(p_client_address);
  select * into v_read from private.form_link_reader(p_token, p_grant, p_client_address);
  if v_read.o_reason is not null then
    return private.live_link_refusal(v_read.o_reason);
  end if;
  v_link := v_read.o_link;
  if private.org_read_only(v_link.org_id) then
    return private.live_link_refusal('org_read_only');
  end if;
  if private.rate_limit_exceeded('form_link.submit', v_subjects.o_subject, 10, interval '1 hour')
     or private.rate_limit_exceeded('form_link.hop_submit', v_subjects.o_hop, 500, interval '1 hour') then
    return private.live_link_refusal('form_link_rate_limited');
  end if;
  perform private.note_rate_event('form_link.submit', v_subjects.o_subject);
  perform private.note_rate_event('form_link.hop_submit', v_subjects.o_hop);
  -- A filled honeypot is a robot: it is told it worked, and nothing is stored.
  if nullif(btrim(coalesce(p_website, '')), '') is not null then
    return jsonb_build_object('status', 'ok');
  end if;
  if now() - v_read.o_issued_at < interval '3 seconds' then
    return private.live_link_refusal('form_link_too_fast');
  end if;

  -- The caps are counted from the responses under the link's row lock; nothing stores them.
  select * into v_link from app.form_links l where l.id = v_link.id for update;
  if (select count(*) from app.form_submissions s
      where s.form_link_id = v_link.id and s.created_at > now() - interval '24 hours') >= v_link.daily_cap
     or (v_link.max_responses is not null
         and (select count(*) from app.form_submissions s where s.form_link_id = v_link.id) >= v_link.max_responses) then
    return private.live_link_refusal('form_link_rate_limited');
  end if;
  if char_length(v_name) not between 1 and 200 then
    return private.live_link_refusal('form_respondent_name');
  end if;
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' or char_length(v_email) > 320 then
    return private.live_link_refusal('form_respondent_email');
  end if;
  if v_link.one_per_email and exists (
    select 1 from app.form_submissions s where s.form_link_id = v_link.id and lower(s.respondent_email) = v_email) then
    return private.live_link_refusal('form_link_already_answered');
  end if;
  if p_answers is null or octet_length(p_answers::text) > 32768 then
    return private.live_link_refusal(case when p_answers is null then 'form_answers' else 'form_answers_too_large' end);
  end if;

  select * into v_template from app.form_templates t where t.id = v_link.form_template_id;
  select * into v_version from app.form_template_versions v where v.form_template_id = v_template.id and v.version = v_template.current_version;
  begin
    select * into v_checked from private.check_form_answers(v_version.fields, p_answers);
  exception when sqlstate 'XR001' then
    return jsonb_build_object('status', 'refused', 'reason', split_part(sqlerrm, ':', 1),
      'message', btrim(substr(sqlerrm, strpos(sqlerrm, ':') + 1)));
  end;

  perform private.begin_trusted_operation('form_link_service');
  insert into app.form_submissions as s (form_template_id, form_template_version_id, project_id, form_link_id, respondent_name,
    respondent_email, answers, score, max_score, passed)
  values (v_template.id, v_version.id, v_link.project_id, v_link.id, v_name, v_email, p_answers,
    case when v_checked.o_scored then v_checked.o_score end, case when v_checked.o_scored then v_checked.o_max end,
    case when v_version.pass_score is not null and v_checked.o_scored then v_checked.o_score >= v_version.pass_score end)
  returning s.id into v_id;
  perform private.end_trusted_operation('form_link_service');
  insert into app.form_submission_state_transitions (form_submission_id, from_state, to_state, reason)
  values (v_id, null, 'Submitted', 'Submitted via public link');

  perform private.emit_event(v_template.org_id, 'form_submission.submitted', 'form_submissions', v_id, v_link.project_id,
    jsonb_build_object('form_template_id', v_template.id, 'version', v_version.version, 'record_id', null,
      'score', case when v_checked.o_scored then v_checked.o_score end, 'via', 'link'));
  return jsonb_build_object('status', 'ok');
end;
$$;

comment on function api_public.submit_public_form(text, text, text, text, jsonb, text, text) is 'Answers a public form without an account (ADR 0141; Section 7.5 invariant 8). Refuses a read-only (GET) call first, as private.form_link_reader does, a read-only org (org_read_only), more than 10 submits an hour from one relayed address or 500 from one reaching address, the link''s cap in any 24 hours or total cap (form_link_rate_limited), a submit under 3 seconds after the grant (form_link_too_fast), a missing name or malformed email (form_respondent_name, form_respondent_email), a second response from one email when the link allows one (form_link_already_answered), answers over 32 KB (form_answers_too_large) and every refusal app.submit_form would give (private.check_form_answers, same codes). A filled website field (the honeypot) answers ok and stores nothing. Otherwise files the response as Submitted with the respondent''s name and email, on the link''s project, and emits form_submission.submitted with via link. Answers JSON: status ok, or status refused with the reason.';
revoke all on function api_public.submit_public_form(text, text, text, text, jsonb, text, text) from public;
grant execute on function api_public.submit_public_form(text, text, text, text, jsonb, text, text) to anon, authenticated, service_role;

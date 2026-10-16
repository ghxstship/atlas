-- 0803_workforce_forms.sql
-- A29 Workforce Suite (Section 4.9 Forms; managed in Atlas Knowledge, Forms): a no-code form builder with
-- conditional logic, required photos, GPS stamp, signatures, scoring and approval routing.
--   * A template holds its fields as JSON. Each field has a key, label, kind (text, long_text, number,
--     yes_no, choice, multi_choice, date, photo), whether it is required, choices, points for scoring and a
--     show_if rule ({"key": other field, "equals": value}) that hides it unless the rule holds.
--   * Templates: Draft, Published, Retired. Publishing snapshots the fields as a numbered version, so every
--     submission keeps the exact form it answered. knowledge.sop.write drafts; knowledge.sop.publish
--     publishes and retires.
--   * Every submission on a project becomes a record of the template's canon kind and subtype (Section 4.9:
--     "Every submission becomes a record with its own kind and subtype"). Without a project it stays an org
--     submission.
--   * Approval routing: a template names an approver role. Its submissions wait as Submitted until a
--     holder of that role (or knowledge.sop.publish) approves or rejects them, never the submitter. A
--     template with no approver role files submissions as Recorded.
--   * Photo answers are storage paths in the private field-media bucket; offline submissions replay
--     through app.apply_sync_mutation (0807).

create type app.form_template_state as enum ('Draft', 'Published', 'Retired');
comment on type app.form_template_state is 'Form template states: Draft (editable), Published (taking submissions) and Retired (kept, closed).';

create type app.form_submission_state as enum ('Submitted', 'Approved', 'Rejected', 'Recorded');
comment on type app.form_submission_state is 'Form submission states: Submitted (waiting on an approver), Approved, Rejected, or Recorded when the template needs no approval.';

insert into private.lifecycle_transition_rules (lifecycle, from_state, to_state) values
  ('form_template', 'Draft', 'Published'),
  ('form_template', 'Published', 'Retired'),
  ('form_submission', 'Submitted', 'Approved'),
  ('form_submission', 'Submitted', 'Rejected');

insert into private.domain_event_types (code, subject, description) values
  ('form_template.published', 'form_templates', 'A form template version was published.'),
  ('form_submission.submitted', 'form_submissions', 'A form was submitted.'),
  ('form_submission.decided', 'form_submissions', 'An approver approved or rejected a form submission.');

-- Validates a template's field definitions; returns the number of fields.
create or replace function private.assert_form_fields(p_fields jsonb)
returns integer
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_field jsonb;
  v_keys text[] := '{}';
  v_key text;
begin
  if jsonb_typeof(p_fields) <> 'array' or jsonb_array_length(p_fields) not between 1 and 100 then
    perform private.refuse('form_fields', 'A form has 1 to 100 fields.');
  end if;
  for v_field in select jsonb_array_elements(p_fields) loop
    v_key := v_field ->> 'key';
    if v_key is null or v_key !~ '^[a-z][a-z0-9_]{0,39}$' then
      perform private.refuse('form_field_key', 'Each field needs a key of lowercase letters, digits and underscores.');
    end if;
    if v_key = any (v_keys) then
      perform private.refuse('form_field_key', format('The field key %s is used twice.', v_key));
    end if;
    if coalesce(char_length(btrim(v_field ->> 'label')), 0) not between 1 and 200 then
      perform private.refuse('form_field_label', format('Field %s needs a label of up to 200 characters.', v_key));
    end if;
    if coalesce(v_field ->> 'kind', '') not in ('text', 'long_text', 'number', 'yes_no', 'choice', 'multi_choice', 'date', 'photo') then
      perform private.refuse('form_field_kind', format('Field %s has an unknown kind.', v_key));
    end if;
    if (v_field ->> 'kind') in ('choice', 'multi_choice')
       and (jsonb_typeof(v_field -> 'choices') is distinct from 'array' or jsonb_array_length(v_field -> 'choices') not between 2 and 30) then
      perform private.refuse('form_field_choices', format('Field %s needs 2 to 30 choices.', v_key));
    end if;
    if v_field ? 'show_if' and not ((v_field #>> '{show_if,key}') = any (v_keys)) then
      perform private.refuse('form_field_condition', format('Field %s can only depend on a field above it.', v_key));
    end if;
    if v_field ? 'points' and jsonb_typeof(v_field -> 'points') <> 'object' then
      perform private.refuse('form_field_points', format('Field %s gives points as an object from answer to points.', v_key));
    end if;
    v_keys := v_keys || v_key;
  end loop;
  return cardinality(v_keys);
end;
$$;
comment on function private.assert_form_fields(jsonb) is 'Refuses malformed form fields: 1 to 100 fields with unique keys, labels, known kinds, choices for choice fields, conditions only on earlier fields and points as an answer-to-points object.';
revoke all on function private.assert_form_fields(jsonb) from public, anon, authenticated;

create table app.form_templates (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  name text not null,
  description text,
  record_kind text not null references xpms.dim_record_kind (record_kind),
  record_subtype text,
  fields jsonb not null,
  requires_signature boolean not null default false,
  requires_location boolean not null default false,
  pass_score numeric,
  approver_role_id uuid references app.roles (id),
  template_state app.form_template_state not null default 'Draft',
  current_version integer not null default 0,
  constraint form_templates_name_length check (char_length(btrim(name)) between 1 and 200),
  constraint form_templates_description_length check (description is null or char_length(description) <= 2000),
  constraint form_templates_pass_score check (pass_score is null or pass_score >= 0),
  constraint form_templates_version check (current_version >= 0),
  constraint form_templates_kind_subtype_fkey foreign key (record_kind, record_subtype)
    references xpms.dim_record_subtype (record_kind, record_subtype)
);
create index form_templates_kind_idx on app.form_templates (record_kind, record_subtype);
create index form_templates_approver_role_idx on app.form_templates (approver_role_id);
call private.install_domain_table('app.form_templates');
create unique index form_templates_name_key on app.form_templates (org_id, lower(btrim(name))) where deleted_at is null;
call private.describe('app.form_templates', 'A no-code form (Section 4.9 Forms) with conditional fields, photos, GPS stamp, signature, scoring and approval routing. Submissions on a project become records of its canon kind and subtype.', array[
  'name', 'Form name, unique in the org.',
  'description', 'What the form is for and when to fill it in.',
  'record_kind', 'Canon record kind each project submission becomes.',
  'record_subtype', 'Canon record subtype of those records.',
  'fields', 'Field definitions: key, label, kind, required, choices, points and show_if.',
  'requires_signature', 'Whether a submission must be signed.',
  'requires_location', 'Whether a submission must carry a GPS stamp.',
  'pass_score', 'Score a submission needs to pass; NULL when the form is not scored to pass.',
  'approver_role_id', 'Org role whose holders approve submissions; NULL files them as Recorded.',
  'template_state', 'Draft, Published or Retired.',
  'current_version', 'Latest published version number; 0 before the first publish.'
]);

create or replace function private.can_read_form_template(p_org_id uuid, p_state app.form_template_state)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.has_capability(p_org_id, 'knowledge.sop.write')
    or (p_state <> 'Draft' and private.my_membership_in(p_org_id) is not null);
$$;
comment on function private.can_read_form_template(uuid, app.form_template_state) is 'Whether the signed-in person reads a form template: form editors always, every member once it is published.';
revoke all on function private.can_read_form_template(uuid, app.form_template_state) from public, anon;
grant execute on function private.can_read_form_template(uuid, app.form_template_state) to authenticated, service_role;

call private.install_policies('app.form_templates',
  $$private.can_read_form_template(org_id, template_state)$$,
  $$org_id in (select private.orgs_with_capability('knowledge.sop.write'))$$);

create or replace function private.readable_form_template_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select t.id from app.form_templates t
  where t.deleted_at is null and t.org_id in (select private.my_org_ids()) and private.can_read_form_template(t.org_id, t.template_state);
$$;
comment on function private.readable_form_template_ids() is 'Form templates the signed-in person reads.';
revoke all on function private.readable_form_template_ids() from public, anon;
grant execute on function private.readable_form_template_ids() to authenticated, service_role;

call private.install_lifecycle('app.form_templates', 'form_template_id', 'template_state', 'form_template', 'Draft',
  $$form_template_id in (select private.readable_form_template_ids())$$);

-- Fields are validated on every write and change only while the template is a draft.
create or replace function private.guard_form_template()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.assert_form_fields(new.fields);
  if new.approver_role_id is not null and not exists (select 1 from app.roles r where r.id = new.approver_role_id
       and (r.org_id is null or r.org_id = new.org_id) and r.deleted_at is null) then
    perform private.refuse('form_approver_role', 'The approver role is not available in this org.');
  end if;
  if tg_op = 'UPDATE' and old.template_state <> 'Draft' and (new.fields <> old.fields or new.record_kind <> old.record_kind
     or new.record_subtype is distinct from old.record_subtype or new.requires_signature <> old.requires_signature
     or new.requires_location <> old.requires_location or new.pass_score is distinct from old.pass_score
     or new.approver_role_id is distinct from old.approver_role_id) then
    perform private.refuse('form_template_published', 'A published form keeps its fields and rules; create a new form instead.');
  end if;
  if tg_op = 'UPDATE' and new.current_version <> old.current_version and not private.in_trusted_operation('publish_form_template') then
    perform private.refuse('form_template_version', 'Versions are numbered by publishing.');
  end if;
  return new;
end;
$$;
comment on function private.guard_form_template() is 'Form templates: valid fields and approver role, rules fixed once published, versions numbered only by publishing.';
revoke all on function private.guard_form_template() from public, anon, authenticated;
create trigger t42_guard_form_template before insert or update on app.form_templates
  for each row execute function private.guard_form_template();

create table app.form_template_versions (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  form_template_id uuid not null references app.form_templates (id),
  version integer not null,
  fields jsonb not null,
  requires_signature boolean not null,
  requires_location boolean not null,
  pass_score numeric,
  constraint form_template_versions_version check (version >= 1)
);
create unique index form_template_versions_key on app.form_template_versions (form_template_id, version);
call private.install_domain_table('app.form_template_versions', 'app.form_templates', 'form_template_id', '{}', true);
call private.describe('app.form_template_versions', 'Append-only snapshots of a form template at each publish; submissions answer one version.', array[
  'form_template_id', 'Template.',
  'version', 'Version number, from 1.',
  'fields', 'Field definitions as published.',
  'requires_signature', 'Whether this version needs a signature.',
  'requires_location', 'Whether this version needs a GPS stamp.',
  'pass_score', 'Passing score of this version.'
]);
call private.install_policies('app.form_template_versions', $$form_template_id in (select private.readable_form_template_ids())$$);

create table app.form_submissions (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  form_template_id uuid not null references app.form_templates (id),
  form_template_version_id uuid not null references app.form_template_versions (id),
  project_id uuid references app.projects (id),
  record_id uuid references app.records (id),
  submitted_by_membership_id uuid not null references app.memberships (id),
  answers jsonb not null,
  score numeric,
  max_score numeric,
  passed boolean,
  latitude numeric,
  longitude numeric,
  accuracy_m numeric,
  signer_name text,
  signature_path text,
  signed_at timestamptz,
  submission_state app.form_submission_state not null default 'Submitted',
  decided_by_membership_id uuid references app.memberships (id),
  decision_note text,
  constraint form_submissions_answers check (jsonb_typeof(answers) = 'object'),
  constraint form_submissions_location check ((latitude is null) = (longitude is null)
    and (latitude is null or (latitude between -90 and 90 and longitude between -180 and 180))
    and (accuracy_m is null or accuracy_m >= 0)),
  constraint form_submissions_signature check ((signed_at is null) = (signer_name is null) and (signed_at is null) = (signature_path is null)),
  constraint form_submissions_signer_length check (signer_name is null or char_length(btrim(signer_name)) between 1 and 200),
  constraint form_submissions_signature_path check (signature_path is null or (char_length(signature_path) <= 500 and signature_path ~ '^[a-z0-9][a-z0-9/_.-]*$')),
  constraint form_submissions_note_length check (decision_note is null or char_length(btrim(decision_note)) between 1 and 1000)
);
create index form_submissions_version_idx on app.form_submissions (form_template_version_id);
create index form_submissions_project_idx on app.form_submissions (project_id);
create index form_submissions_record_idx on app.form_submissions (record_id);
create index form_submissions_submitter_idx on app.form_submissions (submitted_by_membership_id);
create index form_submissions_decider_idx on app.form_submissions (decided_by_membership_id);
call private.install_domain_table('app.form_submissions', 'app.form_templates', 'form_template_id',
  array['app.form_template_versions', 'form_template_version_id', 'app.projects', 'project_id', 'app.records', 'record_id',
        'app.memberships', 'submitted_by_membership_id', 'app.memberships', 'decided_by_membership_id']);
create index form_submissions_template_idx on app.form_submissions (form_template_id, created_at);
call private.describe('app.form_submissions', 'A submitted form: its answers against one template version, score, GPS stamp, signature and approval. Written only through app.submit_form; a project submission links to the record it became.', array[
  'form_template_id', 'Form answered.',
  'form_template_version_id', 'Version of the form answered.',
  'project_id', 'Project the submission belongs to, when any.',
  'record_id', 'Record the project submission became.',
  'submitted_by_membership_id', 'Member who submitted.',
  'answers', 'Answers keyed by field key.',
  'score', 'Points earned, when the form scores answers.',
  'max_score', 'Points available on the fields shown.',
  'passed', 'Whether the score met the passing score; NULL when the form has none.',
  'latitude', 'GPS latitude at submission.',
  'longitude', 'GPS longitude at submission.',
  'accuracy_m', 'GPS accuracy in metres.',
  'signer_name', 'Name of the person who signed.',
  'signature_path', 'Storage path of the signature image in the field-media bucket.',
  'signed_at', 'When it was signed.',
  'submission_state', 'Submitted, Approved, Rejected or Recorded.',
  'decided_by_membership_id', 'Approver who decided.',
  'decision_note', 'Approver''s note.'
]);

create or replace function private.can_read_form_submission(p_org_id uuid, p_template_id uuid, p_submitter uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_submitter in (select private.my_membership_ids())
    or private.has_capability(p_org_id, 'knowledge.sop.publish')
    or exists (select 1 from app.form_templates t join app.membership_roles mr on mr.role_id = t.approver_role_id
               where t.id = p_template_id and mr.deleted_at is null and mr.membership_id in (select private.my_membership_ids()));
$$;
comment on function private.can_read_form_submission(uuid, uuid, uuid) is 'Whether the signed-in person reads a form submission: its submitter, a holder of the form''s approver role, or knowledge.sop.publish.';
revoke all on function private.can_read_form_submission(uuid, uuid, uuid) from public, anon;
grant execute on function private.can_read_form_submission(uuid, uuid, uuid) to authenticated, service_role;

call private.install_policies('app.form_submissions',
  $$private.can_read_form_submission(org_id, form_template_id, submitted_by_membership_id)$$);

create or replace function private.readable_form_submission_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select s.id from app.form_submissions s
  where s.deleted_at is null and s.org_id in (select private.my_org_ids())
    and private.can_read_form_submission(s.org_id, s.form_template_id, s.submitted_by_membership_id);
$$;
comment on function private.readable_form_submission_ids() is 'Form submissions the signed-in person reads.';
revoke all on function private.readable_form_submission_ids() from public, anon;
grant execute on function private.readable_form_submission_ids() to authenticated, service_role;

call private.install_lifecycle('app.form_submissions', 'form_submission_id', 'submission_state', 'form_submission', 'Submitted',
  $$form_submission_id in (select private.readable_form_submission_ids())$$);

-- The initial state is Submitted, or Recorded for a form with no approver: the lifecycle guard allows
-- the initial state only, so Recorded submissions are inserted as Submitted and their state is set by the
-- trusted submit operation right after.
create or replace function private.guard_form_submission()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' and not private.in_trusted_operation('submit_form') then
    perform private.refuse('form_submission_rpc', 'Forms are submitted through app.submit_form.');
  end if;
  if tg_op = 'UPDATE' and (new.answers <> old.answers or new.form_template_version_id <> old.form_template_version_id
     or new.submitted_by_membership_id <> old.submitted_by_membership_id or new.score is distinct from old.score
     or new.signed_at is distinct from old.signed_at or new.latitude is distinct from old.latitude
     or new.project_id is distinct from old.project_id
     or (old.record_id is not null and new.record_id is distinct from old.record_id)) then
    perform private.refuse('form_submission_fixed', 'A submission keeps its answers, score, signature and GPS stamp.');
  end if;
  return new;
end;
$$;
comment on function private.guard_form_submission() is 'Form submissions are created only by app.submit_form and keep their answers, score, signature, GPS stamp and project.';
revoke all on function private.guard_form_submission() from public, anon, authenticated;
create trigger t42_guard_form_submission before insert or update on app.form_submissions
  for each row execute function private.guard_form_submission();

-- Template RPCs ----------------------------------------------------------------------------------------------------------

create or replace function app.publish_form_template(p_template_id uuid, p_reason text default 'Published.')
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_template app.form_templates;
  v_version integer;
begin
  perform private.require_person();
  select * into v_template from app.form_templates t where t.id = p_template_id and t.deleted_at is null;
  if v_template.id is null or v_template.id not in (select private.readable_form_template_ids()) then
    raise exception using errcode = '42501', message = 'the form does not exist or is not visible';
  end if;
  if not private.has_capability(v_template.org_id, 'knowledge.sop.publish') then
    perform private.refuse('form_publish_authority', 'Publishing a form needs knowledge.sop.publish.');
  end if;
  perform private.transition_lifecycle('form_template', 'app.form_templates', 'template_state', 'app.form_template_state_transitions',
    'form_template_id', p_template_id, 'Draft', 'Published', p_reason);
  v_version := v_template.current_version + 1;
  insert into app.form_template_versions (form_template_id, version, fields, requires_signature, requires_location, pass_score)
  values (p_template_id, v_version, v_template.fields, v_template.requires_signature, v_template.requires_location, v_template.pass_score);
  perform private.begin_trusted_operation('publish_form_template');
  update app.form_templates set current_version = v_version where id = p_template_id;
  perform private.end_trusted_operation('publish_form_template');
  perform private.emit_event(v_template.org_id, 'form_template.published', 'form_templates', p_template_id, null,
    jsonb_build_object('version', v_version, 'record_kind', v_template.record_kind, 'record_subtype', v_template.record_subtype));
  return v_version;
end;
$$;
comment on function app.publish_form_template(uuid, text) is 'Publishes a draft form (knowledge.sop.publish), snapshotting its fields as the next version. Returns the version number.';
revoke all on function app.publish_form_template(uuid, text) from public, anon;
grant execute on function app.publish_form_template(uuid, text) to authenticated, service_role;

create or replace function app.retire_form_template(p_template_id uuid, p_reason text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_template app.form_templates;
begin
  perform private.require_person();
  select * into v_template from app.form_templates t where t.id = p_template_id and t.deleted_at is null;
  if v_template.id is null or v_template.id not in (select private.readable_form_template_ids()) then
    raise exception using errcode = '42501', message = 'the form does not exist or is not visible';
  end if;
  if not private.has_capability(v_template.org_id, 'knowledge.sop.publish') then
    perform private.refuse('form_publish_authority', 'Retiring a form needs knowledge.sop.publish.');
  end if;
  return private.transition_lifecycle('form_template', 'app.form_templates', 'template_state', 'app.form_template_state_transitions',
    'form_template_id', p_template_id, 'Published', 'Retired', p_reason);
end;
$$;
comment on function app.retire_form_template(uuid, text) is 'Retires a published form (knowledge.sop.publish); it keeps its submissions and takes no new ones. Returns the ledger entry id.';
revoke all on function app.retire_form_template(uuid, text) from public, anon;
grant execute on function app.retire_form_template(uuid, text) to authenticated, service_role;

-- Submission ---------------------------------------------------------------------------------------------------------------

-- Whether a field shows, given the answers so far.
create or replace function private.form_field_shown(p_field jsonb, p_answers jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select not (p_field ? 'show_if')
    or (p_answers -> (p_field #>> '{show_if,key}')) = (p_field #> '{show_if,equals}')
    or (jsonb_typeof(p_answers -> (p_field #>> '{show_if,key}')) = 'array'
        and (p_answers -> (p_field #>> '{show_if,key}')) @> jsonb_build_array(p_field #> '{show_if,equals}'));
$$;
comment on function private.form_field_shown(jsonb, jsonb) is 'Whether a form field shows: it has no show_if rule, or the field it depends on was answered with the value the rule names.';
revoke all on function private.form_field_shown(jsonb, jsonb) from public, anon, authenticated;

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
  v_field jsonb;
  v_answer jsonb;
  v_kind text;
  v_score numeric := 0;
  v_max numeric := 0;
  v_points jsonb;
  v_record uuid;
  v_id uuid;
  v_choice text;
  v_scored boolean := false;
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

  for v_field in select jsonb_array_elements(v_version.fields) loop
    v_kind := v_field ->> 'kind';
    v_answer := p_answers -> (v_field ->> 'key');
    if not private.form_field_shown(v_field, p_answers) then
      if v_answer is not null and v_answer <> 'null'::jsonb then
        perform private.refuse('form_answer_hidden', format('%s is hidden by its condition; leave it empty.', v_field ->> 'label'));
      end if;
      continue;
    end if;
    if v_field ? 'points' then
      v_scored := true;
      v_max := v_max + coalesce((select max(value::numeric) from jsonb_each_text(v_field -> 'points')), 0);
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
          v_score := v_score + coalesce((v_points ->> v_choice)::numeric, 0);
        end loop;
      else
        v_score := v_score + coalesce((v_points ->> (v_answer #>> '{}'))::numeric, 0);
      end if;
    end if;
  end loop;

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
    case when v_scored then v_score end, case when v_scored then v_max end,
    case when v_version.pass_score is not null and v_scored then v_score >= v_version.pass_score end,
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
      'score', case when v_scored then v_score end));
  return v_id;
end;
$$;
comment on function app.submit_form(uuid, jsonb, uuid, jsonb, jsonb) is 'Submits a published form as the signed-in member. Answers are keyed by field key; hidden fields must stay empty, required shown fields must be answered, choices must be listed and photos are uploaded field-media paths. p_location {latitude, longitude, accuracy_m} and p_signature {signer_name, signature_path} are required when the form says so. Scores the answers, makes a record of the form''s kind and subtype when a project is given, and files it as Submitted (with an approver role) or Recorded. Returns the submission id.';
revoke all on function app.submit_form(uuid, jsonb, uuid, jsonb, jsonb) from public, anon;
grant execute on function app.submit_form(uuid, jsonb, uuid, jsonb, jsonb) to authenticated, service_role;

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
  update app.form_submissions set decided_by_membership_id = v_mine, decision_note = nullif(btrim(p_note), '') where id = p_submission_id;
  perform private.emit_event(v_submission.org_id, 'form_submission.decided', 'form_submissions', p_submission_id, v_submission.project_id,
    jsonb_build_object('approved', p_approve));
  return v_ledger;
end;
$$;
comment on function app.decide_form_submission(uuid, boolean, text) is 'Approves or rejects a submitted form as a holder of its approver role or knowledge.sop.publish, never the submitter. A rejection needs a note. Returns the ledger entry id.';
revoke all on function app.decide_form_submission(uuid, boolean, text) from public, anon;
grant execute on function app.decide_form_submission(uuid, boolean, text) to authenticated, service_role;

call private.install_default_retention('app.form_templates');
call private.install_default_retention('app.form_template_state_transitions');
call private.install_default_retention('app.form_template_versions');
call private.install_default_retention('app.form_submissions');
call private.install_default_retention('app.form_submission_state_transitions');

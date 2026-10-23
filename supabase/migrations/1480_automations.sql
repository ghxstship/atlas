-- 1480_automations.sql
-- A91 (RRR-136), finding A65-010, Section 7.3 (workflow engine: automations), Section 4.5.6 item 20 (Settings,
-- Automations) and Section 16 (automations on Pro and above). ADR 0047.
--
-- An automation is a trigger, conditions and actions:
--   * the trigger is one domain event type from private.domain_event_types, the catalog webhooks already use
--     (app.domain_event_catalog, GET /webhook-events), so there is one list of events, not two
--   * conditions compare paths of the event (the same body a webhook receives: id, type, occurred_at,
--     project_id, subject.table, subject.id and data.*) with the API filter operators (app.filter_operator,
--     ADR 0003), combined with all or any and one level of nested groups. They are rows, not a JSON column
--     (ADR 0002); the JSON document form is what the API, Atlas and packages/schemas exchange
--   * actions are rows of typed columns, each run later as the automation's owner through a public API
--     operation (1481), so row level security and capabilities decide every write
--
-- This migration holds the definitions:
--   * app.automation_match, app.automation_action_type
--   * app.automations, app.automation_conditions, app.automation_actions
--   * the evaluator: private.automation_value_at, private.automation_compare, private.automation_items_match and
--     private.automation_conditions_match, the SQL twin of packages/schemas/src/automations/evaluate.ts. Both run
--     the shared vectors in packages/schemas/src/automations/vectors.json (pgTAP 1480 and the schemas tests)
--   * the validators: private.automation_conditions_refusal and private.automation_actions_refusal, the SQL twins
--     of the JSON schema in packages/schemas (automation.schema.json)
--   * app.save_automation, app.set_automation_enabled, app.delete_automation, app.automation_definition,
--     app.test_automation and app.sample_automation_event: what Atlas and the API call
-- Writing an automation needs org.automations.write (0203) and the automations plan feature (plans.yaml: Pro,
-- Team and Enterprise; ADR 0020, unchanged by ADR 0035). Without the feature an org keeps its automations,
-- read-only: they can be turned off and deleted, not changed or turned on (Section 16: downgrades never delete).
-- An automation runs as its owner: whoever last changed what it does or turned it on (ADR 0047).

-- Enums ---------------------------------------------------------------------------------------------------------------

create type app.automation_match as enum ('all', 'any');
comment on type app.automation_match is 'How an automation''s conditions combine: all must hold, or any one.';

create type app.automation_action_type as enum ('create_task', 'update_status', 'assign', 'add_comment', 'notify', 'call_webhook');
comment on type app.automation_action_type is 'What an automation action does, each through a public API operation run as the owner (ADR 0047): create a Task record, move the subject record to a state, assign the subject record, comment on the subject, notify a member, or send the event to a webhook endpoint.';

-- Automations ---------------------------------------------------------------------------------------------------------

create table app.automations (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  name text not null,
  description text,
  trigger_event_type text not null references private.domain_event_types (code),
  condition_match app.automation_match not null default 'all',
  owner_person_id uuid not null references app.people (id),
  enabled boolean not null default false,
  paused_at timestamptz,
  pause_reason text,
  failure_notified_at timestamptz,
  constraint automations_name_length check (char_length(btrim(name)) between 1 and 120 and name = btrim(name)),
  constraint automations_description_length check (description is null or char_length(description) between 1 and 500),
  constraint automations_pause_pair check ((paused_at is null) = (pause_reason is null)),
  constraint automations_paused_off check (paused_at is null or not enabled),
  constraint automations_pause_reason_format check (pause_reason is null or pause_reason ~ '^[a-z][a-z_]*$')
);

call private.install_domain_table('app.automations');
create index automations_trigger_idx on app.automations (org_id, trigger_event_type) where enabled and deleted_at is null;
create index automations_trigger_event_type_idx on app.automations (trigger_event_type);
create index automations_owner_person_id_idx on app.automations (owner_person_id);
call private.describe('app.automations', 'Automations (Section 7.3, Section 4.5.6 item 20, ADR 0047): when a domain event of the trigger type happens in the org and the conditions hold, the actions run as the owner through the public API. Written only through app.save_automation and its sibling RPCs; readable by holders of org.automations.write.', array[
  'name', 'Name shown in Settings, Automations.',
  'description', 'What the automation is for.',
  'trigger_event_type', 'Domain event type that starts a run, from the event catalog webhooks use (private.domain_event_types).',
  'condition_match', 'all when every top-level condition must hold, any when one is enough.',
  'owner_person_id', 'Person the actions run as: whoever last changed what the automation does or turned it on.',
  'enabled', 'True while new events start runs.',
  'paused_at', 'When the engine turned the automation off because a run could not act as the owner (fail closed); null otherwise.',
  'pause_reason', 'Why the engine paused it, a rule code such as owner_left_org, owner_lost_capability or owner_access_refused.',
  'failure_notified_at', 'When the owner was last told a run failed, so failures notify at most once an hour.'
]);

call private.install_policies('app.automations',
  $$org_id in (select private.orgs_with_capability('org.automations.write'))$$);
call private.install_audit_trail('app.automations');

-- Conditions ----------------------------------------------------------------------------------------------------------

create table app.automation_conditions (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  automation_id uuid not null references app.automations (id),
  parent_condition_id uuid references app.automation_conditions (id),
  position smallint not null,
  group_match app.automation_match,
  field text,
  operator app.filter_operator,
  value_text text,
  constraint automation_conditions_position check (position between 1 and 20),
  constraint automation_conditions_kind check (
    (group_match is not null and field is null and operator is null and value_text is null)
    or (group_match is null and field is not null and operator is not null)),
  constraint automation_conditions_field_format check (field is null or field ~ '^[a-z][a-z0-9_]*(\.[a-z0-9_]+){0,7}$'),
  constraint automation_conditions_value check (operator is null or operator = 'is_null' or value_text is not null),
  constraint automation_conditions_value_length check (value_text is null or char_length(value_text) <= 1000),
  constraint automation_conditions_not_own_parent check (parent_condition_id <> id)
);

call private.install_domain_table('app.automation_conditions', 'app.automations', 'automation_id',
  array['app.automation_conditions', 'parent_condition_id']);
create index automation_conditions_automation_idx on app.automation_conditions (automation_id, position);
create index automation_conditions_parent_idx on app.automation_conditions (parent_condition_id);
create unique index automation_conditions_position_key on app.automation_conditions
  (automation_id, coalesce(parent_condition_id, '00000000-0000-0000-0000-000000000000'::uuid), position) where deleted_at is null;
call private.describe('app.automation_conditions', 'One condition of an automation, or a group of conditions (ADR 0047). A condition compares a path of the event with a value using an API filter operator (ADR 0003); a group combines the conditions under it with all or any. Groups nest one level.', array[
  'automation_id', 'Automation the condition belongs to.',
  'parent_condition_id', 'Group the condition sits in; null for a top-level condition or group.',
  'position', 'Order within its parent, 1 first.',
  'group_match', 'For a group: all or any of the conditions under it. Null for a condition.',
  'field', 'Path into the event, such as data.record_kind or subject.table. Null for a group.',
  'operator', 'eq, ne, lt, lte, gt, gte, in (comma-separated values), is_null (true or false) or contains. Null for a group.',
  'value_text', 'Value compared, as text; null for is_null meaning true, and for a group.'
]);

call private.install_policies('app.automation_conditions',
  $$org_id in (select private.orgs_with_capability('org.automations.write'))$$);
call private.install_audit_trail('app.automation_conditions');

create or replace function private.guard_automation_condition()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_parent app.automation_conditions;
begin
  if new.parent_condition_id is not null then
    select * into v_parent from app.automation_conditions c where c.id = new.parent_condition_id;
    if v_parent.id is null or v_parent.automation_id <> new.automation_id or v_parent.group_match is null
       or v_parent.parent_condition_id is not null then
      perform private.refuse('automation_condition_nesting',
        'A condition sits at the top level or in a top-level group of the same automation; groups nest one level.');
    end if;
    if new.group_match is not null then
      perform private.refuse('automation_condition_nesting', 'Groups nest one level.');
    end if;
  end if;
  return new;
end;
$$;

comment on function private.guard_automation_condition() is 'Automation conditions: a nested condition sits in a top-level group of the same automation, and groups nest one level.';

create trigger t40_guard_automation_condition before insert or update on app.automation_conditions
  for each row execute function private.guard_automation_condition();

-- Actions -------------------------------------------------------------------------------------------------------------

create table app.automation_actions (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  automation_id uuid not null references app.automations (id),
  position smallint not null,
  action_type app.automation_action_type not null,
  title_template text,
  body_template text,
  project_id uuid references app.projects (id),
  phase_code text references xpms.dim_phase (phase_code),
  xyz xpms.xyz_tag,
  due_in_days smallint,
  to_state text references xpms.dim_record_state (record_state),
  assignee_person_id uuid references app.people (id),
  recipient_person_id uuid references app.people (id),
  webhook_endpoint_id uuid references app.webhook_endpoints (id),
  constraint automation_actions_position check (position between 1 and 10),
  constraint automation_actions_title_length check (title_template is null or char_length(btrim(title_template)) between 1 and 200),
  constraint automation_actions_body_length check (body_template is null or char_length(btrim(body_template)) between 1 and 2000),
  constraint automation_actions_due_range check (due_in_days is null or due_in_days between 0 and 365),
  constraint automation_actions_create_task check (action_type <> 'create_task'
    or (title_template is not null and phase_code is not null and xyz is not null)),
  constraint automation_actions_update_status check (action_type <> 'update_status'
    or (to_state is not null and (to_state not in ('Blocked', 'Deferred') or body_template is not null))),
  constraint automation_actions_assign check (action_type <> 'assign' or assignee_person_id is not null),
  constraint automation_actions_add_comment check (action_type <> 'add_comment' or body_template is not null),
  constraint automation_actions_notify check (action_type <> 'notify' or (recipient_person_id is not null and title_template is not null)),
  constraint automation_actions_call_webhook check (action_type <> 'call_webhook' or webhook_endpoint_id is not null),
  constraint automation_actions_columns check (
    (project_id is null and phase_code is null and xyz is null and due_in_days is null or action_type = 'create_task')
    and (to_state is null or action_type = 'update_status')
    and (assignee_person_id is null or action_type = 'assign')
    and (recipient_person_id is null or action_type = 'notify')
    and (webhook_endpoint_id is null or action_type = 'call_webhook')
    and (title_template is null or action_type in ('create_task', 'notify'))
    and (body_template is null or action_type in ('update_status', 'add_comment', 'notify')))
);

create index automation_actions_automation_idx on app.automation_actions (automation_id, position);
create index automation_actions_project_id_idx on app.automation_actions (project_id);
create index automation_actions_phase_code_idx on app.automation_actions (phase_code);
create index automation_actions_to_state_idx on app.automation_actions (to_state);
create index automation_actions_assignee_person_id_idx on app.automation_actions (assignee_person_id);
create index automation_actions_recipient_person_id_idx on app.automation_actions (recipient_person_id);
create index automation_actions_webhook_endpoint_id_idx on app.automation_actions (webhook_endpoint_id);

call private.install_domain_table('app.automation_actions', 'app.automations', 'automation_id',
  array['app.projects', 'project_id', 'app.webhook_endpoints', 'webhook_endpoint_id']);
create unique index automation_actions_position_key on app.automation_actions (automation_id, position) where deleted_at is null;
call private.describe('app.automation_actions', 'One action of an automation, run in position order as the owner through a public API operation (ADR 0047): create_task (records.create), update_status (records.transition), assign (records.update), add_comment (comments.postOnSubject), notify (automationRuns.notify) or call_webhook (automationRuns.deliverWebhook). Templates may name event paths in double braces, such as {{data.title}}.', array[
  'automation_id', 'Automation the action belongs to.',
  'position', 'Order the actions run in, 1 first.',
  'action_type', 'What the action does.',
  'title_template', 'create_task: the Task title (imperative verb first); notify: the notification title.',
  'body_template', 'add_comment: the comment; notify: the message; update_status: the blocker or replan reason Blocked and Deferred need.',
  'project_id', 'create_task: the project the Task goes in, under its engagement root; null means the event''s project.',
  'phase_code', 'create_task: the Task''s gated phase.',
  'xyz', 'create_task: the Task''s declared XYZ tag.',
  'due_in_days', 'create_task: due at 17:00 on the org''s calendar this many days after the run; null for no due date.',
  'to_state', 'update_status: the record state the subject record moves to.',
  'assignee_person_id', 'assign: the member who becomes the subject record''s owner.',
  'recipient_person_id', 'notify: the member who receives the notification.',
  'webhook_endpoint_id', 'call_webhook: the org''s webhook endpoint the event is delivered to, signed as every webhook is.'
]);

call private.install_policies('app.automation_actions',
  $$org_id in (select private.orgs_with_capability('org.automations.write'))$$);
call private.install_audit_trail('app.automation_actions');

-- Evaluator -----------------------------------------------------------------------------------------------------------
-- The SQL twin of packages/schemas/src/automations/evaluate.ts. Both follow ADR 0047:
--   * a field is a dotted path; each segment reads an object key, or an array index when the segment is digits.
--     A missing path and JSON null are both null
--   * every operator but is_null is false on null
--   * eq and ne: a number compares numerically with a numeric value (-?digits with an optional fraction), a
--     boolean with true or false, a string exactly; objects and arrays never equal a value. ne is not eq
--   * lt, lte, gt and gte: numbers numerically, strings by code point (collation C); anything else is false
--   * in: eq against any of the comma-separated values, each trimmed, empty ones skipped
--   * contains: a string contains the value with ASCII letters folded to lower case; an array has an element
--     that eq the value
--   * is_null: value true (or none) holds for null, false for anything else
--   * a group holds when all (or any) of its items hold; an empty group holds

create or replace function private.automation_value_at(p_event jsonb, p_field text)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select case when v is null or jsonb_typeof(v) = 'null' then null else v end
  from (select p_event #> string_to_array(p_field, '.') as v) s;
$$;

comment on function private.automation_value_at(jsonb, text) is 'The value at a dotted path of an automation event (object keys, digit segments index arrays); null for a missing path or JSON null.';

create or replace function private.automation_fold(p_text text)
returns text
language sql
immutable
set search_path = ''
as $$
  select translate(p_text, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz');
$$;

comment on function private.automation_fold(text) is 'Folds ASCII letters to lower case, as the TypeScript evaluator does, so contains behaves the same in both whatever the database locale.';

create or replace function private.automation_equals(p_actual jsonb, p_value text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select case jsonb_typeof(p_actual)
    when 'string' then (p_actual #>> '{}') = p_value
    when 'boolean' then (p_value = 'true' and (p_actual #>> '{}')::boolean) or (p_value = 'false' and not (p_actual #>> '{}')::boolean)
    when 'number' then p_value ~ '^-?[0-9]+(\.[0-9]+)?$' and (p_actual #>> '{}')::numeric = p_value::numeric
    else false
  end;
$$;

comment on function private.automation_equals(jsonb, text) is 'eq of the automation evaluator: numbers numerically, booleans against true or false, strings exactly; null, objects and arrays are never equal.';

create or replace function private.automation_compare(p_actual jsonb, p_operator app.filter_operator, p_value text)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_kind text := jsonb_typeof(p_actual);
  v_text text;
begin
  if p_operator = 'is_null' then
    return case when p_value is null or p_value = 'true' then p_actual is null else p_actual is not null end;
  end if;
  if p_actual is null then
    return false;
  end if;
  case p_operator
    when 'eq' then
      return private.automation_equals(p_actual, p_value);
    when 'ne' then
      return not private.automation_equals(p_actual, p_value);
    when 'in' then
      return exists (select 1 from unnest(string_to_array(p_value, ',')) s
                     where btrim(s) <> '' and private.automation_equals(p_actual, btrim(s)));
    when 'contains' then
      if v_kind = 'string' then
        return strpos(private.automation_fold(p_actual #>> '{}'), private.automation_fold(p_value)) > 0;
      elsif v_kind = 'array' then
        return exists (select 1 from jsonb_array_elements(p_actual) e where private.automation_equals(e, p_value));
      end if;
      return false;
    else
      if v_kind = 'number' and p_value ~ '^-?[0-9]+(\.[0-9]+)?$' then
        return case p_operator
          when 'lt' then (p_actual #>> '{}')::numeric < p_value::numeric
          when 'lte' then (p_actual #>> '{}')::numeric <= p_value::numeric
          when 'gt' then (p_actual #>> '{}')::numeric > p_value::numeric
          else (p_actual #>> '{}')::numeric >= p_value::numeric end;
      elsif v_kind = 'string' then
        v_text := p_actual #>> '{}';
        return case p_operator
          when 'lt' then v_text collate "C" < p_value collate "C"
          when 'lte' then v_text collate "C" <= p_value collate "C"
          when 'gt' then v_text collate "C" > p_value collate "C"
          else v_text collate "C" >= p_value collate "C" end;
      end if;
      return false;
  end case;
end;
$$;

comment on function private.automation_compare(jsonb, app.filter_operator, text) is 'One automation condition against the value found in the event (ADR 0047), the SQL twin of evaluate.ts.';

create or replace function private.automation_items_match(p_match text, p_items jsonb, p_event jsonb)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_item jsonb;
  v_held boolean;
begin
  if p_items is null or jsonb_array_length(p_items) = 0 then
    return true;
  end if;
  for v_item in select e from jsonb_array_elements(p_items) e loop
    if v_item ? 'all' then
      v_held := private.automation_items_match('all', v_item -> 'all', p_event);
    elsif v_item ? 'any' then
      v_held := private.automation_items_match('any', v_item -> 'any', p_event);
    else
      v_held := private.automation_compare(private.automation_value_at(p_event, v_item ->> 'field'),
        (v_item ->> 'operator')::app.filter_operator, v_item ->> 'value');
    end if;
    if p_match = 'all' and not v_held then
      return false;
    elsif p_match = 'any' and v_held then
      return true;
    end if;
  end loop;
  return p_match = 'all';
end;
$$;

comment on function private.automation_items_match(text, jsonb, jsonb) is 'Whether all (or any) of a list of conditions and groups hold for an event; an empty list holds.';

create or replace function private.automation_conditions_match(p_conditions jsonb, p_event jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select case
    when p_conditions ? 'all' then private.automation_items_match('all', p_conditions -> 'all', p_event)
    when p_conditions ? 'any' then private.automation_items_match('any', p_conditions -> 'any', p_event)
    else true end;
$$;

comment on function private.automation_conditions_match(jsonb, jsonb) is 'Whether an automation conditions document ({"all": [...]} or {"any": [...]}) holds for an event body (ADR 0047). Validate the document first with private.automation_conditions_refusal.';

-- Validators ------------------------------------------------------------------------------------------------------------
-- The SQL twins of the JSON schema (packages/schemas/automation.schema.json). Each returns null for a valid document, else
-- the refusal message.

create or replace function private.automation_condition_refusal(p_item jsonb)
returns text
language plpgsql
stable
set search_path = ''
as $$
declare
  v_key text;
  v_operator text;
  v_value jsonb;
begin
  if jsonb_typeof(p_item) is distinct from 'object' then
    return 'Each condition is an object with a field, an operator and a value.';
  end if;
  for v_key in select jsonb_object_keys(p_item) loop
    if v_key not in ('field', 'operator', 'value') then
      return format('A condition has a field, an operator and a value, not "%s".', v_key);
    end if;
  end loop;
  if jsonb_typeof(p_item -> 'field') is distinct from 'string'
     or (p_item ->> 'field') !~ '^[a-z][a-z0-9_]*(\.[a-z0-9_]+){0,7}$' then
    return 'A condition''s field is a path into the event, such as data.record_kind.';
  end if;
  v_operator := p_item ->> 'operator';
  if jsonb_typeof(p_item -> 'operator') is distinct from 'string'
     or not exists (select 1 from unnest(enum_range(null::app.filter_operator)) o where o::text = v_operator) then
    return 'A condition''s operator is eq, ne, lt, lte, gt, gte, in, is_null or contains.';
  end if;
  v_value := p_item -> 'value';
  if v_value is not null and jsonb_typeof(v_value) = 'null' then
    v_value := null;
  end if;
  if v_value is not null and jsonb_typeof(v_value) <> 'string' then
    return 'A condition''s value is text.';
  end if;
  if v_operator = 'is_null' then
    if v_value is not null and (v_value #>> '{}') not in ('true', 'false') then
      return 'An is_null condition takes true or false.';
    end if;
    return null;
  end if;
  if v_value is null then
    return format('A %s condition needs a value.', v_operator);
  end if;
  if char_length(v_value #>> '{}') > 1000 then
    return 'A condition''s value is at most 1,000 characters.';
  end if;
  if v_operator = 'in' and not exists (select 1 from unnest(string_to_array(v_value #>> '{}', ',')) s where btrim(s) <> '') then
    return 'An in condition lists at least one value, separated by commas.';
  end if;
  return null;
end;
$$;

comment on function private.automation_condition_refusal(jsonb) is 'Why one automation condition object is invalid, or null.';

create or replace function private.automation_conditions_refusal(p_conditions jsonb)
returns text
language plpgsql
stable
set search_path = ''
as $$
declare
  v_match text;
  v_items jsonb;
  v_item jsonb;
  v_inner jsonb;
  v_count integer := 0;
  v_refusal text;
begin
  if jsonb_typeof(p_conditions) is distinct from 'object' or (select count(*) from jsonb_object_keys(p_conditions)) <> 1
     or not (p_conditions ? 'all' or p_conditions ? 'any') then
    return 'Conditions are {"all": [...]} or {"any": [...]}.';
  end if;
  v_match := case when p_conditions ? 'all' then 'all' else 'any' end;
  v_items := p_conditions -> v_match;
  if jsonb_typeof(v_items) is distinct from 'array' then
    return 'Conditions are {"all": [...]} or {"any": [...]}.';
  end if;
  for v_item in select e from jsonb_array_elements(v_items) e loop
    v_count := v_count + 1;
    if jsonb_typeof(v_item) = 'object' and (v_item ? 'all' or v_item ? 'any') then
      if (select count(*) from jsonb_object_keys(v_item)) <> 1 then
        return 'A group is {"all": [...]} or {"any": [...]} and nothing else.';
      end if;
      v_inner := coalesce(v_item -> 'all', v_item -> 'any');
      if jsonb_typeof(v_inner) is distinct from 'array' or jsonb_array_length(v_inner) = 0 then
        return 'A group lists at least one condition.';
      end if;
      for v_item in select e from jsonb_array_elements(v_inner) e loop
        v_count := v_count + 1;
        if jsonb_typeof(v_item) = 'object' and (v_item ? 'all' or v_item ? 'any') then
          return 'Groups nest one level.';
        end if;
        v_refusal := private.automation_condition_refusal(v_item);
        if v_refusal is not null then
          return v_refusal;
        end if;
      end loop;
    else
      v_refusal := private.automation_condition_refusal(v_item);
      if v_refusal is not null then
        return v_refusal;
      end if;
    end if;
  end loop;
  if v_count > 20 then
    return 'An automation has at most 20 conditions and groups.';
  end if;
  return null;
end;
$$;

comment on function private.automation_conditions_refusal(jsonb) is 'Why an automation conditions document is invalid, or null: {"all"|"any": [...]} of at most 20 conditions and groups, groups one level deep and never empty, each condition a field path, an API filter operator and a text value (ADR 0047). The SQL twin of the conditions part of packages/schemas/automation.schema.json.';

create or replace function private.automation_action_refusal(p_action jsonb)
returns text
language plpgsql
stable
set search_path = ''
as $$
declare
  v_type text := p_action ->> 'type';
  v_allowed text[];
  v_key text;
  v_uuid constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
begin
  if jsonb_typeof(p_action) is distinct from 'object' or jsonb_typeof(p_action -> 'type') is distinct from 'string'
     or not exists (select 1 from unnest(enum_range(null::app.automation_action_type)) t where t::text = v_type) then
    return 'Each action has a type: create_task, update_status, assign, add_comment, notify or call_webhook.';
  end if;
  v_allowed := case v_type
    when 'create_task' then array['type', 'title', 'project_id', 'phase_code', 'xyz', 'due_in_days']
    when 'update_status' then array['type', 'to_state', 'note']
    when 'assign' then array['type', 'assignee_person_id']
    when 'add_comment' then array['type', 'body']
    when 'notify' then array['type', 'recipient_person_id', 'title', 'body']
    else array['type', 'webhook_endpoint_id'] end;
  for v_key in select jsonb_object_keys(p_action) loop
    if not v_key = any (v_allowed) then
      return format('A %s action has no "%s".', v_type, v_key);
    end if;
  end loop;
  -- Text fields: present ones are strings of the right length.
  if p_action ? 'title' and (jsonb_typeof(p_action -> 'title') is distinct from 'string'
     or char_length(btrim(p_action ->> 'title')) not between 1 and 200) then
    return 'A title is 1 to 200 characters.';
  end if;
  foreach v_key in array array['body', 'note'] loop
    if p_action ? v_key and jsonb_typeof(p_action -> v_key) <> 'null' and (jsonb_typeof(p_action -> v_key) <> 'string'
       or char_length(btrim(p_action ->> v_key)) not between 1 and 2000) then
      return format('A %s is 1 to 2,000 characters.', v_key);
    end if;
  end loop;
  foreach v_key in array array['project_id', 'assignee_person_id', 'recipient_person_id', 'webhook_endpoint_id'] loop
    if p_action ? v_key and jsonb_typeof(p_action -> v_key) <> 'null'
       and (jsonb_typeof(p_action -> v_key) <> 'string' or (p_action ->> v_key) !~ v_uuid) then
      return format('%s is an id.', v_key);
    end if;
  end loop;
  case v_type
    when 'create_task' then
      if not p_action ? 'title' then
        return 'A create_task action needs a title.';
      end if;
      if jsonb_typeof(p_action -> 'phase_code') is distinct from 'string' or (p_action ->> 'phase_code') !~ '^[A-Z]{3}$' then
        return 'A create_task action needs a phase code, such as SCP.';
      end if;
      if jsonb_typeof(p_action -> 'xyz') is distinct from 'string' or (p_action ->> 'xyz') not in ('X', 'Y', 'Z') then
        return 'A create_task action needs an XYZ tag: X, Y or Z.';
      end if;
      if p_action ? 'due_in_days' and jsonb_typeof(p_action -> 'due_in_days') <> 'null'
         and (jsonb_typeof(p_action -> 'due_in_days') <> 'number' or (p_action ->> 'due_in_days') !~ '^[0-9]+$'
              or (p_action ->> 'due_in_days')::integer > 365) then
        return 'due_in_days is a whole number from 0 to 365.';
      end if;
    when 'update_status' then
      if jsonb_typeof(p_action -> 'to_state') is distinct from 'string'
         or not exists (select 1 from xpms.dim_record_state s where s.record_state = p_action ->> 'to_state') then
        return 'An update_status action needs a record state, such as Complete.';
      end if;
      if (p_action ->> 'to_state') in ('Blocked', 'Deferred') and coalesce(btrim(p_action ->> 'note'), '') = '' then
        return 'Moving a record to Blocked or Deferred needs a note: the blocker or the replan reason.';
      end if;
    when 'assign' then
      if not p_action ? 'assignee_person_id' or jsonb_typeof(p_action -> 'assignee_person_id') = 'null' then
        return 'An assign action needs the member to assign.';
      end if;
    when 'add_comment' then
      if coalesce(jsonb_typeof(p_action -> 'body'), 'null') = 'null' then
        return 'An add_comment action needs the comment.';
      end if;
    when 'notify' then
      if not p_action ? 'recipient_person_id' or jsonb_typeof(p_action -> 'recipient_person_id') = 'null' then
        return 'A notify action needs the member to notify.';
      end if;
      if not p_action ? 'title' then
        return 'A notify action needs a title.';
      end if;
    else
      if not p_action ? 'webhook_endpoint_id' or jsonb_typeof(p_action -> 'webhook_endpoint_id') = 'null' then
        return 'A call_webhook action needs the webhook endpoint.';
      end if;
  end case;
  return null;
end;
$$;

comment on function private.automation_action_refusal(jsonb) is 'Why one automation action object is invalid, or null (the shape only; app.save_automation checks the ids).';

create or replace function private.automation_actions_refusal(p_actions jsonb)
returns text
language plpgsql
stable
set search_path = ''
as $$
declare
  v_action jsonb;
  v_refusal text;
begin
  if jsonb_typeof(p_actions) is distinct from 'array' or jsonb_array_length(p_actions) not between 1 and 10 then
    return 'An automation has 1 to 10 actions.';
  end if;
  for v_action in select e from jsonb_array_elements(p_actions) e loop
    v_refusal := private.automation_action_refusal(v_action);
    if v_refusal is not null then
      return v_refusal;
    end if;
  end loop;
  return null;
end;
$$;

comment on function private.automation_actions_refusal(jsonb) is 'Why an automation actions document is invalid, or null: 1 to 10 typed actions (ADR 0047). The SQL twin of the actions part of packages/schemas/automation.schema.json.';

-- Documents from rows ---------------------------------------------------------------------------------------------------

create or replace function private.automation_condition_json(p_condition app.automation_conditions)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_strip_nulls(jsonb_build_object('field', p_condition.field, 'operator', p_condition.operator::text,
    'value', p_condition.value_text));
$$;

comment on function private.automation_condition_json(app.automation_conditions) is 'One stored condition as its JSON document form.';

create or replace function private.automation_conditions_doc(p_automation_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(a.condition_match::text, coalesce((
    select jsonb_agg(case when c.group_match is null then private.automation_condition_json(c)
      else jsonb_build_object(c.group_match::text, coalesce((
        select jsonb_agg(private.automation_condition_json(k) order by k.position)
        from app.automation_conditions k where k.parent_condition_id = c.id and k.deleted_at is null), '[]'::jsonb)) end
      order by c.position)
    from app.automation_conditions c
    where c.automation_id = a.id and c.parent_condition_id is null and c.deleted_at is null), '[]'::jsonb))
  from app.automations a where a.id = p_automation_id;
$$;

comment on function private.automation_conditions_doc(uuid) is 'An automation''s stored conditions as the JSON document the evaluator, the API and Atlas use.';

create or replace function private.automation_actions_doc(p_automation_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_strip_nulls(case a.action_type
      when 'create_task' then jsonb_build_object('title', a.title_template, 'project_id', a.project_id, 'phase_code', a.phase_code,
        'xyz', a.xyz::text, 'due_in_days', a.due_in_days)
      when 'update_status' then jsonb_build_object('to_state', a.to_state, 'note', a.body_template)
      when 'assign' then jsonb_build_object('assignee_person_id', a.assignee_person_id)
      when 'add_comment' then jsonb_build_object('body', a.body_template)
      when 'notify' then jsonb_build_object('recipient_person_id', a.recipient_person_id, 'title', a.title_template,
        'body', a.body_template)
      else jsonb_build_object('webhook_endpoint_id', a.webhook_endpoint_id) end
      || jsonb_build_object('type', a.action_type::text)) order by a.position), '[]'::jsonb)
  from app.automation_actions a where a.automation_id = p_automation_id and a.deleted_at is null;
$$;

comment on function private.automation_actions_doc(uuid) is 'An automation''s stored actions as the JSON document the API and Atlas use, in run order.';

-- Who manages automations -----------------------------------------------------------------------------------------------

create or replace function private.automation_member_active(p_org_id uuid, p_person_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_person_id is not null and p_org_id in (select private.person_org_ids(p_person_id));
$$;

comment on function private.automation_member_active(uuid, uuid) is 'True when the person holds an active membership in the org: who an automation may assign, notify or run as.';

create or replace function private.automation_trigger_subject(p_event_type text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select t.subject from private.domain_event_types t where t.code = p_event_type;
$$;

comment on function private.automation_trigger_subject(text) is 'The subject table (without schema) of a trigger event type, from the event catalog.';

-- Writing an automation -------------------------------------------------------------------------------------------------

create or replace function private.write_automation_conditions(p_automation_id uuid, p_conditions jsonb)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_item jsonb;
  v_inner jsonb;
  v_position smallint := 0;
  v_inner_position smallint;
  v_group uuid;
  v_match text := case when p_conditions ? 'all' then 'all' else 'any' end;
begin
  update app.automation_conditions set deleted_at = now() where automation_id = p_automation_id and deleted_at is null;
  update app.automations set condition_match = v_match::app.automation_match where id = p_automation_id;
  for v_item in select e from jsonb_array_elements(p_conditions -> v_match) e loop
    v_position := v_position + 1;
    if v_item ? 'all' or v_item ? 'any' then
      insert into app.automation_conditions (automation_id, position, group_match)
      values (p_automation_id, v_position, (case when v_item ? 'all' then 'all' else 'any' end)::app.automation_match)
      returning id into v_group;
      v_inner_position := 0;
      for v_inner in select e from jsonb_array_elements(coalesce(v_item -> 'all', v_item -> 'any')) e loop
        v_inner_position := v_inner_position + 1;
        insert into app.automation_conditions (automation_id, parent_condition_id, position, field, operator, value_text)
        values (p_automation_id, v_group, v_inner_position, v_inner ->> 'field', (v_inner ->> 'operator')::app.filter_operator,
          v_inner ->> 'value');
      end loop;
    else
      insert into app.automation_conditions (automation_id, position, field, operator, value_text)
      values (p_automation_id, v_position, v_item ->> 'field', (v_item ->> 'operator')::app.filter_operator, v_item ->> 'value');
    end if;
  end loop;
end;
$$;

comment on function private.write_automation_conditions(uuid, jsonb) is 'Replaces an automation''s conditions with a validated document: the old rows are soft deleted, the new ones written in order.';

create or replace function private.write_automation_actions(p_automation_id uuid, p_actions jsonb)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_action jsonb;
  v_position smallint := 0;
begin
  update app.automation_actions set deleted_at = now() where automation_id = p_automation_id and deleted_at is null;
  for v_action in select e from jsonb_array_elements(p_actions) e loop
    v_position := v_position + 1;
    insert into app.automation_actions (automation_id, position, action_type, title_template, body_template, project_id,
      phase_code, xyz, due_in_days, to_state, assignee_person_id, recipient_person_id, webhook_endpoint_id)
    values (p_automation_id, v_position, (v_action ->> 'type')::app.automation_action_type,
      nullif(btrim(v_action ->> 'title'), ''),
      nullif(btrim(coalesce(v_action ->> 'body', v_action ->> 'note')), ''),
      (v_action ->> 'project_id')::uuid, v_action ->> 'phase_code', (v_action ->> 'xyz')::xpms.xyz_tag,
      (v_action ->> 'due_in_days')::smallint, v_action ->> 'to_state', (v_action ->> 'assignee_person_id')::uuid,
      (v_action ->> 'recipient_person_id')::uuid, (v_action ->> 'webhook_endpoint_id')::uuid);
  end loop;
end;
$$;

comment on function private.write_automation_actions(uuid, jsonb) is 'Replaces an automation''s actions with a validated document: the old rows are soft deleted, the new ones written in order.';

create or replace function private.check_automation_actions(p_org_id uuid, p_trigger text, p_actions jsonb)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_action jsonb;
  v_subject text := private.automation_trigger_subject(p_trigger);
begin
  for v_action in select e from jsonb_array_elements(p_actions) e loop
    case v_action ->> 'type'
      when 'create_task' then
        if v_action ->> 'project_id' is not null and not exists (
          select 1 from app.projects p where p.id = (v_action ->> 'project_id')::uuid and p.org_id = p_org_id and p.deleted_at is null) then
          perform private.refuse('automation_project_unknown', 'The project of a create_task action is not in this organization.');
        end if;
        if not exists (select 1 from xpms.dim_phase f where f.phase_code = v_action ->> 'phase_code') then
          perform private.refuse('automation_actions_invalid', format('%s is not a phase code.', v_action ->> 'phase_code'));
        end if;
      when 'update_status', 'assign' then
        if v_subject is distinct from 'records' then
          perform private.refuse('automation_action_needs_record',
            'Changing the status or the owner works only on a record: choose a trigger whose subject is a record, such as record.created.');
        end if;
        if v_action ->> 'type' = 'assign' and not private.automation_member_active(p_org_id, (v_action ->> 'assignee_person_id')::uuid) then
          perform private.refuse('automation_person_not_member', 'Assign the record to a member of this organization.');
        end if;
      when 'add_comment' then
        if not exists (select 1 from private.comment_subjects s where s.table_name = 'app.' || v_subject) then
          perform private.refuse('automation_action_needs_commentable_subject',
            'Comments go on the event''s subject, and this trigger''s subject does not take comments.');
        end if;
      when 'notify' then
        if not private.automation_member_active(p_org_id, (v_action ->> 'recipient_person_id')::uuid) then
          perform private.refuse('automation_person_not_member', 'Notify a member of this organization.');
        end if;
      when 'call_webhook' then
        if not exists (select 1 from app.webhook_endpoints w where w.id = (v_action ->> 'webhook_endpoint_id')::uuid
                       and w.org_id = p_org_id and w.deleted_at is null) then
          perform private.refuse('automation_webhook_unknown', 'Choose one of this organization''s webhook endpoints.');
        end if;
      else
        null;
    end case;
  end loop;
end;
$$;

comment on function private.check_automation_actions(uuid, text, jsonb) is 'Checks the ids and the trigger fit of validated automation actions: projects and webhook endpoints of the org, assignees and recipients who are members, and record or commentable subjects for the actions that need them.';

create or replace function app.save_automation(
  p_org_id uuid,
  p_automation_id uuid,
  p_name text,
  p_description text,
  p_trigger_event_type text,
  p_conditions jsonb,
  p_actions jsonb,
  p_enabled boolean,
  p_expected_updated_at timestamptz default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
  v_current app.automations;
  v_id uuid := p_automation_id;
  v_trigger text;
  v_refusal text;
  v_changes_behavior boolean;
  v_enabling boolean;
begin
  if p_org_id is null or not private.has_capability(p_org_id, 'org.automations.write') then
    raise exception using errcode = '42501', message = 'organization not found';
  end if;
  if v_id is not null then
    select * into v_current from app.automations a where a.id = v_id and a.org_id = p_org_id and a.deleted_at is null for update;
    if v_current.id is null then
      raise exception using errcode = '42501', message = 'automation not found';
    end if;
    if p_expected_updated_at is not null and v_current.updated_at <> p_expected_updated_at then
      perform private.refuse('automation_changed', 'Someone changed this automation since you opened it. Reload it and try again.');
    end if;
  elsif p_name is null or p_trigger_event_type is null or p_conditions is null or p_actions is null then
    perform private.refuse('automation_incomplete', 'A new automation needs a name, a trigger, conditions and actions.');
  end if;

  v_trigger := coalesce(p_trigger_event_type, v_current.trigger_event_type);
  v_changes_behavior := v_id is null or p_trigger_event_type is distinct from null and p_trigger_event_type <> v_current.trigger_event_type
    or p_conditions is not null or p_actions is not null;
  v_enabling := coalesce(p_enabled, false) and (v_id is null or not v_current.enabled);
  -- Section 16: without the feature the org's automations are read-only; turning one off and deleting stay open.
  if (v_changes_behavior or v_enabling or p_name is not null or p_description is not null)
     and not private.org_has_feature(p_org_id, 'automations') then
    perform private.refuse('plan_feature_required', 'Automations need the Pro plan or above.');
  end if;
  if not exists (select 1 from private.domain_event_types t where t.code = v_trigger) then
    perform private.refuse('automation_trigger_unknown', format('%s is not an event in the catalog.', v_trigger));
  end if;
  if p_name is not null and char_length(btrim(p_name)) not between 1 and 120 then
    perform private.refuse('automation_name_length', 'An automation name is 1 to 120 characters.');
  end if;
  if p_description is not null and char_length(btrim(p_description)) > 500 then
    perform private.refuse('automation_description_length', 'A description is at most 500 characters.');
  end if;
  if p_conditions is not null then
    v_refusal := private.automation_conditions_refusal(p_conditions);
    if v_refusal is not null then
      perform private.refuse('automation_conditions_invalid', v_refusal);
    end if;
  end if;
  if p_actions is not null then
    v_refusal := private.automation_actions_refusal(p_actions);
    if v_refusal is not null then
      perform private.refuse('automation_actions_invalid', v_refusal);
    end if;
  end if;
  -- The actions must fit the trigger, including the stored actions when only the trigger changes or the automation
  -- is turned on. Turning one off is never refused.
  if p_actions is not null or v_enabling or v_trigger is distinct from v_current.trigger_event_type then
    perform private.check_automation_actions(p_org_id, v_trigger,
      coalesce(p_actions, case when v_id is not null then private.automation_actions_doc(v_id) end, '[]'::jsonb));
  end if;

  if v_id is null then
    insert into app.automations (org_id, name, description, trigger_event_type, owner_person_id, enabled)
    values (p_org_id, btrim(p_name), nullif(btrim(coalesce(p_description, '')), ''), v_trigger, v_person, coalesce(p_enabled, false))
    returning id into v_id;
  else
    update app.automations set
      name = coalesce(btrim(p_name), name),
      description = case when p_description is null then description else nullif(btrim(p_description), '') end,
      trigger_event_type = v_trigger,
      enabled = coalesce(p_enabled, enabled),
      paused_at = case when v_enabling then null else paused_at end,
      pause_reason = case when v_enabling then null else pause_reason end,
      owner_person_id = case when v_changes_behavior or v_enabling then v_person else owner_person_id end
    where id = v_id;
  end if;
  if p_conditions is not null then
    perform private.write_automation_conditions(v_id, p_conditions);
  end if;
  if p_actions is not null then
    perform private.write_automation_actions(v_id, p_actions);
  end if;
  return v_id;
end;
$$;

comment on function app.save_automation(uuid, uuid, text, text, text, jsonb, jsonb, boolean, timestamptz) is 'Creates (null id) or changes an automation with its conditions and actions documents, validated as packages/schemas validates them. On a change, null arguments keep the stored value and p_expected_updated_at, when given, is compared first (automation_changed). Whoever changes the trigger, conditions or actions, or turns it on, becomes the owner it runs as. Needs org.automations.write and, except to turn it off, the automations plan feature.';

create or replace function app.set_automation_enabled(p_automation_id uuid, p_enabled boolean)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_org uuid := (select a.org_id from app.automations a where a.id = p_automation_id and a.deleted_at is null);
begin
  if v_org is null or not private.has_capability(v_org, 'org.automations.write') then
    raise exception using errcode = '42501', message = 'automation not found';
  end if;
  perform app.save_automation(v_org, p_automation_id, null, null, null, null, null, coalesce(p_enabled, false));
end;
$$;

comment on function app.set_automation_enabled(uuid, boolean) is 'Turns an automation on (the caller becomes its owner, and a pause clears) or off. Turning on needs the automations plan feature.';

create or replace function app.delete_automation(p_automation_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_org uuid := (select a.org_id from app.automations a where a.id = p_automation_id and a.deleted_at is null);
begin
  if v_org is null or not private.has_capability(v_org, 'org.automations.write') then
    raise exception using errcode = '42501', message = 'automation not found';
  end if;
  update app.automation_conditions set deleted_at = now() where automation_id = p_automation_id and deleted_at is null;
  update app.automation_actions set deleted_at = now() where automation_id = p_automation_id and deleted_at is null;
  update app.automations set deleted_at = now(), enabled = false, paused_at = null, pause_reason = null where id = p_automation_id;
end;
$$;

comment on function app.delete_automation(uuid) is 'Deletes an automation with its conditions and actions (soft delete); its run history stays. Needs org.automations.write; works without the plan feature.';

create or replace function app.automation_definition(p_automation_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org uuid := (select a.org_id from app.automations a where a.id = p_automation_id and a.deleted_at is null);
begin
  if v_org is null or not private.has_capability(v_org, 'org.automations.write') then
    raise exception using errcode = '42501', message = 'automation not found';
  end if;
  return jsonb_build_object('conditions', private.automation_conditions_doc(p_automation_id),
    'actions', private.automation_actions_doc(p_automation_id));
end;
$$;

comment on function app.automation_definition(uuid) is 'An automation''s conditions and actions as JSON documents ({"conditions": {...}, "actions": [...]}), the shape app.save_automation takes. Needs org.automations.write.';

create or replace function app.test_automation(p_automation_id uuid, p_event jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org uuid := (select a.org_id from app.automations a where a.id = p_automation_id and a.deleted_at is null);
  v_conditions jsonb;
begin
  if v_org is null or not private.has_capability(v_org, 'org.automations.write') then
    raise exception using errcode = '42501', message = 'automation not found';
  end if;
  if jsonb_typeof(p_event) is distinct from 'object' then
    perform private.refuse('automation_event_invalid', 'A sample event is a JSON object, as a webhook receives it.');
  end if;
  v_conditions := private.automation_conditions_doc(p_automation_id);
  return jsonb_build_object(
    'matched', private.automation_conditions_match(v_conditions, p_event),
    'conditions', (
      select coalesce(jsonb_agg(jsonb_build_object('field', c.field, 'operator', c.operator::text, 'value', c.value_text,
        'actual', private.automation_value_at(p_event, c.field),
        'matched', private.automation_compare(private.automation_value_at(p_event, c.field), c.operator, c.value_text))
        order by coalesce(g.position, c.position), (c.parent_condition_id is not null), c.position), '[]'::jsonb)
      from app.automation_conditions c
      left join app.automation_conditions g on g.id = c.parent_condition_id
      where c.automation_id = p_automation_id and c.deleted_at is null and c.group_match is null));
end;
$$;

comment on function app.test_automation(uuid, jsonb) is 'Dry run of an automation''s conditions against a sample event body, with no side effects: whether they match and, per condition, the value found and whether it held. Needs org.automations.write.';

create or replace function app.sample_automation_event(p_org_id uuid, p_event_type text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_sample jsonb;
begin
  if p_org_id is null or not private.has_capability(p_org_id, 'org.automations.write') then
    raise exception using errcode = '42501', message = 'organization not found';
  end if;
  select jsonb_build_object('id', e.id, 'type', e.event_type, 'occurred_at', e.occurred_at, 'project_id', e.project_id,
    'subject', jsonb_build_object('table', e.subject_table, 'id', e.subject_id), 'data', e.data)
  into v_sample
  from app.domain_events e
  where e.org_id = p_org_id and e.event_type = p_event_type
  order by e.occurred_at desc
  limit 1;
  return coalesce(v_sample, (
    select jsonb_build_object('id', null, 'type', t.code, 'occurred_at', now(), 'project_id', null,
      'subject', jsonb_build_object('table', t.subject, 'id', null), 'data', '{}'::jsonb)
    from private.domain_event_types t where t.code = p_event_type));
end;
$$;

comment on function app.sample_automation_event(uuid, text) is 'A sample body of an event type to test automations with: the org''s latest event of the type, as webhooks send it, or an empty one when there is none. Needs org.automations.write.';

-- Retention -------------------------------------------------------------------------------------------------------------

insert into private.retention_policies (table_name, basis, time_column, retention, purge_method, rationale) values
  ('app.automations', 'Soft Deleted', 'deleted_at', interval '1 year', 'Delete', 'Deleted automations are kept a year beside their run history.'),
  ('app.automation_conditions', 'Soft Deleted', 'deleted_at', interval '1 year', 'Delete', 'Replaced conditions are kept as long as their automation.'),
  ('app.automation_actions', 'Soft Deleted', 'deleted_at', interval '1 year', 'Delete', 'Replaced actions are kept as long as their automation.');

-- Privileges ------------------------------------------------------------------------------------------------------------

revoke all on function private.guard_automation_condition() from public, anon, authenticated;
revoke all on function private.automation_value_at(jsonb, text) from public, anon, authenticated;
revoke all on function private.automation_fold(text) from public, anon, authenticated;
revoke all on function private.automation_equals(jsonb, text) from public, anon, authenticated;
revoke all on function private.automation_compare(jsonb, app.filter_operator, text) from public, anon, authenticated;
revoke all on function private.automation_items_match(text, jsonb, jsonb) from public, anon, authenticated;
revoke all on function private.automation_conditions_match(jsonb, jsonb) from public, anon, authenticated;
revoke all on function private.automation_condition_refusal(jsonb) from public, anon, authenticated;
revoke all on function private.automation_conditions_refusal(jsonb) from public, anon, authenticated;
revoke all on function private.automation_action_refusal(jsonb) from public, anon, authenticated;
revoke all on function private.automation_actions_refusal(jsonb) from public, anon, authenticated;
revoke all on function private.automation_condition_json(app.automation_conditions) from public, anon, authenticated;
revoke all on function private.automation_conditions_doc(uuid) from public, anon, authenticated;
revoke all on function private.automation_actions_doc(uuid) from public, anon, authenticated;
revoke all on function private.automation_member_active(uuid, uuid) from public, anon, authenticated;
revoke all on function private.automation_trigger_subject(text) from public, anon, authenticated;
revoke all on function private.write_automation_conditions(uuid, jsonb) from public, anon, authenticated;
revoke all on function private.write_automation_actions(uuid, jsonb) from public, anon, authenticated;
revoke all on function private.check_automation_actions(uuid, text, jsonb) from public, anon, authenticated;

revoke all on function app.save_automation(uuid, uuid, text, text, text, jsonb, jsonb, boolean, timestamptz) from public, anon;
grant execute on function app.save_automation(uuid, uuid, text, text, text, jsonb, jsonb, boolean, timestamptz) to authenticated;
revoke all on function app.set_automation_enabled(uuid, boolean) from public, anon;
grant execute on function app.set_automation_enabled(uuid, boolean) to authenticated;
revoke all on function app.delete_automation(uuid) from public, anon;
grant execute on function app.delete_automation(uuid) to authenticated;
revoke all on function app.automation_definition(uuid) from public, anon;
grant execute on function app.automation_definition(uuid) to authenticated;
revoke all on function app.test_automation(uuid, jsonb) from public, anon;
grant execute on function app.test_automation(uuid, jsonb) to authenticated;
revoke all on function app.sample_automation_event(uuid, text) from public, anon;
grant execute on function app.sample_automation_event(uuid, text) to authenticated;

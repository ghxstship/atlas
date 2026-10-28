-- 2290_opportunity_templates_and_defaults.sql
-- A136 (RRR-199, ADR 0113), Section 4.5.6 item 27 (Settings, Gateway and Marketplace) and Section 4.4.3. An org sets
-- once how its new opportunities start, and every posting starts there instead of from blank:
--   * app.application_question_templates and app.application_template_questions: reusable sets of application
--     questions. app.apply_question_template copies a template's questions into app.opportunity_questions (0720) of a
--     Draft opportunity, after any it already has. The copies are the opportunity's own rows, so editing or deleting
--     the template later never changes a posting, and the applicants' answers keep pointing at the question they
--     answered. Like every opportunity question, a template question asks about the work, never a protected
--     attribute (Section 14.9)
--   * app.opportunity_defaults: one row per org with the default visibility, pay basis (rate type and currency),
--     application window in days and question template for new opportunities. Atlas reads it to prefill the create
--     form, where every value stays editable; nothing in the database applies it behind the form. The visibility is
--     still capped by gateway.marketplace_visibility when publishing (1327), and Public still needs the plan
-- Reading both takes opportunities.posting.read org-wide, or opportunities.posting.write on any project of the org
-- (a coordinator who creates postings on their project starts from the same defaults). Writing them takes
-- opportunities.marketplace.manage, as the rest of the marketplace settings. private.guard_opportunity (1623) is not
-- touched.

-- Question templates ---------------------------------------------------------------------------------------------------

create table app.application_question_templates (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  name text not null,
  description text,
  constraint application_question_templates_name_length check (char_length(btrim(name)) between 1 and 200),
  constraint application_question_templates_description_length check (description is null or char_length(btrim(description)) between 1 and 1000)
);

call private.install_domain_table('app.application_question_templates');

create unique index application_question_templates_org_name_key on app.application_question_templates (org_id, lower(name))
  where deleted_at is null;

call private.describe('app.application_question_templates', 'An org''s reusable sets of application questions (Section 4.4.3). Applying one to a Draft opportunity copies its questions into the opportunity (app.apply_question_template); the copies are the opportunity''s own and never follow later edits to the template.', array[
  'name', 'Template name, unique in the org ignoring case, for example Crew Call Basics.',
  'description', 'What the template is for.'
]);

create table app.application_template_questions (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  application_question_template_id uuid not null references app.application_question_templates (id),
  prompt text not null,
  sort_order integer not null,
  is_required boolean not null default false,
  constraint application_template_questions_prompt_length check (char_length(btrim(prompt)) between 1 and 500),
  constraint application_template_questions_sort_order check (sort_order between 1 and 999)
);

call private.install_domain_table('app.application_template_questions', 'app.application_question_templates', 'application_question_template_id');

create index application_template_questions_template_idx on app.application_template_questions (application_question_template_id, sort_order);

call private.describe('app.application_template_questions', 'Questions of an application question template, copied as they stand into each opportunity the template is applied to. Questions never ask for protected attributes (Section 14.9).', array[
  'application_question_template_id', 'Template.',
  'prompt', 'Question text, as it is copied to the opportunity.',
  'sort_order', 'Display order, 1 to 999.',
  'is_required', 'True when the copied question requires an answer.'
]);

-- Opportunity defaults -------------------------------------------------------------------------------------------------

create table app.opportunity_defaults (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  visibility app.opportunity_visibility not null default 'Invited',
  rate_type app.rate_type,
  currency_code char(3) references private.currencies (currency_code),
  application_window_days smallint,
  application_question_template_id uuid references app.application_question_templates (id),
  constraint opportunity_defaults_org_key unique (org_id),
  constraint opportunity_defaults_window check (application_window_days is null or application_window_days between 1 and 365)
);

call private.install_domain_table('app.opportunity_defaults', null, null,
  array['app.application_question_templates', 'application_question_template_id']);

create index opportunity_defaults_currency_code_idx on app.opportunity_defaults (currency_code);
create index opportunity_defaults_template_idx on app.opportunity_defaults (application_question_template_id);

call private.describe('app.opportunity_defaults', 'How an org''s new opportunities start (Section 4.5.6 item 27): one row per org, read by the create form as editable prefill. Publishing still applies gateway.marketplace_visibility, the plan and pay transparency to whatever the posting ends up with.', array[
  'visibility', 'Visibility a new opportunity starts with: Invited, Pool, Network or Public.',
  'rate_type', 'Pay basis a new opportunity starts with: Hourly, Day, Flat, Milestone or Bid; NULL starts at Rate on Request.',
  'currency_code', 'ISO 4217 currency a new opportunity''s pay starts in; NULL uses the form''s own default.',
  'application_window_days', 'Days from creation to the prefilled application deadline, 1 to 365; NULL leaves the deadline blank.',
  'application_question_template_id', 'Question template a new opportunity starts from; NULL starts with no questions.'
]);

-- Who reads and writes -------------------------------------------------------------------------------------------------

create or replace function private.opportunity_template_reader_org_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select private.orgs_with_capability('opportunities.posting.read')
  union
  select p.org_id from app.projects p where p.id in (select private.project_ids_with('opportunities.posting.write'));
$$;

comment on function private.opportunity_template_reader_org_ids() is 'Orgs whose question templates and opportunity defaults the signed-in person reads (2290): opportunities.posting.read org-wide, or opportunities.posting.write on any project of the org, so everyone who creates a posting starts from the org''s defaults.';
revoke all on function private.opportunity_template_reader_org_ids() from public, anon;
grant execute on function private.opportunity_template_reader_org_ids() to authenticated, service_role;

call private.install_policies('app.application_question_templates',
  $$org_id in (select private.opportunity_template_reader_org_ids())$$,
  $$org_id in (select private.orgs_with_capability('opportunities.marketplace.manage'))$$);
call private.install_policies('app.application_template_questions',
  $$org_id in (select private.opportunity_template_reader_org_ids())$$,
  $$org_id in (select private.orgs_with_capability('opportunities.marketplace.manage'))$$);
call private.install_policies('app.opportunity_defaults',
  $$org_id in (select private.opportunity_template_reader_org_ids())$$,
  $$org_id in (select private.orgs_with_capability('opportunities.marketplace.manage'))$$);

-- Applying a template --------------------------------------------------------------------------------------------------

create or replace function app.apply_question_template(p_opportunity_id uuid, p_template_id uuid)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_opportunity app.opportunities;
  v_template app.application_question_templates;
  v_next integer;
  v_count integer;
begin
  perform private.require_person();
  select * into v_opportunity from app.opportunities o where o.id = p_opportunity_id and o.deleted_at is null for update;
  -- The same rule as the questions' own write policy (0720): opportunities.posting.write on the project.
  if v_opportunity.id is null or not private.can_on_project(v_opportunity.project_id, 'opportunities.posting.write') then
    raise exception using errcode = '42501', message = 'opportunities.posting.write is required on the project';
  end if;
  select * into v_template from app.application_question_templates t where t.id = p_template_id and t.deleted_at is null;
  if v_template.id is null or v_template.org_id <> v_opportunity.org_id
     or v_template.org_id not in (select private.opportunity_template_reader_org_ids()) then
    perform private.refuse('question_template_not_found', 'This question template no longer exists or is not available to you.');
  end if;
  if v_opportunity.opportunity_state <> 'Draft' then
    perform private.refuse('question_template_not_draft', 'A question template applies to a Draft opportunity. Add questions one at a time instead.');
  end if;
  select coalesce(max(q.sort_order), 0) into v_next
  from app.opportunity_questions q where q.opportunity_id = p_opportunity_id and q.deleted_at is null;
  insert into app.opportunity_questions (opportunity_id, prompt, sort_order, is_required)
  select p_opportunity_id, tq.prompt, v_next + row_number() over (order by tq.sort_order, tq.id), tq.is_required
  from app.application_template_questions tq
  where tq.application_question_template_id = p_template_id and tq.deleted_at is null;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

comment on function app.apply_question_template(uuid, uuid) is 'Copies the questions of an application question template of the same org into a Draft opportunity, after the questions it already has, in the template''s order; returns how many it copied. Takes opportunities.posting.write on the opportunity''s project (42501 otherwise) and a template the caller reads. Refusals: question_template_not_found, question_template_not_draft.';
revoke all on function app.apply_question_template(uuid, uuid) from public, anon;
grant execute on function app.apply_question_template(uuid, uuid) to authenticated, service_role;

-- Audit, retention and Trash -------------------------------------------------------------------------------------------

call private.install_audit_trail('app.application_question_templates');
call private.install_audit_trail('app.application_template_questions');
call private.install_audit_trail('app.opportunity_defaults');
call private.install_default_retention('app.application_question_templates');
call private.install_default_retention('app.application_template_questions');
call private.install_default_retention('app.opportunity_defaults');

-- A deleted template is restored from Trash by whoever manages the marketplace settings. A template's questions are
-- removed and added again in the template, and the defaults row is edited in place, never deleted.
insert into private.trash_excluded_tables (table_name, rationale) values
  ('application_template_questions', 'A question of a question template (2290). It is removed and added again in its template; a template removed whole is restored from Trash with its questions.'),
  ('opportunity_defaults', 'An org''s one row of opportunity defaults (2290), edited in place and never deleted; it has no title.');

-- Only this table is registered here. A full private.sync_trash_tables() would also register the tables made eligible
-- since 1033 that ADR 0110 decides (osha_cases among them, titled by a Confidential description), ahead of the
-- migration that decides them; that migration's sync keeps this row, since the table is eligible.
insert into private.trash_tables (table_name, title_column, has_project)
values ('application_question_templates', private.trash_title_column('app.application_question_templates'), false)
on conflict (table_name) do nothing;
select private.rebuild_trash_items_view();

-- 2993_engagement_document_templates.sql
-- B10 Crew onboarding, recruitment and account-free field access (RRR-234, gap G-130, Section 4.4.4, ADR 0149
-- decision 4). An org writes its own agreement wording once, with merge fields, and generates one engagement document
-- per person from it (2994). XOS supplies no agreement wording and seeds no template: the text is the org's.
--   * app.engagement_document_templates: name (unique per org ignoring case), the kind (Agreement, Statement of Work or
--     Non-Disclosure Agreement), the locale that formats its dates and money (en-US or es-US), and the title and body
--     templates. Every {{name}} belongs to the closed list of private.engagement_document_merge_fields
--     (document_template_fields). Eligible for Trash.
--   * Reads: opportunities.engagement.read org-wide, or opportunities.engagement.write on any project of the org (a
--     coordinator who sends agreements on their project starts from the org's templates), as A136's reader helper does
--     for question templates (2290). Writes: opportunities.engagement.write org-wide.
--   * "Uses a rate" is read from the body template (private.engagement_document_uses_rate), never stored. A title never
--     uses the rate (document_template_rate_title): the merged title is readable by every engagement reader and travels
--     in the engagement_document.sent notification.
--   * Once a batch references a template, its title and body are fixed (document_template_in_use): the mask on a body
--     (2994) follows the template's current text, so removing the rate field from a used template would unmask every
--     old body. Atlas offers Duplicate instead.

create or replace function private.engagement_document_merge_fields()
returns text[]
language sql
immutable
set search_path = ''
as $$
  select array['party.name', 'org.name', 'project.name', 'project.key', 'engagement.role', 'engagement.opportunity',
    'engagement.start_date', 'engagement.end_date', 'engagement.rate', 'engagement.pay_basis', 'shifts.count',
    'shifts.first_call', 'shifts.last_end', 'shifts.total_hours', 'shifts.table', 'today'];
$$;

comment on function private.engagement_document_merge_fields() is 'The closed list of merge fields an engagement document template may use (B10): party.name, org.name, project.name, project.key, engagement.role, engagement.opportunity, engagement.start_date, engagement.end_date, engagement.rate, engagement.pay_basis, shifts.count, shifts.first_call, shifts.last_end, shifts.total_hours, shifts.table and today. packages/data/src/engagement-document-merge.ts fills the same list.';
revoke all on function private.engagement_document_merge_fields() from public, anon;
grant execute on function private.engagement_document_merge_fields() to authenticated, service_role;

create or replace function private.template_merge_fields(p_text text)
returns text[]
language sql
immutable
set search_path = ''
as $$
  select coalesce(array_agg(distinct btrim(m[1])), '{}') from regexp_matches(coalesce(p_text, ''), '\{\{([^{}]*)\}\}', 'g') m;
$$;

comment on function private.template_merge_fields(text) is 'The distinct merge field names written as {{name}} in a template text, trimmed.';
revoke all on function private.template_merge_fields(text) from public, anon, authenticated;

create or replace function private.engagement_document_uses_rate(p_body text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select 'engagement.rate' = any(private.template_merge_fields(p_body));
$$;

comment on function private.engagement_document_uses_rate(text) is 'True when a template''s body uses the Restricted engagement.rate field. Read from the text, never stored. A title never uses it (document_template_rate_title).';
revoke all on function private.engagement_document_uses_rate(text) from public, anon, authenticated;

create table app.engagement_document_templates (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  name text not null,
  document_kind app.engagement_document_kind not null,
  locale text not null default 'en-US',
  title_template text not null,
  body_template text not null,
  deleted_at timestamptz,
  constraint engagement_document_templates_name check (char_length(btrim(name)) between 1 and 200),
  constraint engagement_document_templates_locale check (locale in ('en-US', 'es-US')),
  constraint engagement_document_templates_title check (char_length(btrim(title_template)) between 1 and 200),
  constraint engagement_document_templates_body check (char_length(btrim(body_template)) between 1 and 100000)
);

create unique index engagement_document_templates_org_name_key on app.engagement_document_templates (org_id, lower(name))
  where deleted_at is null;

call private.install_domain_table('app.engagement_document_templates');
call private.describe('app.engagement_document_templates', 'An org''s own agreement wording with merge fields (B10, ADR 0149 decision 4), merged per person into engagement documents by the data layer as the caller (app.create_engagement_document_batch). XOS supplies no wording and seeds no template.', array[
  'name', 'Template name, unique in the org ignoring case.',
  'document_kind', 'Agreement, Statement of Work or Non-Disclosure Agreement.',
  'locale', 'en-US or es-US: how merged dates and money are written.',
  'title_template', 'Title of each generated document, with merge fields, 1 to 200 characters. Never uses engagement.rate.',
  'body_template', 'Text of each generated document, with merge fields from private.engagement_document_merge_fields, 1 to 100000 characters.'
]);

create or replace function private.guard_engagement_document_template()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_unknown text;
begin
  if new.document_kind not in ('Agreement', 'Statement of Work', 'Non-Disclosure Agreement') then
    perform private.refuse('document_template_kind', 'A template generates an Agreement, a Statement of Work or a Non-Disclosure Agreement.');
  end if;
  if 'engagement.rate' = any(private.template_merge_fields(new.title_template)) then
    perform private.refuse('document_template_rate_title', 'A title is read by everyone who reads engagements, so it cannot use the rate. Put the rate in the body.');
  end if;
  if tg_op = 'UPDATE' and (new.title_template is distinct from old.title_template or new.body_template is distinct from old.body_template)
     and exists (select 1 from app.engagement_document_batches b where b.engagement_document_template_id = old.id) then
    perform private.refuse('document_template_in_use', 'Documents were generated from this template, so its wording is fixed. Duplicate it to change the wording.');
  end if;
  select string_agg(f, ', ' order by f) into v_unknown
  from unnest(private.template_merge_fields(new.title_template || ' ' || new.body_template)) f
  where f <> all (private.engagement_document_merge_fields());
  if v_unknown is not null then
    perform private.refuse('document_template_fields', format('These are not merge fields: %s.', v_unknown));
  end if;
  return new;
end;
$$;

comment on function private.guard_engagement_document_template() is 'Engagement document templates generate an Agreement, a Statement of Work or a Non-Disclosure Agreement (document_template_kind), every {{name}} in their title and body is a merge field (document_template_fields), the title never uses the rate (document_template_rate_title), and the title and body are fixed once a batch references the template (document_template_in_use).';
revoke all on function private.guard_engagement_document_template() from public, anon, authenticated;

create trigger t40_guard_engagement_document_template before insert or update on app.engagement_document_templates
  for each row execute function private.guard_engagement_document_template();

create or replace function private.engagement_document_template_reader_org_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select private.orgs_with_capability('opportunities.engagement.read')
  union
  select p.org_id from app.projects p where p.id in (select private.project_ids_with('opportunities.engagement.write'));
$$;

comment on function private.engagement_document_template_reader_org_ids() is 'Orgs whose engagement document templates the signed-in person reads (B10): opportunities.engagement.read org-wide, or opportunities.engagement.write on any project of the org, so everyone who sends agreements on a project starts from the org''s templates.';
revoke all on function private.engagement_document_template_reader_org_ids() from public, anon;
grant execute on function private.engagement_document_template_reader_org_ids() to authenticated, service_role;

call private.install_policies('app.engagement_document_templates',
  $$org_id in (select private.engagement_document_template_reader_org_ids())$$,
  $$org_id in (select private.orgs_with_capability('opportunities.engagement.write'))$$);

call private.install_default_retention('app.engagement_document_templates');
call private.install_audit_trail('app.engagement_document_templates');

-- A deleted template is restored from Trash by whoever writes engagements org-wide.
select private.sync_trash_tables();

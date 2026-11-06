-- 2991_registration_pages.sql
-- B10 Crew onboarding, recruitment and account-free field access (RRR-234, gap G-129, Section 4.4.3 and Section
-- 4.8.1, ADR 0149 decision 3). An org opens a public registration page that fills one of its Talent pools: crew and
-- volunteers sign in (or sign up) to Gateway and register (2992). The page shows its own copy and questions only and
-- never names the pool, which stays internal (0720).
--   * app.registration_pages: the org's page, a slug unique per org among live rows, a title and intro, the Talent pool
--     approved registrants join, and a minimum age of 16 to 99 (decision 54 sets 16 for every account; an org that
--     needs adults sets 18, fixed once the page leaves Draft). Draft, Open and Closed, through the lifecycle ledger. Eligible for Trash. Reads take
--     opportunities.application.read org-wide, writes opportunities.pool.write org-wide, as pools do.
--   * Why a registration is not an opportunity: opportunities are project-scoped postings with a deadline, positions
--     and an application board; a pool is an org object with no project, so a page into a pool stands on its own.
--   * app.registration_page_questions: what the page asks, editable only while the page is Draft. Like an application
--     question, a registration question asks about the work, never a protected attribute (Section 14.9).
--   * app.apply_registration_question_template copies an A136 question template (2290) into a Draft page, the same way
--     app.apply_question_template fills a Draft opportunity, with A136's reader rule for the template.
--   * api_public.registration_page: the copy and questions of an Open page by org slug and page slug, for anyone,
--     with one refusal (registration_page_closed) for a Draft, Closed or missing page, for a page whose pool was deleted
--     or whose org is read-only, and for a signed-in caller the org flagged Do Not Engage, so neither the flag nor the
--     billing state ever shows. org_id comes back only for Gateway's custom-domain check (inBrandScope) and is never
--     rendered.

-- Pages --------------------------------------------------------------------------------------------------------------

create type app.registration_page_state as enum ('Draft', 'Open', 'Closed');
comment on type app.registration_page_state is 'Registration page states (B10): drafted, Open to registrations, or Closed. A Closed page may open again.';

insert into private.lifecycle_transition_rules (lifecycle, from_state, to_state) values
  ('registration_page', 'Draft', 'Open'),
  ('registration_page', 'Draft', 'Closed'),
  ('registration_page', 'Open', 'Closed'),
  ('registration_page', 'Closed', 'Open');

create table app.registration_pages (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  slug text not null,
  title text not null,
  intro text,
  talent_pool_id uuid not null references app.talent_pools (id),
  minimum_age smallint not null default 16,
  page_state app.registration_page_state not null default 'Draft',
  deleted_at timestamptz,
  constraint registration_pages_slug check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and char_length(slug) between 1 and 80),
  constraint registration_pages_title check (char_length(btrim(title)) between 1 and 200),
  constraint registration_pages_intro check (intro is null or char_length(btrim(intro)) between 1 and 4000),
  constraint registration_pages_minimum_age check (minimum_age between 16 and 99)
);

create unique index registration_pages_org_slug_key on app.registration_pages (org_id, slug) where deleted_at is null;
create index registration_pages_pool_idx on app.registration_pages (talent_pool_id);

call private.install_domain_table('app.registration_pages', null, null, array['app.talent_pools', 'talent_pool_id']);
call private.describe('app.registration_pages', 'An org''s public crew registration page (B10, ADR 0149 decision 3): its copy, its questions and the Talent pool approved registrants join. The page never names the pool. Draft, Open or Closed.', array[
  'slug', 'Address of the page under the org''s slug in Gateway (/join/{org}/{slug}), unique in the org among live pages.',
  'title', 'Page title, 1 to 200 characters.',
  'intro', 'What the page tells a visitor, up to 4000 characters.',
  'talent_pool_id', 'Talent pool an approved registrant joins. Internal: never shown on the page.',
  'minimum_age', 'Minimum age a registrant confirms, 16 to 99 (16 by default, decision 54).',
  'page_state', 'Draft, Open or Closed.'
]);

call private.install_lifecycle('app.registration_pages', 'registration_page_id', 'page_state', 'registration_page', 'Draft',
  $$registration_page_id in (select p.id from app.registration_pages p
      where p.org_id in (select private.orgs_with_capability('opportunities.application.read')))$$);

call private.install_policies('app.registration_pages',
  $$org_id in (select private.orgs_with_capability('opportunities.application.read'))$$,
  $$org_id in (select private.orgs_with_capability('opportunities.pool.write'))$$);

call private.install_default_retention('app.registration_page_state_transitions');
call private.install_default_retention('app.registration_pages');
call private.install_audit_trail('app.registration_pages');

create or replace function private.guard_registration_page()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' or new.talent_pool_id is distinct from old.talent_pool_id then
    if not exists (select 1 from app.talent_pools p
                   where p.id = new.talent_pool_id and p.org_id = new.org_id and p.deleted_at is null and p.pool_kind = 'Talent') then
      perform private.refuse('registration_page_pool', 'A registration page fills a live Talent pool of the org.');
    end if;
  end if;
  if tg_op = 'UPDATE' and new.slug is distinct from old.slug and old.page_state <> 'Draft' then
    perform private.refuse('registration_page_slug_fixed', 'A page keeps its address once it has opened; close it and open a new one.');
  end if;
  if tg_op = 'UPDATE' and new.minimum_age is distinct from old.minimum_age and old.page_state <> 'Draft' then
    perform private.refuse('registration_page_minimum_age_fixed', 'A page keeps its minimum age once it has opened; close it and open a new one.');
  end if;
  return new;
end;
$$;

comment on function private.guard_registration_page() is 'Registration pages fill a live Talent pool of their org (registration_page_pool) and keep their slug and minimum age once they have left Draft.';
revoke all on function private.guard_registration_page() from public, anon, authenticated;

create trigger t40_guard_registration_page before insert or update on app.registration_pages
  for each row execute function private.guard_registration_page();

create or replace function app.transition_registration_page(
  p_page_id uuid,
  p_expected app.registration_page_state,
  p_next app.registration_page_state,
  p_reason text default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_page app.registration_pages;
begin
  perform private.require_person();
  select * into v_page from app.registration_pages p where p.id = p_page_id and p.deleted_at is null;
  if v_page.id is null or not private.has_capability(v_page.org_id, 'opportunities.pool.write') then
    raise exception using errcode = '42501', message = 'opportunities.pool.write is required in the org';
  end if;
  if p_next = 'Open' and not exists (select 1 from app.talent_pools tp
                                     where tp.id = v_page.talent_pool_id and tp.deleted_at is null) then
    perform private.refuse('registration_page_pool', 'A registration page fills a live Talent pool of the org.');
  end if;
  return private.transition_lifecycle('registration_page', 'app.registration_pages', 'page_state',
    'app.registration_page_state_transitions', 'registration_page_id', p_page_id, p_expected::text, p_next::text,
    coalesce(nullif(btrim(p_reason), ''), case p_next when 'Open' then 'Page opened.' when 'Closed' then 'Page closed.' else 'Page changed.' end));
end;
$$;

comment on function app.transition_registration_page(uuid, app.registration_page_state, app.registration_page_state, text) is 'A pool manager (opportunities.pool.write in the org) opens, closes or reopens a registration page with compare-and-set: Draft to Open or Closed, Open to Closed, Closed to Open. Opening needs the page''s pool to be live.';

-- Questions ----------------------------------------------------------------------------------------------------------

create table app.registration_page_questions (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  registration_page_id uuid not null references app.registration_pages (id),
  prompt text not null,
  sort_order integer not null,
  is_required boolean not null default false,
  deleted_at timestamptz,
  constraint registration_page_questions_prompt check (char_length(btrim(prompt)) between 1 and 500),
  constraint registration_page_questions_sort_order check (sort_order between 1 and 999)
);

create index registration_page_questions_page_idx on app.registration_page_questions (registration_page_id, sort_order);

call private.install_domain_table('app.registration_page_questions', 'app.registration_pages', 'registration_page_id');
call private.describe('app.registration_page_questions', 'Questions of a registration page, editable while the page is Draft. Questions never ask for protected attributes (Section 14.9).', array[
  'registration_page_id', 'Page.',
  'prompt', 'Question text. Asks about the work, never a protected attribute (Section 14.9).',
  'sort_order', 'Display order, 1 to 999.',
  'is_required', 'True when a registrant must answer.'
]);

call private.install_policies('app.registration_page_questions',
  $$org_id in (select private.orgs_with_capability('opportunities.application.read'))$$,
  $$org_id in (select private.orgs_with_capability('opportunities.pool.write'))$$);

call private.install_default_retention('app.registration_page_questions');
call private.install_audit_trail('app.registration_page_questions');

create or replace function private.guard_registration_page_question()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and new.registration_page_id is distinct from old.registration_page_id then
    perform private.refuse('registration_question_fixed', 'A question stays on its page.');
  end if;
  if not exists (select 1 from app.registration_pages p
                 where p.id = new.registration_page_id and p.page_state = 'Draft' and p.deleted_at is null) then
    perform private.refuse('registration_page_not_draft', 'Questions change only while the page is Draft. Close it and start a new page to ask other questions.');
  end if;
  return new;
end;
$$;

comment on function private.guard_registration_page_question() is 'Registration questions are added, edited and removed only while their page is Draft (registration_page_not_draft), and stay on their page.';
revoke all on function private.guard_registration_page_question() from public, anon, authenticated;

create trigger t40_guard_registration_page_question before insert or update on app.registration_page_questions
  for each row execute function private.guard_registration_page_question();

create or replace function app.apply_registration_question_template(p_page_id uuid, p_template_id uuid)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_page app.registration_pages;
  v_template app.application_question_templates;
  v_next integer;
  v_count integer;
begin
  perform private.require_person();
  select * into v_page from app.registration_pages p where p.id = p_page_id and p.deleted_at is null for update;
  -- The same rule as the questions' own write policy: opportunities.pool.write in the org.
  if v_page.id is null or not private.has_capability(v_page.org_id, 'opportunities.pool.write') then
    raise exception using errcode = '42501', message = 'opportunities.pool.write is required in the org';
  end if;
  select * into v_template from app.application_question_templates t where t.id = p_template_id and t.deleted_at is null;
  if v_template.id is null or v_template.org_id <> v_page.org_id
     or v_template.org_id not in (select private.opportunity_template_reader_org_ids()) then
    perform private.refuse('question_template_not_found', 'This question template no longer exists or is not available to you.');
  end if;
  if v_page.page_state <> 'Draft' then
    perform private.refuse('registration_page_not_draft', 'A question template applies to a Draft page.');
  end if;
  select coalesce(max(q.sort_order), 0) into v_next
  from app.registration_page_questions q where q.registration_page_id = p_page_id and q.deleted_at is null;
  insert into app.registration_page_questions (registration_page_id, prompt, sort_order, is_required)
  select p_page_id, tq.prompt, v_next + row_number() over (order by tq.sort_order, tq.id), tq.is_required
  from app.application_template_questions tq
  where tq.application_question_template_id = p_template_id and tq.deleted_at is null;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

comment on function app.apply_registration_question_template(uuid, uuid) is 'Copies the questions of an application question template (2290) of the same org into a Draft registration page, after the questions it already has, in the template''s order; returns how many it copied. Takes opportunities.pool.write in the org (42501 otherwise) and a template the caller reads under A136''s rule (opportunities.posting.read org-wide or opportunities.posting.write on a project). Refusals: question_template_not_found, registration_page_not_draft.';

-- The public page ----------------------------------------------------------------------------------------------------

create or replace function api_public.registration_page(p_org_slug text, p_page_slug text)
returns table (
  refusal text,
  reason text,
  org_id uuid,
  org_name text,
  title text,
  intro text,
  minimum_age smallint,
  question_id uuid,
  prompt text,
  is_required boolean,
  sort_order integer
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_page app.registration_pages;
  v_org app.organizations;
  v_me uuid := private.current_person_id();
begin
  select o.* into v_org from app.organizations o where o.slug = lower(btrim(p_org_slug)) and o.deleted_at is null;
  select p.* into v_page from app.registration_pages p
  where p.org_id = v_org.id and p.slug = lower(btrim(p_page_slug)) and p.deleted_at is null;
  -- One refusal for a Draft, Closed or missing page, a dead pool, a read-only org and a Do Not Engage caller, so neither
  -- the page's draft, the org's billing state nor the flag ever shows.
  if v_org.id is null or v_page.id is null or v_page.page_state <> 'Open'
     or private.org_read_only(v_org.id)
     or not exists (select 1 from app.talent_pools tp where tp.id = v_page.talent_pool_id and tp.deleted_at is null)
     or (v_me is not null and private.excluded_from_org(v_org.id, v_me)) then
    return query select 'REFUSE'::text, 'registration_page_closed'::text, null::uuid, null::text, null::text, null::text, null::smallint,
      null::uuid, null::text, null::boolean, null::integer;
    return;
  end if;
  return query
    select null::text, null::text, v_org.id, v_org.name, v_page.title, v_page.intro, v_page.minimum_age, q.id, q.prompt, q.is_required,
      q.sort_order
    from (select 1) one
    left join app.registration_page_questions q on q.registration_page_id = v_page.id and q.deleted_at is null
    order by q.sort_order nulls first, q.id;
end;
$$;

comment on function api_public.registration_page(text, text) is 'A crew registration page for anyone (B10): the org id (for the Gateway brand scope, never rendered), the org name, title, intro, minimum age and questions of an Open page, one row per question (one row with no question when it has none). Never the pool. A Draft, Closed or missing page, a page whose pool was deleted or whose org is read-only, and a signed-in caller the org flagged Do Not Engage, get one row with refusal REFUSE and reason registration_page_closed.';

-- Privileges and Trash ---------------------------------------------------------------------------------------------------

revoke all on function app.transition_registration_page(uuid, app.registration_page_state, app.registration_page_state, text) from public, anon;
revoke all on function app.apply_registration_question_template(uuid, uuid) from public, anon;
revoke all on function api_public.registration_page(text, text) from public;
grant execute on function app.transition_registration_page(uuid, app.registration_page_state, app.registration_page_state, text) to authenticated, service_role;
grant execute on function app.apply_registration_question_template(uuid, uuid) to authenticated, service_role;
grant execute on function api_public.registration_page(text, text) to anon, authenticated, service_role;

-- A page removed whole is restored from Trash with its questions; a question is removed and added again on its page.
insert into private.trash_excluded_tables (table_name, rationale) values
  ('registration_page_questions', 'A question of a registration page (B10). It is removed and added again on its Draft page; a page removed whole is restored from Trash with its questions.')
on conflict (table_name) do nothing;

select private.sync_trash_tables();

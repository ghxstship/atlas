-- 6522_crew_registrations.sql
-- B10 Crew onboarding, recruitment and account-free field access (RRR-234, gap G-129, Section 4.4.3, Section 4.8.1,
-- Section 14.9, ADR 0149 decisions 1 and 3). A person signed in to Gateway registers on an Open registration page
-- (6521); the org approves or declines, and approving puts them in the page's Talent pool. Nobody is created on their
-- behalf: registering needs an account with decision 54's 16+ confirmation.
--   * app.crew_registrations and app.crew_registration_answers: one live registration per page and person while it is
--     Submitted or Approved, with the answers, the minimum age confirmed at submission and an optional profile share
--     (app.share_profile).
--     Submitted, Approved, Declined and Withdrawn through the lifecycle ledger; a decision's reason stays in the
--     ledger, which only org readers read. Excluded from Trash.
--   * app.submit_crew_registration: refuses registration_page_closed for a Draft, Closed or missing page and for a
--     person the org flagged Do Not Engage, so the flag never shows; registration_age_unconfirmed, the answer rules,
--     registration_duplicate, profile_share_not_yours and registration_rate_limited (10 a person an hour: each success
--     is counted with private.note_rate_event, and a refusal rolls back, so only successes count).
--   * app.withdraw_crew_registration: the registrant withdraws; a pool membership is never removed.
--   * app.decide_crew_registrations: a pool manager decides up to 200 Submitted registrations, each in its own
--     subtransaction, never their own (sod_registration_self). Approving adds an Approved member to the page's pool
--     when the person has no row there; an existing standing is kept. A Do Not Engage flag anywhere in the org refuses
--     registration_person_excluded, an org-side message only. The registrant hears crew_registration.decided.
--   * app.invite_to_registration_page: notifies live members of the page's pool who are not Do Not Engage, and with
--     the flag the people with a Complete engagement with the org in the last 24 months, skipping people registered on
--     the page and people invited in the last 7 days (app.registration_page_invites). It notifies only people
--     private.notify reaches in the org and counts the rest as skipped.
--   * app.crew_registration_list: a definer view with its own row filter for org readers; api_external.my_crew_registrations
--     for the registrant, with no pool and no reason.
-- private.party_org_ids, account deletion's reach and t60_close_crew_registrations (the person's registrations and
-- answers on account deletion) live in 6525, which runs after the pool invitations exist.

-- Registrations -------------------------------------------------------------------------------------------------------

create type app.crew_registration_state as enum ('Submitted', 'Approved', 'Declined', 'Withdrawn');
comment on type app.crew_registration_state is 'Crew registration states (B10): Submitted by the person, Approved or Declined by the org, or Withdrawn by the person.';

insert into private.lifecycle_transition_rules (lifecycle, from_state, to_state) values
  ('crew_registration', 'Submitted', 'Approved'),
  ('crew_registration', 'Submitted', 'Declined'),
  ('crew_registration', 'Submitted', 'Withdrawn'),
  ('crew_registration', 'Approved', 'Withdrawn');

create table app.crew_registrations (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  registration_page_id uuid not null references app.registration_pages (id),
  person_id uuid not null references app.people (id),
  registration_state app.crew_registration_state not null default 'Submitted',
  confirmed_minimum_age smallint not null,
  profile_share_id uuid references app.profile_shares (id),
  deleted_at timestamptz,
  constraint crew_registrations_confirmed_minimum_age check (confirmed_minimum_age between 16 and 99)
);

create index crew_registrations_page_idx on app.crew_registrations (registration_page_id);
create index crew_registrations_person_id_idx on app.crew_registrations (person_id);
create index crew_registrations_profile_share_id_idx on app.crew_registrations (profile_share_id);
create unique index crew_registrations_live_key on app.crew_registrations (registration_page_id, person_id)
  where deleted_at is null and registration_state in ('Submitted', 'Approved');

call private.install_domain_table('app.crew_registrations', 'app.registration_pages', 'registration_page_id',
  array['app.profile_shares', 'profile_share_id']);
call private.describe('app.crew_registrations', 'A person''s registration on an org''s crew registration page (B10, ADR 0149 decision 3), written only by the registration RPCs. Approving makes them a member of the page''s Talent pool. The registrant reads their own through api_external.my_crew_registrations.', array[
  'org_id', 'Owning org, derived from the page.',
  'registration_page_id', 'Page registered on.',
  'person_id', 'Registrant, signed in.',
  'registration_state', 'Submitted, Approved, Declined or Withdrawn.',
  'confirmed_minimum_age', 'The page''s minimum age at submission, which the registrant confirmed (with decision 54''s 16+).',
  'profile_share_id', 'Profile share the registrant gave the org with the registration (app.share_profile).'
]);

call private.install_lifecycle('app.crew_registrations', 'crew_registration_id', 'registration_state', 'crew_registration', 'Submitted',
  $$crew_registration_id in (select g.id from app.crew_registrations g
      where g.org_id in (select private.orgs_with_capability('opportunities.application.read')))$$);

call private.install_policies('app.crew_registrations',
  $$org_id in (select private.orgs_with_capability('opportunities.application.read'))$$);
revoke insert, update on app.crew_registrations from authenticated;

call private.install_default_retention('app.crew_registration_state_transitions');
call private.install_default_retention('app.crew_registrations');
call private.install_audit_trail('app.crew_registrations');

create table app.crew_registration_answers (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  crew_registration_id uuid not null references app.crew_registrations (id),
  registration_page_question_id uuid not null references app.registration_page_questions (id),
  answer text not null,
  deleted_at timestamptz,
  constraint crew_registration_answers_answer check (char_length(btrim(answer)) between 1 and 4000)
);

create unique index crew_registration_answers_key on app.crew_registration_answers (crew_registration_id, registration_page_question_id)
  where deleted_at is null;
create index crew_registration_answers_question_idx on app.crew_registration_answers (registration_page_question_id);

call private.install_domain_table('app.crew_registration_answers', 'app.crew_registrations', 'crew_registration_id',
  array['app.registration_page_questions', 'registration_page_question_id']);
call private.describe('app.crew_registration_answers', 'A registrant''s answers to the questions of a registration page, one per question.', array[
  'crew_registration_id', 'Registration.',
  'registration_page_question_id', 'Question answered.',
  'answer', 'Answer, 1 to 4000 characters.'
]);

insert into private.column_classifications (table_name, column_name, classification, read_capability) values
  ('app.crew_registration_answers', 'answer', 'Confidential', null);

call private.install_policies('app.crew_registration_answers',
  $$org_id in (select private.orgs_with_capability('opportunities.application.read'))$$);
revoke insert, update on app.crew_registration_answers from authenticated;

call private.install_default_retention('app.crew_registration_answers');
call private.install_audit_trail('app.crew_registration_answers');

create table app.registration_page_invites (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  registration_page_id uuid not null references app.registration_pages (id),
  person_id uuid not null references app.people (id),
  invited_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint registration_page_invites_key unique (registration_page_id, person_id)
);

create index registration_page_invites_person_id_idx on app.registration_page_invites (person_id);

call private.install_domain_table('app.registration_page_invites', 'app.registration_pages', 'registration_page_id');
call private.describe('app.registration_page_invites', 'When each person was last invited to a registration page (B10), so app.invite_to_registration_page skips anyone invited in the last 7 days. One row per page and person, updated in place.', array[
  'registration_page_id', 'Page.',
  'person_id', 'Person invited.',
  'invited_at', 'When they were last invited.'
]);

call private.install_policies('app.registration_page_invites',
  $$org_id in (select private.orgs_with_capability('opportunities.application.read'))$$);
revoke insert, update on app.registration_page_invites from authenticated;
call private.install_default_retention('app.registration_page_invites');

insert into private.trash_excluded_tables (table_name, rationale) values
  ('crew_registrations', 'A registration is the person''s own act (B10): they register again, and an org never restores one for them.'),
  ('crew_registration_answers', 'Answers belong to their registration (B10) and are never restored apart from it.'),
  ('registration_page_invites', 'A record of when a person was last invited to a page (B10), updated in place.')
on conflict (table_name) do nothing;

insert into private.domain_event_types (code, subject, description) values
  ('crew_registration.submitted', 'crew_registrations', 'A person registered on a crew registration page.'),
  ('crew_registration.decided', 'crew_registrations', 'A crew registration was approved or declined.'),
  ('crew_registration.withdrawn', 'crew_registrations', 'A person withdrew their crew registration.'),
  ('crew_registration.invited', 'registration_pages', 'People were invited to register on a crew registration page.')
on conflict (code) do nothing;

insert into private.separation_of_duties_rules (code, enforced_on, description) values
  ('sod_registration_self', 'Crew registrations', 'A person cannot approve or decline their own crew registration.')
on conflict (code) do nothing;

-- Submitting ----------------------------------------------------------------------------------------------------------

create or replace function app.submit_crew_registration(
  p_org_slug text,
  p_page_slug text,
  p_answers jsonb,
  p_age_confirmed boolean,
  p_profile_share_id uuid default null,
  p_share_sections app.profile_section[] default null,
  p_work_phone text default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_me uuid := private.require_person();
  v_org app.organizations;
  v_page app.registration_pages;
  v_share app.profile_shares;
  v_share_id uuid := p_profile_share_id;
  v_phone text := nullif(btrim(coalesce(p_work_phone, '')), '');
  v_answer record;
  v_id uuid;
begin
  select o.* into v_org from app.organizations o where o.slug = lower(btrim(p_org_slug)) and o.deleted_at is null;
  select p.* into v_page from app.registration_pages p
  where p.org_id = v_org.id and p.slug = lower(btrim(p_page_slug)) and p.deleted_at is null
  for share;
  if v_org.id is null or v_page.id is null or v_page.page_state <> 'Open' or private.org_read_only(v_org.id)
     or not exists (select 1 from app.talent_pools tp where tp.id = v_page.talent_pool_id and tp.deleted_at is null)
     or private.excluded_from_org(v_org.id, v_me) then
    perform private.refuse('registration_page_closed', 'This registration page is not open.');
  end if;
  if private.rate_limit_exceeded('crew_registration', v_me::text, 10, interval '1 hour') then
    perform private.refuse('registration_rate_limited', 'Too many registrations in the last hour. Try again later.');
  end if;
  if not app.minimum_age_confirmed() or (v_page.minimum_age > 16 and p_age_confirmed is not true) then
    perform private.refuse('registration_age_unconfirmed', format('Confirm that you are %s or older.', v_page.minimum_age));
  end if;
  if p_answers is not null and jsonb_typeof(p_answers) <> 'array' then
    perform private.refuse('registration_answer_unknown', 'Answers are a list of question and answer pairs.');
  end if;
  -- Every answer names a live question of this page, at most once, and holds 1 to 4000 characters.
  if exists (
    select 1 from jsonb_array_elements(coalesce(p_answers, '[]'::jsonb)) a
    where jsonb_typeof(a) <> 'object' or (a ->> 'question_id') is null
       or (a ->> 'question_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or not exists (select 1 from app.registration_page_questions q
                      where q.id = (a ->> 'question_id')::uuid and q.registration_page_id = v_page.id and q.deleted_at is null))
     or (select count(*) from jsonb_array_elements(coalesce(p_answers, '[]'::jsonb)) a)
        <> (select count(distinct a ->> 'question_id') from jsonb_array_elements(coalesce(p_answers, '[]'::jsonb)) a) then
    perform private.refuse('registration_answer_unknown', 'An answer names a question this page does not ask.');
  end if;
  if exists (select 1 from jsonb_array_elements(coalesce(p_answers, '[]'::jsonb)) a
             where char_length(btrim(coalesce(a ->> 'answer', ''))) > 4000) then
    perform private.refuse('registration_answer_length', 'Keep each answer to 4000 characters.');
  end if;
  if exists (
    select 1 from app.registration_page_questions q
    where q.registration_page_id = v_page.id and q.deleted_at is null and q.is_required
      and not exists (select 1 from jsonb_array_elements(coalesce(p_answers, '[]'::jsonb)) a
                      where (a ->> 'question_id')::uuid = q.id and char_length(btrim(coalesce(a ->> 'answer', ''))) > 0)) then
    perform private.refuse('registration_answer_required', 'Answer every required question.');
  end if;
  if exists (select 1 from app.crew_registrations g
             where g.registration_page_id = v_page.id and g.person_id = v_me and g.deleted_at is null
               and g.registration_state in ('Submitted', 'Approved')) then
    perform private.refuse('registration_duplicate', 'You are already registered on this page.');
  end if;
  if p_profile_share_id is not null then
    select s.* into v_share from app.profile_shares s where s.id = p_profile_share_id and s.deleted_at is null;
    if v_share.id is null or v_share.person_id is distinct from v_me or v_share.revoked_at is not null
       or v_share.org_id <> v_org.id then
      perform private.refuse('profile_share_not_yours', 'Share your profile with this organization, then register.');
    end if;
  end if;
  if v_phone is not null and v_phone !~ '^\+[1-9][0-9]{6,14}$' then
    perform private.refuse('registration_phone', 'Enter the work phone with its country code.');
  end if;
  -- The phone and the share belong to the registration: a refusal above leaves neither, and every step below commits with
  -- it. A share adds to the person's own live share for this org, so registering again never piles up shares.
  if coalesce(cardinality(p_share_sections), 0) > 0 then
    if v_share_id is null then
      select s.id into v_share_id from app.profile_shares s
      where s.org_id = v_org.id and s.person_id = v_me and s.revoked_at is null and s.deleted_at is null
      order by s.created_at desc limit 1;
    end if;
    v_share_id := app.share_profile_sections(v_org.id, v_share_id, p_share_sections);
  end if;
  if v_phone is not null then
    perform app.set_personal_setting('workforce.work_phone', null, v_phone);
  end if;
  insert into app.crew_registrations (registration_page_id, person_id, confirmed_minimum_age, profile_share_id)
  values (v_page.id, v_me, v_page.minimum_age, v_share_id)
  returning id into v_id;
  for v_answer in
    select (a ->> 'question_id')::uuid as question_id, btrim(a ->> 'answer') as answer
    from jsonb_array_elements(coalesce(p_answers, '[]'::jsonb)) a
    where char_length(btrim(coalesce(a ->> 'answer', ''))) > 0
  loop
    insert into app.crew_registration_answers (crew_registration_id, registration_page_question_id, answer)
    values (v_id, v_answer.question_id, v_answer.answer);
  end loop;
  -- Only a registration that succeeds is counted: a refusal rolls this back with everything else.
  perform private.note_rate_event('crew_registration', v_me::text);
  perform private.emit_event(v_org.id, 'crew_registration.submitted', 'crew_registrations', v_id, null,
    jsonb_build_object('registration_page_id', v_page.id));
  return v_id;
end;
$$;

comment on function app.submit_crew_registration(text, text, jsonb, boolean, uuid, app.profile_section[], text) is 'The signed-in person registers on an Open registration page by org slug and page slug, with answers [{question_id, answer}], the page''s age confirmation, an optional profile share of their own for the org, optional sections to share and an optional E.164 work phone. The sections and the phone are written in the same transaction, so a refused registration shares nothing and saves nothing. Refusals: registration_page_closed (also for a dead pool, a read-only org and a person the org flagged Do Not Engage), registration_rate_limited (10 a person an hour), registration_age_unconfirmed (no 16+ confirmation, or a page minimum above 16 without p_age_confirmed), registration_answer_unknown, registration_answer_length, registration_answer_required, registration_duplicate, profile_share_not_yours, registration_phone. Returns the registration id.';

create or replace function app.withdraw_crew_registration(p_registration_id uuid)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_me uuid := private.require_person();
  v_registration app.crew_registrations;
begin
  select * into v_registration from app.crew_registrations g where g.id = p_registration_id and g.deleted_at is null for update;
  if v_registration.id is null or v_registration.person_id <> v_me then
    raise exception using errcode = '42501', message = 'only the registrant withdraws a registration';
  end if;
  if v_registration.registration_state not in ('Submitted', 'Approved') then
    perform private.refuse('registration_not_withdrawable', 'This registration was already declined or withdrawn.');
  end if;
  perform private.transition_lifecycle('crew_registration', 'app.crew_registrations', 'registration_state',
    'app.crew_registration_state_transitions', 'crew_registration_id', v_registration.id,
    v_registration.registration_state::text, 'Withdrawn', 'Withdrawn by the registrant.');
  perform private.emit_event(v_registration.org_id, 'crew_registration.withdrawn', 'crew_registrations', v_registration.id, null, '{}'::jsonb);
  return v_registration.id;
end;
$$;

comment on function app.withdraw_crew_registration(uuid) is 'The registrant withdraws their Submitted or Approved registration (42501 for anyone else; registration_not_withdrawable once it is Declined or Withdrawn). A pool membership an approval gave is never removed by withdrawing.';

-- Deciding ----------------------------------------------------------------------------------------------------------

create or replace function private.decide_crew_registration(p_registration_id uuid, p_approve boolean, p_reason text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_me uuid := private.require_person();
  v_registration app.crew_registrations;
  v_page app.registration_pages;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  select * into v_registration from app.crew_registrations g where g.id = p_registration_id and g.deleted_at is null for update;
  if v_registration.id is null or not private.has_capability(v_registration.org_id, 'opportunities.pool.write') then
    perform private.refuse('registration_not_found', 'This registration no longer exists or is not available to you.');
  end if;
  if v_registration.person_id = v_me then
    perform private.refuse('sod_registration_self', 'A person cannot approve or decline their own crew registration.');
  end if;
  if v_registration.registration_state <> 'Submitted' then
    perform private.refuse('registration_not_submitted', 'Only a Submitted registration is approved or declined.');
  end if;
  if p_approve then
    select * into v_page from app.registration_pages p where p.id = v_registration.registration_page_id;
    if not exists (select 1 from app.talent_pools tp
                   where tp.id = v_page.talent_pool_id and tp.deleted_at is null and tp.pool_kind = 'Talent') then
      perform private.refuse('registration_page_pool', 'The page''s pool was deleted. Point the page at a live Talent pool first.');
    end if;
    if private.excluded_from_org(v_registration.org_id, v_registration.person_id) then
      perform private.refuse('registration_person_excluded', 'This person is flagged Do Not Engage in a pool of the organization.');
    end if;
    if not exists (select 1 from app.pool_members m
                   where m.talent_pool_id = v_page.talent_pool_id and m.person_id = v_registration.person_id and m.deleted_at is null) then
      insert into app.pool_members (talent_pool_id, person_id, standing)
      values (v_page.talent_pool_id, v_registration.person_id, 'Approved');
    end if;
  end if;
  perform private.transition_lifecycle('crew_registration', 'app.crew_registrations', 'registration_state',
    'app.crew_registration_state_transitions', 'crew_registration_id', v_registration.id, 'Submitted',
    case when p_approve then 'Approved' else 'Declined' end,
    left(case when p_approve then 'Approved' else 'Declined' end || coalesce(': ' || v_reason, '.'), 500));
  perform private.emit_event(v_registration.org_id, 'crew_registration.decided', 'crew_registrations', v_registration.id, null,
    jsonb_build_object('approved', p_approve));
  perform private.notify(v_registration.org_id, v_registration.person_id, 'crew_registration.decided', 'crew_registrations',
    v_registration.id, null, (
      select jsonb_build_object(
        'orgName', o.name,
        'title', p.title,
        'outcome', case when p_approve then 'approved' else 'declined' end,
        'gatewayPath', '/join/' || o.slug || '/' || p.slug)
      from app.registration_pages p join app.organizations o on o.id = p.org_id
      where p.id = v_registration.registration_page_id));
end;
$$;

comment on function private.decide_crew_registration(uuid, boolean, text) is 'One decision of app.decide_crew_registrations: a pool manager approves or declines a Submitted registration that is not their own; approving adds an Approved member to the page''s live pool when the person has none there and refuses a person flagged Do Not Engage in the org. The reason goes to the ledger only. Sends crew_registration.decided.';
revoke all on function private.decide_crew_registration(uuid, boolean, text) from public, anon, authenticated;

create or replace function app.decide_crew_registrations(p_ids uuid[], p_approve boolean, p_reason text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_out jsonb := '[]'::jsonb;
  v_state text;
  v_hint text;
begin
  perform private.require_person();
  if coalesce(cardinality(p_ids), 0) not between 1 and 200 then
    perform private.refuse('registration_decide_batch', 'Decide 1 to 200 registrations at a time.');
  end if;
  if p_approve is null then
    perform private.refuse('registration_decide_batch', 'Choose approve or decline.');
  end if;
  if not exists (select 1 from app.crew_registrations g where g.id = any(p_ids)
                   and private.has_capability(g.org_id, 'opportunities.pool.write')) then
    raise exception using errcode = '42501', message = 'opportunities.pool.write is required in the org';
  end if;
  foreach v_id in array (select array_agg(distinct x) from unnest(p_ids) x) loop
    begin
      perform private.decide_crew_registration(v_id, p_approve, p_reason);
      v_out := v_out || jsonb_build_array(jsonb_build_object('id', v_id, 'outcome', 'applied', 'code', null));
    exception when sqlstate 'XR001' then
      get stacked diagnostics v_hint = pg_exception_hint;
      v_out := v_out || jsonb_build_array(jsonb_build_object('id', v_id, 'outcome', 'refused', 'code', coalesce(nullif(v_hint, ''), 'refused')));
    end;
  end loop;
  return v_out;
end;
$$;

comment on function app.decide_crew_registrations(uuid[], boolean, text) is 'A pool manager (opportunities.pool.write in the org) approves or declines 1 to 200 registrations (registration_decide_batch), each in its own subtransaction: returns [{id, outcome applied or refused, code}], and a refused row never fails the batch. Row refusals: registration_not_found, sod_registration_self, registration_not_submitted, registration_page_pool, registration_person_excluded. The reason stays internal.';

-- Inviting --------------------------------------------------------------------------------------------------------------

create or replace function app.invite_to_registration_page(p_page_id uuid, p_include_past_crew boolean default false)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_page app.registration_pages;
  v_org app.organizations;
  v_people uuid[];
  v_person uuid;
  v_notice uuid;
  v_count integer := 0;
begin
  perform private.require_person();
  select * into v_page from app.registration_pages p where p.id = p_page_id and p.deleted_at is null for update;
  if v_page.id is null or not private.has_capability(v_page.org_id, 'opportunities.pool.write') then
    raise exception using errcode = '42501', message = 'opportunities.pool.write is required in the org';
  end if;
  if v_page.page_state <> 'Open' then
    perform private.refuse('registration_page_closed', 'Open the page before inviting people to it.');
  end if;
  select * into v_org from app.organizations o where o.id = v_page.org_id;
  -- Never a person flagged Do Not Engage, one registered on the page, or one invited to it in the last 7 days.
  select coalesce(array_agg(x.person_id order by x.person_id), '{}') into v_people
  from (
    select m.person_id from app.pool_members m
    where m.talent_pool_id = v_page.talent_pool_id and m.deleted_at is null and m.person_id is not null
      and m.standing <> 'Do Not Engage'
    union
    select e.person_id from app.engagements e
    where p_include_past_crew and e.org_id = v_page.org_id and e.deleted_at is null and e.person_id is not null
      and e.engagement_state = 'Complete'
      and exists (select 1 from app.engagement_state_transitions t
                  where t.engagement_id = e.id and t.to_state = 'Complete' and t.created_at > now() - interval '24 months')
  ) x
  where not private.excluded_from_org(v_page.org_id, x.person_id)
    and not exists (select 1 from app.crew_registrations g where g.registration_page_id = v_page.id and g.person_id = x.person_id
                      and g.deleted_at is null and g.registration_state in ('Submitted', 'Approved'))
    and not exists (select 1 from app.registration_page_invites r where r.registration_page_id = v_page.id
                      and r.person_id = x.person_id and r.deleted_at is null and r.invited_at > now() - interval '7 days');
  if cardinality(v_people) > 1000 then
    perform private.refuse('registration_invite_limit', 'Invite at most 1000 people at a time. Narrow the pool or leave out past crew.');
  end if;
  foreach v_person in array v_people loop
    -- private.notify reaches members of the org and its external parties; it skips anyone else, who is not counted.
    v_notice := private.notify(v_page.org_id, v_person, 'crew_registration.invited', 'registration_pages', v_page.id, null,
      jsonb_build_object('orgName', v_org.name, 'title', v_page.title, 'gatewayPath', '/join/' || v_org.slug || '/' || v_page.slug));
    if v_notice is null then
      continue;
    end if;
    insert into app.registration_page_invites (registration_page_id, person_id, invited_at)
    values (v_page.id, v_person, now())
    on conflict (registration_page_id, person_id) do update set invited_at = excluded.invited_at, deleted_at = null;
    v_count := v_count + 1;
  end loop;
  perform private.emit_event(v_page.org_id, 'crew_registration.invited', 'registration_pages', v_page.id, null,
    jsonb_build_object('invited', v_count));
  return v_count;
end;
$$;

comment on function app.invite_to_registration_page(uuid, boolean) is 'A pool manager invites people to an Open registration page: live members of its pool who are not Do Not Engage and, with p_include_past_crew, people with a Complete engagement with the org in the last 24 months. Skips people flagged Do Not Engage, people registered on the page, people invited to it in the last 7 days and people private.notify cannot reach in the org. Refuses registration_page_closed and registration_invite_limit (more than 1000). Sends crew_registration.invited and returns how many were invited.';

-- Reads -------------------------------------------------------------------------------------------------------------------

create view app.crew_registration_list as
select g.id, g.org_id, g.registration_page_id, p.title as page_title, g.person_id, pe.full_name, g.registration_state,
  g.confirmed_minimum_age, g.profile_share_id, g.created_at as submitted_at,
  (select t.created_at from app.crew_registration_state_transitions t
   where t.crew_registration_id = g.id and t.to_state in ('Approved', 'Declined')
   order by t.created_at desc limit 1) as decided_at
from app.crew_registrations g
join app.registration_pages p on p.id = g.registration_page_id
join app.people pe on pe.id = g.person_id
where g.deleted_at is null
  and g.org_id in (select private.orgs_with_capability('opportunities.application.read'));

call private.describe('app.crew_registration_list', 'Crew registrations as the registrations queue reads them (B10): the person''s name from its one home on app.people, the page and the state, with the decided time from the ledger. Rows follow the registration read rule: opportunities.application.read org-wide.', array[
  'id', 'Registration.',
  'org_id', 'Org.',
  'registration_page_id', 'Page.',
  'page_title', 'Page title.',
  'person_id', 'Registrant.',
  'full_name', 'Registrant''s name.',
  'registration_state', 'State.',
  'confirmed_minimum_age', 'The minimum age the registrant confirmed.',
  'profile_share_id', 'Profile share given with the registration.',
  'submitted_at', 'When it was submitted.',
  'decided_at', 'When it was approved or declined.'
]);

revoke all on app.crew_registration_list from public, anon;
revoke select on app.crew_registration_list from xos_backup;
grant select on app.crew_registration_list to authenticated, service_role;

create view api_external.my_crew_registrations as
select g.id, o.name as org_name, o.slug as org_slug, p.title as page_title, p.slug as page_slug, g.registration_state,
  g.created_at as submitted_at,
  (select t.created_at from app.crew_registration_state_transitions t
   where t.crew_registration_id = g.id and t.to_state in ('Approved', 'Declined')
   order by t.created_at desc limit 1) as decided_at
from app.crew_registrations g
join app.registration_pages p on p.id = g.registration_page_id
join app.organizations o on o.id = g.org_id
where g.deleted_at is null and g.person_id = private.current_person_id();

call private.describe('api_external.my_crew_registrations', 'The caller''s own crew registrations (B10): the org, the page and the state, when it was submitted and decided. Never the pool or a decision''s reason.', array[
  'id', 'Registration.',
  'org_name', 'Org.',
  'org_slug', 'Org slug, for the page address.',
  'page_title', 'Page title.',
  'page_slug', 'Page slug.',
  'registration_state', 'Submitted, Approved, Declined or Withdrawn.',
  'submitted_at', 'When submitted.',
  'decided_at', 'When approved or declined.'
]);

revoke all on api_external.my_crew_registrations from public, anon;
revoke select on api_external.my_crew_registrations from xos_backup;
grant select on api_external.my_crew_registrations to authenticated, service_role;

-- Privileges ----------------------------------------------------------------------------------------------------------------

revoke all on function app.submit_crew_registration(text, text, jsonb, boolean, uuid, app.profile_section[], text) from public, anon;
revoke all on function app.withdraw_crew_registration(uuid) from public, anon;
revoke all on function app.decide_crew_registrations(uuid[], boolean, text) from public, anon;
revoke all on function app.invite_to_registration_page(uuid, boolean) from public, anon;
grant execute on function app.submit_crew_registration(text, text, jsonb, boolean, uuid, app.profile_section[], text) to authenticated, service_role;
grant execute on function app.withdraw_crew_registration(uuid) to authenticated, service_role;
grant execute on function app.decide_crew_registrations(uuid[], boolean, text) to authenticated, service_role;
grant execute on function app.invite_to_registration_page(uuid, boolean) to authenticated, service_role;

select private.sync_trash_tables();

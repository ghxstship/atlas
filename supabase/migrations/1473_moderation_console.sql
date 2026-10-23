-- 1473_moderation_console.sql
-- A90 operator console (RRR-135, finding A65-009; Section 4.4.3 abuse, Section 14.9 marketplace transparency, EU
-- Digital Services Act articles 16, 17 and 20; ADR 0032). app.moderation_actions (0720) was written only by the
-- platform and nothing wrote it, so a reported listing could never be removed. Now:
--   * the moderation queue (moderation.decide): listings with open reports or open appeals. A report is open until
--     a decision on its listing is made after it.
--   * app.console_decide_listing: a decision is a statement of reasons in parts (Article 17): the action, the
--     ground (illegal content, a breach of the terms, or no violation), the law or rule relied on, the facts and
--     circumstances, whether automated means detected or decided it (never, from the console), and the statement
--     sent to the affected party. The deciding operator is stamped on the row.
--   * the affected party (the org's marketplace managers and the listing's author) is notified with the statement
--     of reasons (listing.moderated), and each reporter whose report it decided is told the outcome
--     (listing_report.decided) where the notification queue reaches them.
--   * appeals (Article 20, the Acceptable Use Policy): within six months, the affected party may appeal a removal or
--     restriction, and the reporter may appeal a decision to take no action on their report. One appeal per
--     decision. Another operator, never the one who decided, upholds or reverses it with a statement; a reversal
--     records the new decision, and the appellant is told the outcome (moderation_appeal.decided).
--   * moderation decisions and appeals stay writable while an org is canceled and read-only (Section 14.7): the
--     platform still acts on reported listings, and the org may still appeal.

-- Decisions: the statement of reasons in parts -----------------------------------------------------------------------

create type app.moderation_ground as enum ('Illegal Content', 'Terms Violation', 'No Violation');
comment on type app.moderation_ground is 'The ground of a moderation decision (Digital Services Act article 17): illegal content, incompatibility with the terms and policies, or no violation found.';

create type app.moderation_appeal_state as enum ('Open', 'Upheld', 'Reversed');
comment on type app.moderation_appeal_state is 'An appeal of a moderation decision (Digital Services Act article 20): Open until another operator upholds the decision or reverses it.';

insert into private.read_only_exempt_tables (table_name, rationale) values
  ('app.moderation_actions', 'The platform still acts on reported listings of a canceled org.'),
  ('app.moderation_appeals', 'An org may still appeal a moderation decision while it is read-only.');
drop trigger if exists t15_refuse_read_only_org on app.moderation_actions;

create table app.moderation_appeals (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  moderation_action_id uuid not null references app.moderation_actions (id),
  appellant_person_id uuid not null references app.people (id),
  grounds text not null,
  appeal_state app.moderation_appeal_state not null default 'Open',
  filed_at timestamptz not null default now(),
  decided_by uuid references app.people (id),
  decision_statement text,
  decided_at timestamptz,
  constraint moderation_appeals_grounds_length check (char_length(btrim(grounds)) between 1 and 4000),
  constraint moderation_appeals_decided check (
    (appeal_state = 'Open') = (decided_at is null)
    and (decided_at is null) = (decided_by is null)
    and (decided_at is null) = (decision_statement is null)),
  constraint moderation_appeals_statement_length check (
    decision_statement is null or char_length(btrim(decision_statement)) between 1 and 4000),
  constraint moderation_appeals_not_own check (decided_by is distinct from appellant_person_id)
);

create index moderation_appeals_appellant_idx on app.moderation_appeals (appellant_person_id);
create index moderation_appeals_decided_by_idx on app.moderation_appeals (decided_by);

call private.install_domain_table('app.moderation_appeals', 'app.moderation_actions', 'moderation_action_id');
create unique index moderation_appeals_one_per_decision on app.moderation_appeals (moderation_action_id)
  where deleted_at is null;
create index moderation_appeals_open_idx on app.moderation_appeals (filed_at) where appeal_state = 'Open' and deleted_at is null;

call private.describe('app.moderation_appeals', 'An appeal of a moderation decision (A90; Digital Services Act article 20; Acceptable Use Policy): by the affected party against a removal or restriction, or by the reporter against no action on their report, within six months. One per decision. Filed only through app.file_moderation_appeal and decided only by another operator through app.console_decide_appeal.', array[
  'moderation_action_id', 'Decision appealed.',
  'appellant_person_id', 'Person who appealed, from the session.',
  'grounds', 'Why the appellant thinks the decision is wrong.',
  'appeal_state', 'Open, Upheld or Reversed.',
  'filed_at', 'When the appeal was filed, set by the database.',
  'decided_by', 'Operator who decided the appeal; never the one who made the decision appealed.',
  'decision_statement', 'The reasons for upholding or reversing, sent to the appellant.',
  'decided_at', 'When the appeal was decided.'
]);

call private.install_policies('app.moderation_appeals',
  $$appellant_person_id = (select private.current_person_id())
    or org_id in (select private.orgs_with_capability('opportunities.posting.read'))$$);
call private.install_audit_trail('app.moderation_appeals');
call private.install_default_retention('app.moderation_appeals');

alter table app.moderation_actions
  add column decided_by uuid references app.people (id),
  add column ground app.moderation_ground,
  add column rule_reference text,
  add column facts text,
  add column automated_detection boolean not null default false,
  add column automated_decision boolean not null default false,
  add column moderation_appeal_id uuid references app.moderation_appeals (id),
  add constraint moderation_actions_statement_parts check (
    decided_by is null or (ground is not null and rule_reference is not null and facts is not null)),
  add constraint moderation_actions_ground_fits check (
    ground is null or ((action in ('Removed', 'Restricted')) = (ground in ('Illegal Content', 'Terms Violation')))),
  add constraint moderation_actions_rule_reference_length check (
    rule_reference is null or char_length(btrim(rule_reference)) between 1 and 300),
  add constraint moderation_actions_facts_length check (facts is null or char_length(btrim(facts)) between 1 and 4000);

create index moderation_actions_decided_by_idx on app.moderation_actions (decided_by);
create index moderation_actions_appeal_idx on app.moderation_actions (moderation_appeal_id);

call private.install_tenant_guards('app.moderation_actions', 'app.opportunities', 'opportunity_id',
  array['app.listing_reports', 'listing_report_id', 'app.moderation_appeals', 'moderation_appeal_id']);

call private.describe('app.moderation_actions', 'Append-only moderation decisions on a listing with the statement of reasons sent to the affected party (EU Digital Services Act article 17). Written only by the platform: from the operator console (A90) with the statement in parts and the deciding operator. The latest decision rules: Removed hides the listing and refuses applications until Restored.', array[
  'decided_by', 'Operator who decided, from the session; null for decisions before the console.',
  'ground', 'Illegal Content, Terms Violation or No Violation.',
  'rule_reference', 'The law or the terms and policies clause relied on, for example Acceptable Use Policy 3.2.',
  'facts', 'The facts and circumstances the decision rests on.',
  'automated_detection', 'Whether automated means detected the content; false for every console decision.',
  'automated_decision', 'Whether the decision was taken by automated means; false for every console decision.',
  'moderation_appeal_id', 'Appeal whose reversal produced this decision, when one did.'
]);

-- Notifications -------------------------------------------------------------------------------------------------------

create or replace function private.notify_moderation_decision(p_action_id uuid)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_action app.moderation_actions;
  v_opp app.opportunities;
  v_person uuid;
  v_count integer := 0;
  v_args jsonb;
begin
  select * into v_action from app.moderation_actions m where m.id = p_action_id;
  select * into v_opp from app.opportunities o where o.id = v_action.opportunity_id;
  v_args := jsonb_build_object('title', v_opp.title, 'action', v_action.action, 'ground', v_action.ground,
    'ruleReference', v_action.rule_reference, 'statement', v_action.statement_of_reasons,
    'appealUntil', v_action.decided_at + interval '6 months');
  -- The affected party: the org's marketplace managers and the listing's author while still a member.
  for v_person in
    select distinct m.person_id from app.memberships m
    where m.org_id = v_opp.org_id and m.deleted_at is null and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now())
      and (m.person_id = v_opp.created_by
           or private.person_capability_reach(m.person_id, v_opp.org_id, 'opportunities.marketplace.manage', true) = 'organization')
  loop
    if private.notify(v_opp.org_id, v_person, 'listing.moderated', 'opportunities', v_opp.id, v_opp.project_id, v_args) is not null then
      v_count := v_count + 1;
    end if;
  end loop;
  -- Each reporter whose report this decision decided: reported before it and after any earlier decision.
  for v_person in
    select distinct r.reporter_person_id from app.listing_reports r
    where r.opportunity_id = v_opp.id and r.deleted_at is null and r.reported_at <= v_action.decided_at
      and not exists (select 1 from app.moderation_actions e
                      where e.opportunity_id = v_opp.id and e.id <> v_action.id and e.decided_at >= r.reported_at
                        and e.decided_at < v_action.decided_at)
  loop
    if private.notify(v_opp.org_id, v_person, 'listing_report.decided', 'opportunities', v_opp.id, v_opp.project_id,
         jsonb_build_object('title', v_opp.title, 'action', v_action.action, 'statement', v_action.statement_of_reasons)) is not null then
      v_count := v_count + 1;
    end if;
  end loop;
  return v_count;
end;
$$;

comment on function private.notify_moderation_decision(uuid) is 'Sends a moderation decision''s statement of reasons to the affected party, the org''s marketplace managers and the listing''s author (listing.moderated), and its outcome to each reporter whose report it decided (listing_report.decided), where the notification queue reaches them (private.notify). Returns how many were notified.';
revoke all on function private.notify_moderation_decision(uuid) from public, anon, authenticated;

-- The queue ----------------------------------------------------------------------------------------------------------

create or replace function private.open_listing_report_count(p_opportunity_id uuid)
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  select count(*) from app.listing_reports r
  where r.opportunity_id = p_opportunity_id and r.deleted_at is null
    and not exists (select 1 from app.moderation_actions m
                    where m.opportunity_id = r.opportunity_id and m.decided_at >= r.reported_at);
$$;

comment on function private.open_listing_report_count(uuid) is 'Reports on a listing that no decision made after them has decided.';
revoke all on function private.open_listing_report_count(uuid) from public, anon, authenticated;

create or replace function app.console_moderation_queue(p_open boolean default true)
returns table (
  opportunity_id uuid,
  title text,
  org_id uuid,
  org_name text,
  opportunity_state app.opportunity_state,
  removed boolean,
  open_reports bigint,
  total_reports bigint,
  open_appeals bigint,
  reasons app.listing_report_reason[],
  first_reported_at timestamptz,
  last_decision app.moderation_action_kind,
  last_decided_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_platform_operator('moderation.decide');
  return query
  select q.id, q.title, q.org_id, q.org_name, q.opportunity_state, q.removed, q.open_reports, q.total_reports,
    q.open_appeals, q.reasons, q.first_reported_at, q.last_decision, q.last_decided_at
  from (
    select o.id, o.title, o.org_id, org.name as org_name, o.opportunity_state, private.opportunity_removed(o.id) as removed,
      private.open_listing_report_count(o.id) as open_reports,
      (select count(*) from app.listing_reports r where r.opportunity_id = o.id and r.deleted_at is null) as total_reports,
      (select count(*) from app.moderation_appeals a join app.moderation_actions m on m.id = a.moderation_action_id
       where m.opportunity_id = o.id and a.appeal_state = 'Open' and a.deleted_at is null) as open_appeals,
      array(select distinct r.reason from app.listing_reports r where r.opportunity_id = o.id and r.deleted_at is null
            order by r.reason) as reasons,
      (select min(r.reported_at) from app.listing_reports r
       where r.opportunity_id = o.id and r.deleted_at is null
         and not exists (select 1 from app.moderation_actions m where m.opportunity_id = o.id and m.decided_at >= r.reported_at))
        as first_reported_at,
      ld.action as last_decision, ld.decided_at as last_decided_at
    from app.opportunities o
    join app.organizations org on org.id = o.org_id
    left join lateral (select m.action, m.decided_at from app.moderation_actions m where m.opportunity_id = o.id
                       order by m.decided_at desc, m.id desc limit 1) ld on true
    where o.id in (select r.opportunity_id from app.listing_reports r where r.deleted_at is null
                   union select m.opportunity_id from app.moderation_actions m)
  ) q
  where (p_open and (q.open_reports > 0 or q.open_appeals > 0))
     or (not p_open and q.open_reports = 0 and q.open_appeals = 0)
  order by q.open_appeals > 0 desc, q.first_reported_at nulls last, q.last_decided_at desc nulls last
  limit 200;
end;
$$;

comment on function app.console_moderation_queue(boolean) is 'The moderation queue (moderation.decide): listings with open reports or open appeals, appeals first, then the oldest open report; or, with p_open false, listings whose reports and appeals are all decided, newest decision first.';
revoke all on function app.console_moderation_queue(boolean) from public, anon;
grant execute on function app.console_moderation_queue(boolean) to authenticated;

create or replace function app.console_listing_detail(p_opportunity_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_operator uuid := private.require_platform_operator('moderation.decide');
  v_opp app.opportunities;
begin
  select * into v_opp from app.opportunities o where o.id = p_opportunity_id;
  if v_opp.id is null then
    raise exception using errcode = '42501', message = 'listing not found';
  end if;
  perform private.log_operator_action('listing.viewed', v_opp.org_id, 'app.opportunities', v_opp.id, null, '{}'::jsonb);
  return jsonb_build_object(
    'listing', jsonb_build_object('id', v_opp.id, 'title', v_opp.title, 'description', v_opp.description,
      'role_type', v_opp.role_type, 'visibility', v_opp.visibility, 'state', v_opp.opportunity_state,
      'starts_on', v_opp.starts_on, 'ends_on', v_opp.ends_on, 'removed', private.opportunity_removed(v_opp.id),
      'deleted', v_opp.deleted_at is not null,
      'org', (select jsonb_build_object('id', o.id, 'name', o.name, 'slug', o.slug) from app.organizations o where o.id = v_opp.org_id),
      'project', (select p.name from app.projects p where p.id = v_opp.project_id)),
    'reports', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'reason', r.reason, 'details', r.details,
                           'reported_at', r.reported_at, 'reporter_name', p.full_name,
                           'open', not exists (select 1 from app.moderation_actions m
                                               where m.opportunity_id = r.opportunity_id and m.decided_at >= r.reported_at))
                           order by r.reported_at desc)
                         from app.listing_reports r left join app.people p on p.id = r.reporter_person_id
                         where r.opportunity_id = v_opp.id and r.deleted_at is null), '[]'::jsonb),
    'decisions', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'action', m.action, 'ground', m.ground,
                             'rule_reference', m.rule_reference, 'facts', m.facts, 'statement', m.statement_of_reasons,
                             'decided_at', m.decided_at, 'decided_by', m.decided_by, 'decided_by_name', p.full_name,
                             'automated_detection', m.automated_detection, 'automated_decision', m.automated_decision,
                             'listing_report_id', m.listing_report_id, 'appeal_id', m.moderation_appeal_id)
                             order by m.decided_at desc, m.id desc)
                           from app.moderation_actions m left join app.people p on p.id = m.decided_by
                           where m.opportunity_id = v_opp.id), '[]'::jsonb),
    'appeals', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'moderation_action_id', a.moderation_action_id,
                           'decision', m.action, 'grounds', a.grounds, 'state', a.appeal_state, 'filed_at', a.filed_at,
                           'appellant_name', ap.full_name, 'decided_by_name', dp.full_name,
                           'decision_statement', a.decision_statement, 'decided_at', a.decided_at,
                           'original_decided_by', m.decided_by,
                           'decidable_by_me', a.appeal_state = 'Open' and m.decided_by is distinct from v_operator)
                           order by a.filed_at desc)
                         from app.moderation_appeals a
                         join app.moderation_actions m on m.id = a.moderation_action_id
                         left join app.people ap on ap.id = a.appellant_person_id
                         left join app.people dp on dp.id = a.decided_by
                         where m.opportunity_id = v_opp.id and a.deleted_at is null), '[]'::jsonb));
end;
$$;

comment on function app.console_listing_detail(uuid) is 'One reported listing for the moderation queue (moderation.decide): the listing, its reports (open or decided), every decision with its statement of reasons in parts and who made it, and its appeals, including whether the signed-in operator may decide each (never their own decision). Each view is logged.';
revoke all on function app.console_listing_detail(uuid) from public, anon;
grant execute on function app.console_listing_detail(uuid) to authenticated;

-- Decisions ------------------------------------------------------------------------------------------------------------

create or replace function private.record_moderation_decision(
  p_opportunity_id uuid,
  p_listing_report_id uuid,
  p_action app.moderation_action_kind,
  p_ground app.moderation_ground,
  p_rule_reference text,
  p_facts text,
  p_statement text,
  p_appeal_id uuid,
  p_operator uuid
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_opp app.opportunities;
  v_report uuid := p_listing_report_id;
  v_id uuid;
begin
  select * into v_opp from app.opportunities o where o.id = p_opportunity_id for update;
  if v_opp.id is null then
    raise exception using errcode = '42501', message = 'listing not found';
  end if;
  if p_action is null or p_ground is null
     or ((p_action in ('Removed', 'Restricted')) <> (p_ground in ('Illegal Content', 'Terms Violation'))) then
    perform private.refuse('moderation_ground', 'Removing or restricting a listing needs a ground: illegal content or a breach of the terms. No action and restoring mean no violation.');
  end if;
  if p_action = 'Restored' and not private.opportunity_removed(v_opp.id) then
    perform private.refuse('moderation_not_removed', 'Only a removed or restricted listing can be restored.');
  end if;
  if p_rule_reference is null or char_length(btrim(p_rule_reference)) not between 1 and 300 then
    perform private.refuse('moderation_rule_reference', 'Name the law or the terms and policies clause relied on, in up to 300 characters.');
  end if;
  if p_facts is null or char_length(btrim(p_facts)) not between 1 and 4000 then
    perform private.refuse('moderation_facts', 'State the facts and circumstances the decision rests on, in up to 4,000 characters.');
  end if;
  if p_statement is null or char_length(btrim(p_statement)) not between 1 and 4000 then
    perform private.refuse('moderation_statement', 'Write the statement of reasons the affected party receives, in up to 4,000 characters.');
  end if;
  if v_report is not null and not exists (select 1 from app.listing_reports r where r.id = v_report and r.opportunity_id = v_opp.id) then
    perform private.refuse('moderation_report_mismatch', 'The report must be one on this listing.');
  end if;
  if v_report is null then
    select r.id into v_report from app.listing_reports r
    where r.opportunity_id = v_opp.id and r.deleted_at is null
      and not exists (select 1 from app.moderation_actions m where m.opportunity_id = r.opportunity_id and m.decided_at >= r.reported_at)
    order by r.reported_at limit 1;
  end if;
  insert into app.moderation_actions (opportunity_id, listing_report_id, action, statement_of_reasons, decided_by, ground,
    rule_reference, facts, automated_detection, automated_decision, moderation_appeal_id)
  values (v_opp.id, v_report, p_action, btrim(p_statement), p_operator, p_ground, btrim(p_rule_reference), btrim(p_facts),
    false, false, p_appeal_id)
  returning id into v_id;
  perform private.emit_event(v_opp.org_id, 'listing.moderated', 'moderation_actions', v_id, v_opp.project_id,
    jsonb_build_object('opportunity_id', v_opp.id, 'action', p_action, 'ground', p_ground));
  perform private.notify_moderation_decision(v_id);
  perform private.log_operator_action('listing.moderated', v_opp.org_id, 'app.moderation_actions', v_id, p_statement,
    jsonb_build_object('opportunity_id', v_opp.id, 'action', p_action, 'ground', p_ground, 'rule_reference', p_rule_reference,
      'appeal_id', p_appeal_id));
  return v_id;
end;
$$;

comment on function private.record_moderation_decision(uuid, uuid, app.moderation_action_kind, app.moderation_ground, text, text, text, uuid, uuid) is 'Records a moderation decision with its statement of reasons in parts, stamped with the operator; emits listing.moderated, notifies the affected party and the reporters it decided, and logs it in the console ledger. Links the oldest open report when none is given.';
revoke all on function private.record_moderation_decision(uuid, uuid, app.moderation_action_kind, app.moderation_ground, text, text, text, uuid, uuid) from public, anon, authenticated;

create or replace function app.console_decide_listing(
  p_opportunity_id uuid,
  p_action app.moderation_action_kind,
  p_ground app.moderation_ground,
  p_rule_reference text,
  p_facts text,
  p_statement text,
  p_listing_report_id uuid default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_operator uuid := private.require_platform_operator('moderation.decide');
begin
  return private.record_moderation_decision(p_opportunity_id, p_listing_report_id, p_action, p_ground, p_rule_reference,
    p_facts, p_statement, null, v_operator);
end;
$$;

comment on function app.console_decide_listing(uuid, app.moderation_action_kind, app.moderation_ground, text, text, text, uuid) is 'An operator (moderation.decide) decides a reported listing (Digital Services Act article 17): Removed, Restricted, Restored or No Action, with the ground, the rule relied on, the facts and the statement of reasons the affected party receives. The decision decides every open report on the listing. Returns the decision id.';
revoke all on function app.console_decide_listing(uuid, app.moderation_action_kind, app.moderation_ground, text, text, text, uuid) from public, anon;
grant execute on function app.console_decide_listing(uuid, app.moderation_action_kind, app.moderation_ground, text, text, text, uuid) to authenticated;

-- Appeals --------------------------------------------------------------------------------------------------------------

create or replace function app.file_moderation_appeal(p_moderation_action_id uuid, p_grounds text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
  v_action app.moderation_actions;
  v_opp app.opportunities;
  v_affected boolean;
  v_reporter boolean;
  v_id uuid;
begin
  select * into v_action from app.moderation_actions m where m.id = p_moderation_action_id;
  select * into v_opp from app.opportunities o where o.id = v_action.opportunity_id;
  v_affected := v_action.id is not null and v_action.action in ('Removed', 'Restricted')
    and (private.has_capability(v_opp.org_id, 'opportunities.marketplace.manage')
         or private.can_on_project(v_opp.project_id, 'opportunities.posting.write'));
  v_reporter := v_action.id is not null and v_action.action in ('No Action', 'Restored')
    and exists (select 1 from app.listing_reports r where r.opportunity_id = v_opp.id and r.reporter_person_id = v_person
                  and r.deleted_at is null and r.reported_at <= v_action.decided_at);
  if not (coalesce(v_affected, false) or coalesce(v_reporter, false)) then
    raise exception using errcode = '42501', message = 'moderation decision not found';
  end if;
  if v_action.decided_at < now() - interval '6 months' then
    perform private.refuse('moderation_appeal_window', 'Appeals are accepted for six months after a decision; this one is older.');
  end if;
  if p_grounds is null or char_length(btrim(p_grounds)) not between 1 and 4000 then
    perform private.refuse('moderation_appeal_grounds', 'Say why the decision is wrong, in up to 4,000 characters.');
  end if;
  perform 1 from app.moderation_actions m where m.id = v_action.id for share;
  if exists (select 1 from app.moderation_appeals a where a.moderation_action_id = v_action.id and a.deleted_at is null) then
    perform private.refuse('moderation_appeal_exists', 'This decision has already been appealed.');
  end if;
  insert into app.moderation_appeals (moderation_action_id, appellant_person_id, grounds)
  values (v_action.id, v_person, btrim(p_grounds))
  returning id into v_id;
  return v_id;
end;
$$;

comment on function app.file_moderation_appeal(uuid, text) is 'Appeals a moderation decision within six months (Digital Services Act article 20): the affected party (opportunities.marketplace.manage in the org, or opportunities.posting.write on the listing''s project) against a removal or restriction, or a reporter against no action or a restoration after their report. One appeal per decision. Returns the appeal id.';
revoke all on function app.file_moderation_appeal(uuid, text) from public, anon;
grant execute on function app.file_moderation_appeal(uuid, text) to authenticated;

create or replace function app.console_decide_appeal(
  p_appeal_id uuid,
  p_outcome app.moderation_appeal_state,
  p_statement text,
  p_action app.moderation_action_kind default null,
  p_ground app.moderation_ground default null,
  p_rule_reference text default null,
  p_facts text default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_operator uuid := private.require_platform_operator('moderation.decide');
  v_appeal app.moderation_appeals;
  v_action app.moderation_actions;
  v_opp app.opportunities;
  v_new uuid;
begin
  select * into v_appeal from app.moderation_appeals a where a.id = p_appeal_id and a.deleted_at is null for update;
  if v_appeal.id is null then
    raise exception using errcode = '42501', message = 'appeal not found';
  end if;
  select * into v_action from app.moderation_actions m where m.id = v_appeal.moderation_action_id;
  select * into v_opp from app.opportunities o where o.id = v_action.opportunity_id;
  if v_appeal.appeal_state <> 'Open' then
    perform private.refuse('moderation_appeal_decided', 'This appeal has already been decided.');
  end if;
  if v_action.decided_by = v_operator then
    perform private.refuse('moderation_appeal_same_operator', 'Another operator decides this appeal: you made the decision it appeals.');
  end if;
  if p_outcome is null or p_outcome = 'Open' then
    perform private.refuse('moderation_appeal_outcome', 'Uphold the decision or reverse it.');
  end if;
  if p_statement is null or char_length(btrim(p_statement)) not between 1 and 4000 then
    perform private.refuse('moderation_statement', 'Write the reasons the appellant receives, in up to 4,000 characters.');
  end if;
  update app.moderation_appeals
  set appeal_state = p_outcome, decided_by = v_operator, decision_statement = btrim(p_statement), decided_at = now()
  where id = v_appeal.id;

  if p_outcome = 'Reversed' then
    if v_action.action in ('Removed', 'Restricted') then
      v_new := private.record_moderation_decision(v_opp.id, v_action.listing_report_id, 'Restored', 'No Violation',
        coalesce(nullif(btrim(p_rule_reference), ''), v_action.rule_reference, 'Appeal'),
        coalesce(nullif(btrim(p_facts), ''), btrim(p_statement)), p_statement, v_appeal.id, v_operator);
    else
      if p_action not in ('Removed', 'Restricted') or p_action is null then
        perform private.refuse('moderation_appeal_new_decision', 'Reversing a decision to take no action needs the new decision: remove or restrict the listing, with its ground, rule and facts.');
      end if;
      v_new := private.record_moderation_decision(v_opp.id, v_action.listing_report_id, p_action, p_ground,
        p_rule_reference, p_facts, p_statement, v_appeal.id, v_operator);
    end if;
  end if;

  perform private.notify(v_appeal.org_id, v_appeal.appellant_person_id, 'moderation_appeal.decided', 'opportunities', v_opp.id,
    v_opp.project_id, jsonb_build_object('title', v_opp.title, 'outcome', p_outcome, 'statement', btrim(p_statement)));
  perform private.log_operator_action('moderation_appeal.decided', v_appeal.org_id, 'app.moderation_appeals', v_appeal.id,
    p_statement, jsonb_build_object('outcome', p_outcome, 'new_decision', v_new));
  return v_appeal.id;
end;
$$;

comment on function app.console_decide_appeal(uuid, app.moderation_appeal_state, text, app.moderation_action_kind, app.moderation_ground, text, text) is 'An operator (moderation.decide) who did not make the decision appealed upholds or reverses the appeal with a statement (Digital Services Act article 20). Reversing a removal or restriction restores the listing; reversing no action records the new decision given. The appellant is told the outcome. Returns the appeal id.';
revoke all on function app.console_decide_appeal(uuid, app.moderation_appeal_state, text, app.moderation_action_kind, app.moderation_ground, text, text) from public, anon;
grant execute on function app.console_decide_appeal(uuid, app.moderation_appeal_state, text, app.moderation_action_kind, app.moderation_ground, text, text) to authenticated;

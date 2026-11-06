-- 6168_one_person_appeal_rule.sql
-- The appeal rule, made true for a company of one (RRR-248, review packet decision 39; ADR 0167, amending ADR 0046).
-- 1473 had "another operator, never the one who decided" decide each appeal, and AUP 7 promised "a person who was not
-- involved in the original decision". With one operator that appeal could never be decided at all, and the promise
-- could never be kept. The Digital Services Act asks for qualified staff and not solely automated means (Article 20(6));
-- it does not ask for a second person, and it excuses micro and small enterprises from Article 20 altogether (Article
-- 19), so the promise is voluntary and can say what actually happens. Now:
--   * every appeal gets a fresh, documented re-review: what was looked at again, and the reasons. Neither may be empty.
--     private.moderation_appeal_reviews keeps the record apart from app.moderation_appeals, because the appellant and the
--     org read that table, and the notes may name a reporter.
--   * the person who decided may re-review when no one else can. The record says so and so does the notice to the
--     appellant, so nothing implies a second employee.
--   * while a named outside reviewer is appointed (6165), the appeal goes to them: the operator records their decision and
--     cannot decide instead. The notice names them.
--   * the person is told the result. A reporter with no tie to the org is outside the notification queue's reach
--     (private.notify answers null), so the outcome goes out as a platform email instead; only if that person has no email
--     left does the record say they could not be told.
-- The same reach gap hid a listing decision's outcome from such a reporter, so private.notify_moderation_decision now
-- tells them the same way.

comment on type app.moderation_appeal_state is 'An appeal of a moderation decision (Acceptable Use Policy 7): Open until a fresh re-review upholds the decision or reverses it.';

call private.describe('app.moderation_appeals', 'An appeal of a moderation decision (A90; Acceptable Use Policy 7): by the affected party against a removal or restriction, or by the reporter against no action on their report, within six months. One per decision. Filed only through app.file_moderation_appeal and decided only through app.console_decide_appeal after a documented re-review (6168), recorded in private.moderation_appeal_reviews.', array[
  'decided_by', 'Operator who recorded the outcome of the re-review. May be the one who made the decision appealed where no one else can review it, which private.moderation_appeal_reviews records and the appellant is told.',
  'decision_statement', 'The reasons for upholding or reversing, sent to the appellant.'
]);

create table private.moderation_appeal_reviews (
  moderation_appeal_id uuid primary key references app.moderation_appeals (id) on delete cascade,
  org_id uuid not null references app.organizations (id),
  recorded_by uuid not null references app.people (id),
  same_reviewer boolean not null,
  outside_reviewer_id uuid references private.legal_outside_reviewers (id),
  re_review_notes text not null,
  told_by text,
  told_at timestamptz,
  created_at timestamptz not null default now(),
  constraint moderation_appeal_reviews_notes_length check (char_length(btrim(re_review_notes)) between 1 and 4000),
  constraint moderation_appeal_reviews_outside_not_same check (outside_reviewer_id is null or not same_reviewer),
  constraint moderation_appeal_reviews_told check (told_by in ('Notification', 'Email')),
  constraint moderation_appeal_reviews_told_at check ((told_by is null) = (told_at is null))
);
create index moderation_appeal_reviews_org_idx on private.moderation_appeal_reviews (org_id);
create index moderation_appeal_reviews_recorded_by_idx on private.moderation_appeal_reviews (recorded_by);
create index moderation_appeal_reviews_outside_idx on private.moderation_appeal_reviews (outside_reviewer_id);

comment on table private.moderation_appeal_reviews is 'The documented re-review behind each appeal outcome (6168): who recorded it, whether the person who made the first decision re-reviewed it, any outside reviewer, what was looked at again and how the appellant was told. Kept apart from app.moderation_appeals because the appellant and the org read that table. Appeals decided before 6168 have no row.';
comment on column private.moderation_appeal_reviews.moderation_appeal_id is 'Appeal.';
comment on column private.moderation_appeal_reviews.org_id is 'Org the appeal belongs to, so the org purge takes this row with it (1351 refuses rows it cannot tie to the org).';
comment on column private.moderation_appeal_reviews.recorded_by is 'Operator who recorded the outcome.';
comment on column private.moderation_appeal_reviews.same_reviewer is 'The operator who made the decision appealed did this re-review.';
comment on column private.moderation_appeal_reviews.outside_reviewer_id is 'The outside reviewer who decided, when one is appointed.';
comment on column private.moderation_appeal_reviews.re_review_notes is 'What was looked at again and how the appeal''s grounds were weighed. Internal; it may name a reporter.';
comment on column private.moderation_appeal_reviews.told_by is 'How the appellant was told: Notification or Email. Null when they could not be reached.';
comment on column private.moderation_appeal_reviews.told_at is 'When they were told.';
comment on column private.moderation_appeal_reviews.created_at is 'When the re-review was recorded.';

alter table private.moderation_appeal_reviews enable row level security;
revoke all on private.moderation_appeal_reviews from public, anon, authenticated;
grant select on private.moderation_appeal_reviews to service_role;

-- Reaching the person -------------------------------------------------------------------------------------------------

create function private.tell_moderation_party(
  p_org_id uuid,
  p_person_id uuid,
  p_kind text,
  p_opportunity_id uuid,
  p_project_id uuid,
  p_args jsonb
)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_email text;
begin
  if private.notify(p_org_id, p_person_id, p_kind, 'opportunities', p_opportunity_id, p_project_id, p_args) is not null then
    return 'Notification';
  end if;
  select lower(u.email) into v_email from app.people p join auth.users u on u.id = p.user_id where p.id = p_person_id;
  if v_email is null then
    return null;
  end if;
  insert into private.platform_emails (template, to_email, locale, args)
  values ('moderation_notice', v_email, private.person_language(p_person_id, null), jsonb_build_object('kind', p_kind, 'values', p_args));
  return 'Email';
end;
$$;
comment on function private.tell_moderation_party(uuid, uuid, text, uuid, uuid, jsonb) is 'Tells a person the outcome of a moderation decision or appeal (6168): through the notification queue, or, when it cannot reach them, by a platform email with the same words. Answers Notification, Email, or null when the person has no email left.';
revoke all on function private.tell_moderation_party(uuid, uuid, text, uuid, uuid, jsonb) from public, anon, authenticated;

-- Latest definition: 1590.
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
  -- The platform names itself as the actor (1590): the notice reports a platform decision, so it never names the
  -- operator who decided, and never the person whose session happens to be running the RPC.
  v_args := jsonb_build_object('title', v_opp.title, 'action', v_action.action, 'ground', v_action.ground,
    'ruleReference', v_action.rule_reference, 'statement', v_action.statement_of_reasons,
    'appealUntil', v_action.decided_at + interval '6 months', 'actorName', 'XOS');
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
  -- Each reporter whose report this decision decided: reported before it and after any earlier decision. A reporter
  -- outside the queue's reach is told by email (6168), because Acceptable Use Policy 7 promises the outcome.
  for v_person in
    select distinct r.reporter_person_id from app.listing_reports r
    where r.opportunity_id = v_opp.id and r.deleted_at is null and r.reported_at <= v_action.decided_at
      and not exists (select 1 from app.moderation_actions e
                      where e.opportunity_id = v_opp.id and e.id <> v_action.id and e.decided_at >= r.reported_at
                        and e.decided_at < v_action.decided_at)
  loop
    if private.tell_moderation_party(v_opp.org_id, v_person, 'listing_report.decided', v_opp.id, v_opp.project_id,
         jsonb_build_object('title', v_opp.title, 'action', v_action.action, 'statement', v_action.statement_of_reasons,
           'actorName', 'XOS')) is not null then
      v_count := v_count + 1;
    end if;
  end loop;
  return v_count;
end;
$$;
comment on function private.notify_moderation_decision(uuid) is 'Sends a moderation decision''s statement of reasons to the affected party, the org''s marketplace managers and the listing''s author (listing.moderated), and its outcome to each reporter whose report it decided (listing_report.decided), by email when the notification queue cannot reach them (private.tell_moderation_party, 6168). Returns how many were told. The notices name the platform as the actor, never the operator who decided (1590).';
revoke all on function private.notify_moderation_decision(uuid) from public, anon, authenticated;

-- Deciding an appeal --------------------------------------------------------------------------------------------------

drop function app.console_decide_appeal(uuid, app.moderation_appeal_state, text, app.moderation_action_kind, app.moderation_ground, text, text);

-- Latest definition: 1590.
create function app.console_decide_appeal(
  p_appeal_id uuid,
  p_outcome app.moderation_appeal_state,
  p_statement text,
  p_re_review_notes text,
  p_action app.moderation_action_kind default null,
  p_ground app.moderation_ground default null,
  p_rule_reference text default null,
  p_facts text default null,
  p_outside_reviewer_decided boolean default false
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
  v_outside private.legal_outside_reviewers;
  v_same boolean;
  v_reviewer text;
  v_new uuid;
  v_told text;
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
  if p_outcome is null or p_outcome = 'Open' then
    perform private.refuse('moderation_appeal_outcome', 'Uphold the decision or reverse it.');
  end if;
  -- While an outside reviewer is appointed the appeal is theirs; the operator records what they decided.
  select * into v_outside from private.legal_outside_reviewers o where o.ended_at is null;
  if v_outside.id is not null and not coalesce(p_outside_reviewer_decided, false) then
    perform private.refuse('moderation_appeal_outside_reviewer', 'This appeal goes to the outside reviewer. Record their decision once they have made it.');
  end if;
  if p_re_review_notes is null or char_length(btrim(p_re_review_notes)) not between 1 and 4000 then
    perform private.refuse('moderation_appeal_re_review', 'Record what you looked at again and how you weighed the grounds, in up to 4,000 characters.');
  end if;
  if p_statement is null or char_length(btrim(p_statement)) not between 1 and 4000 then
    perform private.refuse('moderation_statement', 'Write the reasons the appellant receives, in up to 4,000 characters.');
  end if;
  v_same := v_outside.id is null and v_action.decided_by is not distinct from v_operator;
  v_reviewer := case when v_outside.id is not null then 'outside' when v_same then 'same' else 'other' end;
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

  -- The appellant hears from the platform, not from the operator who decided (1590), and hears who re-reviewed it.
  v_told := private.tell_moderation_party(v_appeal.org_id, v_appeal.appellant_person_id, 'moderation_appeal.decided', v_opp.id,
    v_opp.project_id, jsonb_build_object('title', v_opp.title, 'outcome', p_outcome, 'statement', btrim(p_statement),
      'reviewer', v_reviewer, 'reviewerName', coalesce(v_outside.reviewer_name, ''), 'actorName', 'XOS'));
  insert into private.moderation_appeal_reviews (moderation_appeal_id, org_id, recorded_by, same_reviewer, outside_reviewer_id,
    re_review_notes, told_by, told_at)
  values (v_appeal.id, v_appeal.org_id, v_operator, v_same, v_outside.id, btrim(p_re_review_notes), v_told, case when v_told is not null then now() end);
  perform private.log_operator_action('moderation_appeal.decided', v_appeal.org_id, 'app.moderation_appeals', v_appeal.id,
    p_statement, jsonb_build_object('outcome', p_outcome, 'new_decision', v_new, 'reviewer', v_reviewer, 'told', v_told));
  -- The queue item closes with its appeal, not at the next sweep.
  perform private.follow_legal_queue_source(i.id, 'Completed') from app.legal_queue_items i
  where i.source_table = 'app.moderation_appeals' and i.source_id = v_appeal.id;
  return v_appeal.id;
end;
$$;

comment on function app.console_decide_appeal(uuid, app.moderation_appeal_state, text, text, app.moderation_action_kind, app.moderation_ground, text, text, boolean) is 'An operator (moderation.decide) records the outcome of a fresh, documented re-review of a moderation appeal (6168): what was looked at again, and the reasons sent to the appellant. The operator who made the first decision may re-review it, which the record and the notice both say. While an outside reviewer is appointed the appeal is theirs, and the operator records their decision. Reversing a removal or restriction restores the listing; reversing no action records the new decision given. The appellant is told the outcome and who re-reviewed it, by the platform rather than the operator (1590). Returns the appeal id.';
revoke all on function app.console_decide_appeal(uuid, app.moderation_appeal_state, text, text, app.moderation_action_kind, app.moderation_ground, text, text, boolean) from public, anon;
grant execute on function app.console_decide_appeal(uuid, app.moderation_appeal_state, text, text, app.moderation_action_kind, app.moderation_ground, text, text, boolean) to authenticated;

-- Latest definition: 1473.
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
    'outside_reviewer', (select jsonb_build_object('name', o.reviewer_name, 'organization', o.organization_name)
                         from private.legal_outside_reviewers o where o.ended_at is null),
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
                           'my_own_decision', m.decided_by is not distinct from v_operator,
                           're_review_notes', rv.re_review_notes, 'same_reviewer', rv.same_reviewer,
                           'outside_reviewer_name', orv.reviewer_name, 'told_by', rv.told_by,
                           'has_review', rv.moderation_appeal_id is not null)
                           order by a.filed_at desc)
                         from app.moderation_appeals a
                         join app.moderation_actions m on m.id = a.moderation_action_id
                         left join app.people ap on ap.id = a.appellant_person_id
                         left join app.people dp on dp.id = a.decided_by
                         left join private.moderation_appeal_reviews rv on rv.moderation_appeal_id = a.id
                         left join private.legal_outside_reviewers orv on orv.id = rv.outside_reviewer_id
                         where m.opportunity_id = v_opp.id and a.deleted_at is null), '[]'::jsonb));
end;
$$;

comment on function app.console_listing_detail(uuid) is 'One reported listing for the moderation queue (moderation.decide): the listing, its reports (open or decided), every decision with its statement of reasons in parts and who made it, its appeals with their documented re-review and whether the signed-in operator made the decision appealed, and any outside reviewer appeals go to (6168). Each view is logged.';
revoke all on function app.console_listing_detail(uuid) from public, anon;
grant execute on function app.console_listing_detail(uuid) to authenticated;

-- Notices already written read as they were: another operator decided each appeal then.
update app.notifications set message_args = message_args || '{"reviewer": "other", "reviewerName": ""}'::jsonb
where kind = 'moderation_appeal.decided' and not (message_args ? 'reviewer');

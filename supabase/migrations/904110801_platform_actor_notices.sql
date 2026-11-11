-- Platform decisions record no operator (crawl 4.9, RRR-243; release 4.11).
-- A platform decision reaches the tenant as the platform's, never as the operator who made it (notification-kinds.yaml,
-- ADR 0158, 1590, 6891). The emitters named the platform in actorName, but private.notify always stored the signed-in
-- person as actor_person_id, and app.console_decide_rating_dispute passed no actorName at all, so the disputant and every
-- rating answerer of the org could read the operator's name and person id through RLS.
--   1. private.notify (latest 1621): an emitter that passes actorPlatform true acts for the platform. The notification
--      records no actor person, actorName defaults to GHXSTSHIP, and the flag itself is not stored.
--   2. app.console_decide_rating_dispute (latest 6821) names GHXSTSHIP and acts for the platform.
--   3. The listing and content emitters that already name the platform pass actorPlatform too:
--      private.notify_moderation_decision and app.console_decide_appeal (latest 6863) and
--      app.console_decide_content_escalation (latest 6891).

-- 1. private.notify (latest 1621) -------------------------------------------------------------------------------------

create or replace function private.notify(
  p_org_id uuid,
  p_recipient_person_id uuid,
  p_kind text,
  p_subject_table text default null,
  p_subject_id uuid default null,
  p_project_id uuid default null,
  p_message_args jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_membership uuid;
  v_category text := (select distinct t.category_code from private.notification_templates t where t.kind = p_kind);
  -- The channels the kind reaches: a kind that names fewer than all of them in notification-kinds.yaml (1620) has no
  -- template row on the others, and a delivery there would never be claimed or would join an email digest.
  v_channels app.notification_channel[] := array(select t.channel from private.notification_templates t where t.kind = p_kind);
  v_urgent boolean;
  v_args jsonb := coalesce(p_message_args, '{}'::jsonb);
  v_bypass boolean;
  v_id uuid;
  v_created timestamptz;
  v_channel app.notification_channel;
  v_quiet timestamptz;
  v_opens timestamptz;
  v_digest timestamptz;
  v_delivery uuid;
  v_platform boolean := coalesce(p_message_args ->> 'actorPlatform', '') = 'true';
begin
  -- The copy of most kinds names who acted ({actorName}). An emitter that passes no actorName gets the signed-in
  -- person, or the org when a job acts. An emitter that names its actor knows who acted, and the signed-in person
  -- may be someone else (an approver whose decision moves a request to the next step), so an actor with no name
  -- yet reads as the org, never as whoever is signed in. An emitter that acts for the platform (actorPlatform, 904110801)
  -- names the platform: the operator who decided is never stored, by name or by id.
  v_args := v_args - 'actorPlatform';
  if v_platform and nullif(v_args ->> 'actorName', '') is null then
    v_args := v_args || jsonb_build_object('actorName', 'GHXSTSHIP');
  elsif not (v_args ? 'actorName') then
    v_args := v_args || jsonb_build_object('actorName', coalesce(
      (select p.full_name from app.people p where p.id = private.current_person_id()),
      (select o.name from app.organizations o where o.id = p_org_id), ''));
  elsif nullif(v_args ->> 'actorName', '') is null then
    v_args := v_args || jsonb_build_object('actorName', coalesce(
      (select o.name from app.organizations o where o.id = p_org_id), ''));
  end if;
  v_bypass := private.bypasses_quiet_hours(p_kind, v_args, now());
  v_opens := private.quiet_hours_bypass_opens(p_kind, v_args);
  select m.id into v_membership from app.memberships m
  where m.org_id = p_org_id and m.person_id = p_recipient_person_id and m.deleted_at is null
    and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now())
  order by m.valid_from desc limit 1;
  if v_membership is null and p_org_id not in (select private.party_org_ids(p_recipient_person_id))
     and not private.marketplace_notice_open(p_kind, p_subject_table, p_subject_id, p_recipient_person_id) then
    return null;
  end if;
  v_urgent := (select c.urgent from private.notification_categories c where c.code = v_category);
  insert into app.notifications (org_id, recipient_person_id, kind, actor_person_id, subject_table, subject_id, project_id, message_args,
    archived_at)
  values (p_org_id, p_recipient_person_id, p_kind, case when not v_platform then private.current_person_id() end, p_subject_table, p_subject_id, p_project_id,
    v_args,
    case when v_membership is not null and v_category is not null and not private.channel_enabled(v_membership, v_category, 'In App')
         then now() end)
  returning id, created_at into v_id, v_created;

  if v_membership is null then
    -- An external party or a marketplace user: their own Email and Push choices (1131). A push waits out their own quiet
    -- hours unless the kind bypasses them (A89); digests and SMS are membership settings.
    foreach v_channel in array array['Email', 'Push']::app.notification_channel[] loop
      if v_channel = any (v_channels) and private.person_channel_enabled(p_recipient_person_id, v_category, v_channel) then
        v_quiet := case when v_channel = 'Push' and not v_bypass then private.person_quiet_until(p_recipient_person_id, now()) end;
        -- A shift change waits only until its bypass window opens, as a member's does (1393, 1590).
        if v_quiet is not null and v_opens > now() and v_opens < v_quiet then
          v_quiet := v_opens;
        end if;
        insert into app.notification_deliveries (notification_id, notification_created_at, channel, message_status, deliver_after)
        values (v_id, v_created, v_channel, (case when v_quiet is not null then 'Deferred' else 'Queued' end)::app.message_status,
          coalesce(v_quiet, now()));
      end if;
    end loop;
    return v_id;
  end if;

  foreach v_channel in array array['Email', 'SMS', 'Push']::app.notification_channel[] loop
    if v_channel = any (v_channels) and private.channel_enabled(v_membership, v_category, v_channel) then
      v_quiet := case
        when v_bypass then null
        when v_channel = 'SMS' then private.sms_quiet_until(v_membership, p_project_id, now())
        when v_channel = 'Push' then private.local_quiet_until(v_membership, now()) end;
      -- A shift change waits only until its bypass window opens, when that comes before the quiet hours end (1393).
      if v_quiet is not null and v_opens > now() and v_opens < v_quiet then
        v_quiet := v_opens;
      end if;
      v_digest := case when v_channel = 'Email' and not v_urgent then private.next_digest_at(v_membership, now()) end;
      insert into app.notification_deliveries (notification_id, notification_created_at, channel, message_status, deliver_after)
      values (v_id, v_created, v_channel,
        (case when v_digest is not null then 'Digest' when v_quiet is not null then 'Deferred' else 'Queued' end)::app.message_status,
        coalesce(v_digest, v_quiet, now()))
      returning id into v_delivery;
      if v_digest is not null then
        insert into app.email_digest_queue (notification_delivery_id, notification_created_at, membership_id, due_at)
        values (v_delivery, v_created, v_membership, v_digest);
      elsif v_channel = 'SMS' and v_quiet is not null then
        perform private.hold_sms_for_summary(v_delivery, v_created, v_membership, v_quiet);
      end if;
    end if;
  end loop;
  return v_id;
end;
$$;
comment on function private.notify(uuid, uuid, text, text, uuid, uuid, jsonb) is 'Creates a notification and its outside deliveries. Its message arguments always carry actorName (1393): the emitter''s; when the emitter passes none, the signed-in person''s name, else the org''s when a job acts; when the emitter''s actor has no name yet, the org''s, never the signed-in person''s, who may not be the actor. An emitter that passes actorPlatform true acts for the platform (904110801): the notification records no actor person, actorName defaults to GHXSTSHIP, and the flag is not stored. Deliveries go only to the channels the kind reaches (its private.notification_templates rows, 1621). An active member gets one delivery per such channel they receive the category on (their preference, the org default and mandatory categories, 1362). During quiet hours a push waits (Deferred) and a text is held for the member''s summary (1367); only kinds on the bypass list go at once (ADR 0033 decision 35), and a kind with a bypass window waits no later than its opening (1393). Non-urgent email joins the digest when the member chose one. With In App off the notification is recorded already archived. An external party of the org (1131), or a person a marketplace match is about a listing open to (A89), gets the notification and an Email and a Push delivery as their own preferences and the kind''s channels allow; the push waits out their own quiet hours (app.person_notification_settings) unless the kind bypasses them, and no later than the opening of its bypass window (1590). Anyone else gets nothing (invariant 3). Returns the notification id, or null.';
revoke all on function private.notify(uuid, uuid, text, text, uuid, uuid, jsonb) from public, anon, authenticated;

-- 2. app.console_decide_rating_dispute (latest 6821) -----------------------------------------------------------------

create or replace function app.console_decide_rating_dispute(
  p_dispute_id uuid,
  p_outcome app.rating_dispute_state,
  p_ground app.rating_dispute_ground,
  p_statement text
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_operator uuid := private.require_platform_operator('moderation.decide');
  v_dispute app.rating_disputes;
  v_project uuid;
  v_args jsonb;
begin
  select * into v_dispute from app.rating_disputes d where d.id = p_dispute_id and d.deleted_at is null for update;
  if v_dispute.id is null then
    raise exception using errcode = '42501', message = 'dispute not found';
  end if;
  if v_dispute.disputant_person_id = v_operator then
    perform private.refuse('rating_dispute_own', 'Another operator decides this dispute: it is your own.');
  end if;
  if private.person_in_org(v_operator, v_dispute.org_id) then
    perform private.refuse('sod_rating_dispute_decide', 'Another operator decides this dispute: you belong to the organization that gave the rating.');
  end if;
  if p_outcome is null or p_outcome = 'Open' then
    perform private.refuse('rating_dispute_outcome', 'Uphold the dispute or do not.');
  end if;
  if p_outcome = 'Upheld' and (p_ground is null or p_ground = 'Other') then
    perform private.refuse('rating_dispute_decision_ground', 'Upholding needs a named ground: the wrong person, a false statement, abuse or personal data. A low score or an unfavorable opinion is not one.');
  end if;
  if p_statement is null or char_length(btrim(p_statement)) not between 1 and 4000 then
    perform private.refuse('rating_dispute_statement', 'Write the reasons the person and the organization receive, in up to 4,000 characters.');
  end if;
  perform private.transition_lifecycle('rating_dispute', 'app.rating_disputes', 'dispute_state', 'app.rating_dispute_state_transitions',
    'rating_dispute_id', v_dispute.id, v_dispute.dispute_state::text, p_outcome::text, 'Decided by a platform operator.');
  update app.rating_disputes
  set decision_ground = case when p_outcome = 'Upheld' then p_ground end,
      decision_statement = btrim(p_statement), decided_by = v_operator, decided_at = now()
  where id = v_dispute.id;
  select e.project_id into v_project from app.ratings r join app.engagements e on e.id = r.engagement_id where r.id = v_dispute.rating_id;
  -- The person and the org hear from the platform, never from the operator who decided (904110801).
  v_args := jsonb_build_object('outcome', p_outcome, 'statement', btrim(p_statement),
    'project', (select p.name from app.projects p where p.id = v_project), 'actorName', 'GHXSTSHIP', 'actorPlatform', true);
  perform private.notify(v_dispute.org_id, v_dispute.disputant_person_id, 'rating_dispute.decided', 'ratings', v_dispute.rating_id, v_project, v_args);
  perform private.notify(v_dispute.org_id, a, 'rating_dispute.decided', 'ratings', v_dispute.rating_id, v_project, v_args)
  from private.rating_answerer_ids(v_dispute.org_id) a;
  perform private.log_operator_action('rating_dispute.decided', v_dispute.org_id, 'app.rating_disputes', v_dispute.id, p_statement,
    jsonb_build_object('outcome', p_outcome, 'ground', p_ground));
end;
$$;
comment on function app.console_decide_rating_dispute(uuid, app.rating_dispute_state, app.rating_dispute_ground, text) is 'An operator (moderation.decide), never the disputant nor a member of the rating org (sod_rating_dispute_decide), decides a rating dispute with a statement of reasons (ADR 0158). Upheld removes the rating from every product read and needs a named ground; the score is never read. The person and the org are told, naming the platform, not the operator: the notices carry neither the operator''s name nor their person id (904110801).';
revoke all on function app.console_decide_rating_dispute(uuid, app.rating_dispute_state, app.rating_dispute_ground, text) from public, anon;
grant execute on function app.console_decide_rating_dispute(uuid, app.rating_dispute_state, app.rating_dispute_ground, text) to authenticated;

-- 3. private.notify_moderation_decision (latest 6863) ----------------------------------------------------------------

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
  v_report uuid;
  v_count integer := 0;
  v_args jsonb;
  v_channel text;
begin
  select * into v_action from app.moderation_actions m where m.id = p_action_id;
  select * into v_opp from app.opportunities o where o.id = v_action.opportunity_id;
  -- The platform names itself as the actor (1590): the notice reports a platform decision, so it never names the
  -- operator who decided, and never the person whose session happens to be running the RPC.
  v_args := jsonb_build_object('title', v_opp.title, 'action', v_action.action, 'ground', v_action.ground,
    'ruleReference', v_action.rule_reference, 'statement', v_action.statement_of_reasons,
    'appealUntil', v_action.decided_at + interval '6 months', 'actorName', 'XOS', 'actorPlatform', true);
  -- The affected party: the org's marketplace managers and the listing's author while still a member.
  for v_person in
    select distinct m.person_id from app.memberships m
    where m.org_id = v_opp.org_id and m.deleted_at is null and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now())
      and (m.person_id = v_opp.created_by
           or private.person_capability_reach(m.person_id, v_opp.org_id, 'opportunities.marketplace.manage', true) = 'organization')
  loop
    -- A restriction's statement of reasons is promised (Acceptable Use Policy 7, Digital Services Act Article 17), so it reaches
    -- them whatever their settings. Any other decision is a courtesy, and their settings stand.
    if v_action.action in ('Removed', 'Restricted') then
      select t.channel into v_channel from private.tell_moderation_party(v_opp.org_id, v_person, 'listing.moderated', v_opp.id, v_opp.project_id, v_args) t;
      if v_channel is not null then
        v_count := v_count + 1;
      end if;
    elsif private.notify(v_opp.org_id, v_person, 'listing.moderated', 'opportunities', v_opp.id, v_opp.project_id, v_args) is not null then
      v_count := v_count + 1;
    end if;
  end loop;
  -- Nobody in the org could be reached: no member is left who manages the marketplace, or none has an email. An operator has to
  -- find someone, and the statement of reasons shows on the item, read live.
  if v_count = 0 and v_action.action in ('Removed', 'Restricted') then
    perform private.open_legal_queue_item('undelivered_notice', 'Moderation notice', v_action.decided_at, p_org_id => v_opp.org_id,
      p_source_table => 'listing.moderated', p_source_id => v_action.id);
  end if;
  -- Each reporter whose report this decision decided: reported before it and after any earlier decision. A reporter
  -- outside the queue's reach is told by email (6863), because Acceptable Use Policy 7 promises the outcome.
  for v_person, v_report in
    select distinct on (r.reporter_person_id) r.reporter_person_id, r.id from app.listing_reports r
    where r.opportunity_id = v_opp.id and r.deleted_at is null and r.reported_at <= v_action.decided_at
      and not exists (select 1 from app.moderation_actions e
                      where e.opportunity_id = v_opp.id and e.id <> v_action.id and e.decided_at >= r.reported_at
                        and e.decided_at < v_action.decided_at)
    order by r.reporter_person_id, r.reported_at
  loop
    select t.channel into v_channel from private.tell_moderation_party(v_opp.org_id, v_person, 'listing_report.decided', v_opp.id, v_opp.project_id,
      jsonb_build_object('title', v_opp.title, 'action', v_action.action, 'statement', v_action.statement_of_reasons, 'actorName', 'XOS',
        'actorPlatform', true)) t;
    if v_channel is not null then
      v_count := v_count + 1;
    else
      -- No email left, which most often means they deleted their account. It stays on record that they were not told.
      perform private.open_legal_queue_item('undelivered_notice', 'Moderation notice', v_action.decided_at, p_org_id => v_opp.org_id,
        p_source_table => 'listing_report.decided', p_source_id => v_report);
    end if;
  end loop;
  return v_count;
end;
$$;
comment on function private.notify_moderation_decision(uuid) is 'Sends a moderation decision''s statement of reasons to the affected party, the org''s marketplace managers and the listing''s author (listing.moderated), and its outcome to each reporter whose report it decided (listing_report.decided). A removal, a restriction and a report''s outcome go by email when the notification queue cannot reach them (private.tell_moderation_party, 6863), and open a legal queue item when that cannot reach anyone either. Returns how many were reached or had an email queued. The notices name the platform as the actor, never the operator who decided (1590), and record no actor person (904110801).';
revoke all on function private.notify_moderation_decision(uuid) from public, anon, authenticated;

-- 4. app.console_decide_appeal (latest 6863) -------------------------------------------------------------------------

create or replace function app.console_decide_appeal(
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
  v_channel text;
  v_email uuid;
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
  select t.channel, t.email_id into v_channel, v_email
  from private.tell_moderation_party(v_appeal.org_id, v_appeal.appellant_person_id, 'moderation_appeal.decided', v_opp.id,
    v_opp.project_id, jsonb_build_object('title', v_opp.title, 'outcome', p_outcome, 'statement', btrim(p_statement),
      'reviewer', v_reviewer, 'reviewerName', coalesce(v_outside.reviewer_name, ''), 'actorName', 'XOS', 'actorPlatform', true)) t;
  -- Told now only through the notification queue. An email counts once the provider has taken it (6860's feed stamps it).
  insert into private.moderation_appeal_reviews (moderation_appeal_id, org_id, recorded_by, same_reviewer, outside_reviewer_id,
    re_review_notes, told_by, notice_email_id, told_at)
  values (v_appeal.id, v_appeal.org_id, v_operator, v_same, v_outside.id, btrim(p_re_review_notes), v_channel, v_email,
    case when v_channel = 'Notification' then now() end);
  perform private.log_operator_action('moderation_appeal.decided', v_appeal.org_id, 'app.moderation_appeals', v_appeal.id,
    p_statement, jsonb_build_object('outcome', p_outcome, 'new_decision', v_new, 'reviewer', v_reviewer, 'notice_channel', v_channel));
  -- The queue item closes with its appeal, not at the next sweep.
  perform private.follow_legal_queue_source(i.id, 'Completed') from app.legal_queue_items i
  where i.source_table = 'app.moderation_appeals' and i.source_id = v_appeal.id;
  return v_appeal.id;
end;
$$;
comment on function app.console_decide_appeal(uuid, app.moderation_appeal_state, text, text, app.moderation_action_kind, app.moderation_ground, text, text, boolean) is 'An operator (moderation.decide) records the outcome of a fresh, documented re-review of a moderation appeal (6863): what was looked at again, and the reasons sent to the appellant. The operator who made the first decision may re-review it, which the record and the notice both say. While an outside reviewer is appointed the appeal is theirs, and the operator records their decision. Reversing a removal or restriction restores the listing; reversing no action records the new decision given. The appellant is told the outcome and who re-reviewed it, by the platform rather than the operator (1590), with no actor person recorded (904110801); the record counts them told only when that has actually happened. Returns the appeal id.';
revoke all on function app.console_decide_appeal(uuid, app.moderation_appeal_state, text, text, app.moderation_action_kind, app.moderation_ground, text, text, boolean) from public, anon;
grant execute on function app.console_decide_appeal(uuid, app.moderation_appeal_state, text, text, app.moderation_action_kind, app.moderation_ground, text, text, boolean) to authenticated;

-- 5. app.console_decide_content_escalation (latest 6891) -------------------------------------------------------------

create or replace function app.console_decide_content_escalation(
  p_subject_id uuid,
  p_action app.content_moderation_action,
  p_ground app.moderation_ground,
  p_rule_reference text,
  p_facts text,
  p_statement text
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_operator uuid := private.require_platform_operator('moderation.decide');
  v_org uuid;
  v_kind app.content_subject_kind;
  v_item record;
  v_id uuid;
  v_reporter uuid;
  v_conversation uuid;
begin
  select e.org_id, e.subject_kind into v_org, v_kind from private.require_escalated_content(p_subject_id) e;
  select * into v_item from private.reported_content(v_kind, p_subject_id);
  if v_item.author_person_id = v_operator then
    perform private.refuse('content_moderation_own', 'Another moderator decides reports about your own post, comment or message.');
  end if;
  if not exists (select 1 from app.content_reports r where r.org_id = v_org and r.deleted_at is null
                   and r.content_moderation_decision_id is null
                   and coalesce(r.feed_post_id, r.comment_id, r.chat_message_id) = p_subject_id) then
    perform private.refuse('content_moderation_nothing_open', 'Every report about this was already decided.');
  end if;

  insert into app.content_moderation_decisions (org_id, subject_kind, feed_post_id, comment_id, chat_message_id,
    author_person_id, action, ground, rule_reference, facts, statement_of_reasons, decided_by, decided_by_platform)
  values (v_org, v_kind,
    case when v_kind = 'Feed Post' then p_subject_id end,
    case when v_kind = 'Comment' then p_subject_id end,
    case when v_kind = 'Chat Message' then p_subject_id end,
    v_item.author_person_id, p_action, p_ground, btrim(p_rule_reference), btrim(p_facts), btrim(p_statement), v_operator,
    true)
  returning id into v_id;

  if p_action = 'Removed' and not v_item.removed then
    if v_kind = 'Feed Post' then
      update app.feed_posts set hidden_at = now(), hidden_reason = btrim(left(btrim(p_statement), 500)), pinned_at = null
      where id = p_subject_id;
      perform private.emit_event(v_org, 'feed_post.hidden', 'feed_posts', p_subject_id, v_item.project_id,
        jsonb_build_object('reason', btrim(left(btrim(p_statement), 500)), 'content_moderation_decision_id', v_id));
    elsif v_kind = 'Comment' then
      update app.comments set deleted_at = now() where id = p_subject_id;
    else
      update app.chat_messages set deleted_at = now() where id = p_subject_id
      returning conversation_id into v_conversation;
      perform private.emit_event(v_org, 'chat_message.deleted', 'chat_messages', p_subject_id, null,
        jsonb_build_object('conversation_id', v_conversation, 'content_moderation_decision_id', v_id));
    end if;
  end if;

  update app.content_reports set content_moderation_decision_id = v_id
  where org_id = v_org and deleted_at is null and content_moderation_decision_id is null
    and coalesce(feed_post_id, comment_id, chat_message_id) = p_subject_id;
  perform private.emit_event(v_org, 'content.moderated', 'content_moderation_decisions', v_id, v_item.project_id,
    jsonb_build_object('subject_kind', v_kind, 'action', p_action, 'ground', p_ground, 'decided_by_platform', true));

  -- The notices name GHXSTSHIP, as an org's decision names the org, never the operator.
  for v_reporter in
    select distinct r.reporter_person_id from app.content_reports r where r.content_moderation_decision_id = v_id
  loop
    perform private.notify(v_org, v_reporter, 'content_report.decided', 'app.content_moderation_decisions', v_id,
      v_item.project_id, jsonb_build_object('subject', private.content_subject_word(v_kind), 'action', p_action,
        'statement', btrim(p_statement), 'actorName', 'GHXSTSHIP', 'actorPlatform', true));
  end loop;
  if p_action = 'Removed' and v_item.author_person_id is not null then
    perform private.notify(v_org, v_item.author_person_id, 'content.removed', 'app.content_moderation_decisions', v_id,
      v_item.project_id, jsonb_build_object('subject', private.content_subject_word(v_kind), 'ground', p_ground,
        'ruleReference', btrim(p_rule_reference), 'statement', btrim(p_statement), 'actorName', 'GHXSTSHIP', 'actorPlatform', true));
  end if;
  perform private.log_operator_action('content_report.decided', v_org, 'app.content_moderation_decisions', v_id,
    btrim(p_statement), jsonb_build_object('subject_kind', v_kind, 'subject_id', p_subject_id, 'action', p_action,
      'ground', p_ground));
  return v_id;
end;
$$;
comment on function app.console_decide_content_escalation(uuid, app.content_moderation_action, app.moderation_ground, text, text, text) is 'Operator console (moderation.decide): GHXSTSHIP decides an item (a post, comment or message, by id) whose reports were escalated to it (6891) with a statement of reasons in parts, as an org moderator does with app.decide_content_report: Removed hides a post, deletes a comment or deletes a message; No Action leaves it. Decides every open report on the item, records decided_by_platform, tells each reporter the outcome (content_report.decided) and, on removal, sends the author the statement (content.removed), both naming GHXSTSHIP with no actor person recorded (904110801); logs content_report.decided in the console ledger. Refuses an item with no open report. Returns the decision id.';
revoke all on function app.console_decide_content_escalation(uuid, app.content_moderation_action, app.moderation_ground, text, text, text) from public, anon;
grant execute on function app.console_decide_content_escalation(uuid, app.content_moderation_action, app.moderation_ground, text, text, text) to authenticated, service_role;

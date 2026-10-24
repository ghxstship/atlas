-- pgTAP: migration 1473, the moderation queue and notice and action from the operator console (A90, RRR-135,
-- finding A65-009; Section 4.4.3, Section 14.9, EU Digital Services Act articles 16, 17 and 20). Trust and Safety
-- reads the queue and decides a reported listing with a statement of reasons in parts; the affected party and the
-- reporters are notified; the affected party or the reporter appeals within six months; another operator decides
-- the appeal, and a reversal records the new decision.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

select plan(38);

create function pg_temp.as_op(p_key text) returns void
language plpgsql as $$
begin
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', pg_temp.id(p_key || '_user'), 'role', 'authenticated', 'aal', 'aal2')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;

-- A published Public Crew listing of Northwind on prj_a, written by carol (marketplace manager).
create function pg_temp.public_listing(p_key text, p_title text) returns void
language plpgsql as $$
declare v uuid;
begin
  perform pg_temp.as_user('carol');
  insert into app.opportunities (project_id, role_type, role_code, title, visibility, rate_type, pay_min_minor, pay_max_minor,
    currency_code, deadline_at, starts_on, ends_on, requisition_id)
  values (pg_temp.id('prj_a'), 'Crew', '5000.51.02', p_title, 'Public', 'Day', 70000, 90000, 'USD', now() + interval '7 days',
    '2027-06-01', '2027-06-03', pg_temp.id('requisition_a'))
  returning id into v;
  insert into world values (p_key, v);
  perform app.transition_opportunity(v, 'Draft', 'Pending Approval', 'Ready for approval.');
  perform app.transition_opportunity(v, 'Pending Approval', 'Published', 'Approved.');
  perform pg_temp.as_platform();
end $$;

select pg_temp.new_user('olga', 'olga@platform.test', 'Olga Brandt');
select pg_temp.new_user('omar', 'omar@platform.test', 'Omar Haddad');
select pg_temp.new_user('tess', 'tess@platform.test', 'Tess Morales');
select pg_temp.as_platform();
select private.grant_platform_operator('olga@platform.test', 'Administrator', 'First platform administrator.');
select private.grant_platform_operator('omar@platform.test', 'Support', 'Support on call.');
select private.grant_platform_operator('tess@platform.test', 'Trust and Safety', 'Moderation.');

-- Northwind lists itself publicly (gateway.marketplace_visibility, 1327).
select pg_temp.as_user('alice');
select app.set_setting(pg_temp.id('org_a'), 'gateway.marketplace_visibility', 'Organization', pg_temp.id('org_a'), p_value_text => 'public');
select pg_temp.public_listing('opp_one', 'Summer Series Riggers');
select pg_temp.as_user('ivy');
insert into app.listing_reports (opportunity_id, reason, details) values (pg_temp.id('opp_one'), 'Misleading Information', 'The dates are wrong.');
select pg_temp.as_user('quinn');
insert into app.listing_reports (opportunity_id, reason, details) values (pg_temp.id('opp_one'), 'Fraud', 'Asks for a fee to apply.');

-- The queue ----------------------------------------------------------------------------------------------------------------
select pg_temp.as_op('omar');
select throws_ok($$select * from app.console_moderation_queue()$$, '42501', null, 'Support holds no moderation');
select pg_temp.as_op('tess');
select is((select open_reports::int from app.console_moderation_queue() where opportunity_id = pg_temp.id('opp_one')), 2,
  'Trust and Safety sees the listing with both open reports');
select is((select reasons::text from app.console_moderation_queue() where opportunity_id = pg_temp.id('opp_one')),
  '{Fraud,"Misleading Information"}', 'and their grounds, in the order of the reasons list');
select is((select jsonb_array_length(app.console_listing_detail(pg_temp.id('opp_one')) -> 'reports')), 2, 'the detail lists the reports');
select ok((select count(*) = 1 from app.platform_operator_actions where action = 'listing.viewed'), 'and each view is logged');

-- Deciding: the statement of reasons in parts --------------------------------------------------------------------------------
select throws_ok(format($$select app.console_decide_listing(%L, 'Removed', 'No Violation', 'Acceptable Use Policy 3.2', 'Facts.', 'Statement.')$$,
  pg_temp.id('opp_one')), 'XR001', null, 'a removal needs a ground of illegal content or a breach of the terms');
select throws_ok(format($$select app.console_decide_listing(%L, 'Removed', 'Terms Violation', 'Acceptable Use Policy 3.2', '', 'Statement.')$$,
  pg_temp.id('opp_one')), 'XR001', null, 'and the facts');
select throws_ok(format($$select app.console_decide_listing(%L, 'Restored', 'No Violation', 'Terms 7.6', 'Facts.', 'Statement.')$$,
  pg_temp.id('opp_one')), 'XR001', 'moderation_not_removed: Only a removed or restricted listing can be restored.',
  'only a removed listing is restored');
select lives_ok(format($$insert into world select 'decision_one', app.console_decide_listing(%L, 'Removed', 'Terms Violation',
  'Acceptable Use Policy 3.2 (fees from applicants)', 'The listing asks applicants to pay a registration fee before applying.',
  'We removed this listing because it asks applicants to pay to apply, which the Acceptable Use Policy forbids. You may appeal within six months.')$$,
  pg_temp.id('opp_one')), 'Trust and Safety removes the listing with a statement of reasons');
select pg_temp.as_platform();
select is((select decided_by = pg_temp.id('tess') and not automated_detection and not automated_decision and ground = 'Terms Violation'
  from app.moderation_actions where id = pg_temp.id('decision_one')), true, 'the decision names its operator and no automated means');
select ok(private.opportunity_removed(pg_temp.id('opp_one')), 'the listing is removed from the marketplace');
select pg_temp.as_op('tess');
select is((select count(*)::int from app.console_moderation_queue() where opportunity_id = pg_temp.id('opp_one')), 0,
  'the decision decides both reports, so the listing leaves the open queue');
select is((select last_decision::text from app.console_moderation_queue(false) where opportunity_id = pg_temp.id('opp_one')), 'Removed',
  'and shows among the decided');

-- Notice -------------------------------------------------------------------------------------------------------------------
select pg_temp.as_platform();
select ok((select message_args ->> 'statement' like 'We removed this listing%' from app.notifications
  where recipient_person_id = pg_temp.id('carol') and kind = 'listing.moderated'), 'the listing''s author receives the statement of reasons');
select is((select count(*)::int from app.notifications where recipient_person_id = pg_temp.id('alice') and kind = 'listing.moderated'), 1,
  'and so does each marketplace manager');
select is((select count(*)::int from app.notifications where recipient_person_id = pg_temp.id('dave') and kind = 'listing.moderated'), 0,
  'a Member who manages no listings does not');
select is((select count(*)::int from app.notifications where recipient_person_id = pg_temp.id('ivy') and kind = 'listing_report.decided'), 1,
  'a reporter the org works with is told the outcome');
select is((select string_agg(distinct n.message_args ->> 'actorName', ', ') from app.notifications n
           where n.subject_id = pg_temp.id('opp_one') and n.kind in ('listing.moderated', 'listing_report.decided')), 'XOS',
  'the notices name the platform as their actor, never the operator who decided (1590)');
select is((select count(*)::int from app.domain_events where event_type = 'listing.moderated' and subject_id = pg_temp.id('decision_one')), 1,
  'and listing.moderated is emitted');
select is((select count(*)::int from app.platform_operator_actions where action = 'listing.moderated'
  and operator_person_id = pg_temp.id('tess')), 1, 'the decision lands in the console ledger');

-- Appeals by the affected party ---------------------------------------------------------------------------------------------
select pg_temp.as_user('dave');
select throws_ok(format($$select app.file_moderation_appeal(%L, 'Wrong.')$$, pg_temp.id('decision_one')), '42501', null,
  'a Member who cannot write postings cannot appeal for the org');
select pg_temp.as_user('quinn');
select throws_ok(format($$select app.file_moderation_appeal(%L, 'Wrong.')$$, pg_temp.id('decision_one')), '42501', null,
  'a reporter cannot appeal a removal');
select pg_temp.as_user('carol');
select lives_ok(format($$insert into world select 'appeal_one', app.file_moderation_appeal(%L, %L)$$, pg_temp.id('decision_one'),
  'The fee is the union''s card check, which the law requires; we never collect it. See the attached rule.'),
  'the author appeals the removal');
select throws_ok(format($$select app.file_moderation_appeal(%L, 'Again.')$$, pg_temp.id('decision_one')), 'XR001',
  'moderation_appeal_exists: This decision has already been appealed.', 'once');
select pg_temp.as_op('tess');
select is((select (app.console_listing_detail(pg_temp.id('opp_one')) #>> '{appeals,0,decidable_by_me}')::boolean), false,
  'the operator who decided sees they may not decide the appeal');
select throws_ok(format($$select app.console_decide_appeal(%L, 'Reversed', 'Changed my mind.')$$, pg_temp.id('appeal_one')), 'XR001',
  'moderation_appeal_same_operator: Another operator decides this appeal: you made the decision it appeals.',
  'and the database refuses it');
select pg_temp.as_op('olga');
select lives_ok(format($$select app.console_decide_appeal(%L, 'Reversed', %L)$$, pg_temp.id('appeal_one'),
  'The fee is a statutory card check the org does not collect, so the listing breaks no rule. We restored it.'),
  'another operator reverses it');
select pg_temp.as_platform();
select ok(not private.opportunity_removed(pg_temp.id('opp_one')), 'and the listing is restored');
select is((select action::text || ' ' || ground::text from app.moderation_actions where moderation_appeal_id = pg_temp.id('appeal_one')),
  'Restored No Violation', 'by a new decision linked to the appeal');
select is((select count(*)::int from app.notifications where recipient_person_id = pg_temp.id('carol') and kind = 'moderation_appeal.decided'), 1,
  'the appellant is told the outcome');
select is((select string_agg(distinct n.message_args ->> 'actorName', ', ') from app.notifications n
           where n.subject_id = pg_temp.id('opp_one') and n.kind in ('moderation_appeal.decided', 'listing.moderated')), 'XOS',
  'so do the outcome and the notice of the restoration, from the operator who decided the appeal (1590)');
select pg_temp.as_user('carol');
select is((select appeal_state::text from app.moderation_appeals where id = pg_temp.id('appeal_one')), 'Reversed', 'and reads it');

-- Appeals by the reporter ------------------------------------------------------------------------------------------------------
select pg_temp.public_listing('opp_two', 'Summer Series Ushers');
select pg_temp.as_user('ivy');
insert into app.listing_reports (opportunity_id, reason, details) values (pg_temp.id('opp_two'), 'Discrimination', 'Asks for age and gender.');
select pg_temp.as_op('tess');
select lives_ok(format($$insert into world select 'decision_two', app.console_decide_listing(%L, 'No Action', 'No Violation', 'Terms 7.6',
  'The questions are optional equal opportunity questions kept apart from the application.', 'We found no violation.')$$, pg_temp.id('opp_two')),
  'Trust and Safety takes no action');
select pg_temp.as_user('ivy');
select lives_ok(format($$insert into world select 'appeal_two', app.file_moderation_appeal(%L, 'The questions are not optional.')$$,
  pg_temp.id('decision_two')), 'the reporter appeals a decision to take no action');
select pg_temp.as_op('olga');
select throws_ok(format($$select app.console_decide_appeal(%L, 'Reversed', 'The questions are required.')$$, pg_temp.id('appeal_two')),
  'XR001', null, 'reversing no action needs the new decision');
select lives_ok(format($$select app.console_decide_appeal(%L, 'Reversed', 'The questions are required, which the policy forbids.',
  'Removed', 'Illegal Content', 'Equal opportunity law', 'Age and gender are required to apply.')$$, pg_temp.id('appeal_two')),
  'and with it the listing is removed');
select pg_temp.as_platform();
select ok(private.opportunity_removed(pg_temp.id('opp_two')), 'so the reversal took effect');

-- Six months ------------------------------------------------------------------------------------------------------------------
insert into app.moderation_actions (opportunity_id, action, statement_of_reasons, decided_at)
values (pg_temp.id('opp_two'), 'Restricted', 'An old decision.', now() - interval '7 months');
insert into world select 'decision_old', id from app.moderation_actions where statement_of_reasons = 'An old decision.';
select pg_temp.as_user('carol');
select throws_ok(format($$select app.file_moderation_appeal(%L, 'Late.')$$, pg_temp.id('decision_old')), 'XR001',
  'moderation_appeal_window: Appeals are accepted for six months after a decision; this one is older.', 'appeals close after six months');

select * from finish();
rollback;

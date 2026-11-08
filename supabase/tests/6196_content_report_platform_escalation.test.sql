-- pgTAP: migration 6196, reports an org leaves undecided go to GHXSTSHIP (App Store Review Guideline 1.2, Google Play's
-- user-generated content policy). A report still open past its 24 hours reaches the operator console once, with a row
-- in the org's audit ledger; Trust and Safety lists it without its text, opens it (logged in the console ledger) without
-- who reported, and decides it with a statement of reasons in parts. Removal deletes the message; the reporter and the
-- author hear the outcome naming GHXSTSHIP; the org's moderators read the decision as GHXSTSHIP's. Reports decided in
-- time never reach the console, Support holds no access, and the org can still decide an escalated item itself.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(36);

create temporary table k (key text primary key, id uuid);
grant select, insert on k to public;

create function pg_temp.as_op(p_key text) returns void
language plpgsql as $$
begin
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', pg_temp.id(p_key || '_user'), 'role', 'authenticated', 'aal', 'aal2')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;

select pg_temp.new_user('omar', 'omar@platform.test', 'Omar Haddad');
select pg_temp.new_user('tess', 'tess@platform.test', 'Tess Morales');
select pg_temp.as_platform();
select private.grant_platform_operator('omar@platform.test', 'Support', 'Support on call.');
select private.grant_platform_operator('tess@platform.test', 'Trust and Safety', 'Moderation.');

select has_column('app', 'content_reports', 'platform_escalated_at', 'a report records when it reached GHXSTSHIP');
select has_column('app', 'content_moderation_decisions', 'decided_by_platform', 'a decision records whether GHXSTSHIP made it');
select ok(exists (select 1 from cron.job where jobname = 'xos_escalate_content_reports_to_platform'),
  'an hourly job sends overdue reports to GHXSTSHIP');

-- A threat in a direct message, reported by Dave; and a post, reported and decided in time.
select pg_temp.as_user('frank');
insert into k select 'dm', app.start_direct_conversation(pg_temp.id('org_a'), pg_temp.id('dave@org_a'));
insert into k select 'msg', app.send_chat_message((select id from k where key = 'dm'), 'Send me your home address or else.');
select pg_temp.as_user('dave');
insert into k select 'r1', app.report_content('Chat Message', (select id from k where key = 'msg'), 'Violence', 'He keeps asking.');
select pg_temp.as_user('carol');
insert into k select 'post', app.create_feed_post(pg_temp.id('org_a'), 'Update', 'Anyone late is useless.');
select pg_temp.as_user('dave');
insert into k select 'r2', app.report_content('Feed Post', (select id from k where key = 'post'), 'Harassment');
select pg_temp.as_user('bob');
select app.decide_content_report(pg_temp.id('org_a'), 'Feed Post', (select id from k where key = 'post'),
  'No Action', 'No Violation', 'Acceptable Use Policy 1', 'Blunt, not abusive.', 'We left the post up.');

-- Not yet due ---------------------------------------------------------------------------------------------------------------
select pg_temp.as_platform();
select is(private.escalate_content_reports_to_platform(), 0, 'a report inside its 24 hours stays with the org');
select pg_temp.as_op('tess');
select is((select count(*)::int from app.console_content_escalations()), 0, 'and the console lists nothing');
select throws_ok($$select app.console_content_escalation_detail((select id from k where key = 'post'))$$,
  '42501', null, 'nor opens a report the org decided in time');

-- Past its due time --------------------------------------------------------------------------------------------------------
select pg_temp.as_platform();
update app.content_reports set due_at = now() - interval '1 minute' where id in (select id from k where key in ('r1', 'r2'));
select is(private.escalate_content_reports_to_platform(), 1, 'the hourly job sends the one undecided item to GHXSTSHIP');
select is(private.escalate_content_reports_to_platform(), 0, 'once');
select ok((select platform_escalated_at is not null from app.content_reports where id = (select id from k where key = 'r1')),
  'the report records when it went');
select ok((select platform_escalated_at is null from app.content_reports where id = (select id from k where key = 'r2')),
  'a decided report never goes');
select is((select count(*)::int from app.audit_events where org_id = pg_temp.id('org_a') and action = 'content_report.escalated'
           and subject_id = (select id from k where key = 'r1') and actor_kind = 'System'), 1,
  'the org''s audit ledger records the escalation');
select is((select diff ->> 'subject_kind' from app.audit_events where action = 'content_report.escalated'), 'Chat Message',
  'naming what was escalated');
select ok((select diff::text not like '%home address%' from app.audit_events where action = 'content_report.escalated'),
  'without copying its text');

-- The console ---------------------------------------------------------------------------------------------------------------
select pg_temp.as_op('omar');
select throws_ok($$select * from app.console_content_escalations()$$, '42501', null, 'Support holds no moderation');
select pg_temp.as_op('tess');
select is((select open_reports::int from app.console_content_escalations() where subject_id = (select id from k where key = 'msg')), 1,
  'Trust and Safety lists the item with its open report');
select is((select org_name from app.console_content_escalations()), 'Northwind Live', 'and its org');
select is((select reasons::text from app.console_content_escalations()), '{Violence}', 'and why it was reported');
select is((app.console_content_escalation_detail((select id from k where key = 'msg')) -> 'subject' ->> 'body'),
  'Send me your home address or else.', 'the detail shows the message');
select is((app.console_content_escalation_detail((select id from k where key = 'msg')) -> 'reports' -> 0 ->> 'details'),
  'He keeps asking.', 'and the report');
select ok(not ((app.console_content_escalation_detail((select id from k where key = 'msg')) -> 'reports' -> 0) ? 'reporter_name'),
  'but never who reported');
select ok((select count(*) >= 1 from app.platform_operator_actions where action = 'content_report.viewed'
           and target_org_id = pg_temp.id('org_a')), 'each view is logged in the console ledger');

-- Deciding ------------------------------------------------------------------------------------------------------------------
select throws_ok($$select app.console_decide_content_escalation((select id from k where key = 'msg'),
  'Removed', 'No Violation', 'Acceptable Use Policy 1', 'A threat.', 'We removed the message.')$$,
  '23514', null, 'a removal needs a violation as its ground');
select lives_ok($$insert into k select 'd1', app.console_decide_content_escalation((select id from k where key = 'msg'),
  'Removed', 'Terms Violation', 'Acceptable Use Policy 1', 'The message threatens a crew member.',
  'We removed the message because it threatens a crew member.')$$, 'Trust and Safety removes the message');
select throws_ok($$select app.console_decide_content_escalation((select id from k where key = 'msg'),
  'No Action', 'No Violation', 'Acceptable Use Policy 1', 'Again.', 'Again.')$$,
  'XR001', 'content_moderation_nothing_open: Every report about this was already decided.', 'once');
select is((select count(*)::int from app.console_content_escalations()), 0, 'the open list is empty');
select is((select last_action::text from app.console_content_escalations(false)), 'Removed', 'and the decided list shows the removal');
select ok((select count(*) = 1 from app.platform_operator_actions where action = 'content_report.decided'
           and subject_id = (select id from k where key = 'd1')), 'the decision is logged in the console ledger');

select pg_temp.as_platform();
select ok((select deleted_at is not null from app.chat_messages where id = (select id from k where key = 'msg')),
  'removal deletes the message');
select ok((select decided_by_platform and decided_by = pg_temp.id('tess') from app.content_moderation_decisions
           where id = (select id from k where key = 'd1')), 'the decision is GHXSTSHIP''s and records the operator');
select is((select message_args ->> 'actorName' from app.notifications where kind = 'content_report.decided'
           and recipient_person_id = pg_temp.id('dave') and subject_id = (select id from k where key = 'd1')),
  'GHXSTSHIP', 'the reporter hears the outcome from GHXSTSHIP');
select is((select message_args ->> 'actorName' from app.notifications where kind = 'content.removed'
           and recipient_person_id = pg_temp.id('frank') and subject_id = (select id from k where key = 'd1')),
  'GHXSTSHIP', 'and the author receives the statement from GHXSTSHIP');
select is((select count(*)::int from app.audit_events where org_id = pg_temp.id('org_a')
           and subject_table = 'app.content_moderation_decisions' and subject_id = (select id from k where key = 'd1')), 1,
  'the org''s audit ledger records the decision');

select pg_temp.as_user('bob');
select is((app.content_report_detail(pg_temp.id('org_a'), 'Chat Message', (select id from k where key = 'msg')) -> 'decisions' -> 0 ->> 'decided_by_name'),
  'GHXSTSHIP', 'the org''s moderators read the decision as GHXSTSHIP''s, not the operator''s');

-- The org can still decide an escalated item ------------------------------------------------------------------------------
select pg_temp.as_user('frank');
insert into k select 'msg2', app.send_chat_message((select id from k where key = 'dm'), 'Last warning.');
select pg_temp.as_user('dave');
insert into k select 'r3', app.report_content('Chat Message', (select id from k where key = 'msg2'), 'Harassment');
select pg_temp.as_platform();
update app.content_reports set due_at = now() - interval '1 minute' where id = (select id from k where key = 'r3');
select is(private.escalate_content_reports_to_platform(), 1, 'a second overdue item goes to GHXSTSHIP');
select pg_temp.as_user('bob');
select app.decide_content_report(pg_temp.id('org_a'), 'Chat Message', (select id from k where key = 'msg2'),
  'Removed', 'Terms Violation', 'Acceptable Use Policy 1', 'Harassment.', 'We removed the message.');
select pg_temp.as_op('tess');
select is((select count(*)::int from app.console_content_escalations()), 0, 'once the org decides it, it leaves the open list');
select is((select decided_by_platform from app.console_content_escalations(false) where subject_id = (select id from k where key = 'msg2')),
  false, 'and the decided list shows the org decided it');

select * from finish();
rollback;

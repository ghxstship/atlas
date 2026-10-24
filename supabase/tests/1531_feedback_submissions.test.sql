-- pgTAP: feedback to the platform team (A96, RRR-141, A65-022, Section 11.7). Anyone signed in sends feedback with the
-- page context the widget showed and, if they chose, their own screenshot; they read only their own; platform staff,
-- granted by the service role, read and triage every one and open a screenshot only once its scan found it Clean.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0200_identity_world.psql

select plan(24);

select has_table('app', 'feedback_submissions', 'feedback lives in app.feedback_submissions');
select is((select relrowsecurity from pg_class where oid = 'app.feedback_submissions'::regclass), true, 'row level security is on');
select ok(exists (select 1 from private.retention_policies r where r.table_name = 'app.feedback_submissions'
  and r.retention = interval '2 years'), 'feedback is kept two years');

-- nina has no org; alice works in Northwind.
select pg_temp.as_user('nina');
select matches(app.send_feedback('Gateway', 'The pay tracker is hard to find.', '/money', null, '4.0.0', 'en-US', '390x844'),
  '^FB-[0-9]{6}$', 'a person with no org sends feedback and gets its number');
select matches(app.send_feedback('Gateway', 'Here is what I saw.', '/home', null, null, null, null,
  pg_temp.id('nina')::text || '/shot.png'), '^FB-[0-9]{6}$', 'with a screenshot she uploaded herself');
select throws_ok(format($$select app.send_feedback('Gateway', 'Look', '/home', null, null, null, null, %L)$$,
  pg_temp.id('alice')::text || '/shot.png'), 'XR001', 'feedback_screenshot_not_yours: The screenshot must be one you uploaded.',
  'never someone else''s screenshot');
select throws_ok($$select app.send_feedback('Gateway', 'Look', '/home?token=abc')$$, '23514', null,
  'the page context never carries a query string');
select throws_ok($$select app.send_feedback('Atlas', '   ')$$, '23514', null, 'an empty message is refused');
select throws_ok($$insert into app.feedback_submissions (person_id, app_code, message) values (pg_temp.id('nina'), 'Atlas', 'Hi')$$,
  '42501', null, 'feedback is written only through app.send_feedback');

select pg_temp.as_user('alice');
select matches(app.send_feedback('Atlas', 'Bulk edit would save me an hour.', '/[org]/projects', pg_temp.id('org_a')),
  '^FB-[0-9]{6}$', 'a member names the org she was working in');
select throws_ok(format($$select app.send_feedback('Atlas', 'Hi', '/home', %L)$$, pg_temp.id('org_b')), 'XR001',
  'feedback_org_not_member: Feedback can name only an org you belong to.', 'but not an org she does not belong to');
select is((select count(*)::int from app.feedback_submissions), 1, 'alice reads only her own feedback');

select pg_temp.as_user('nina');
select is((select count(*)::int from app.feedback_submissions), 2, 'and nina only hers');
select throws_ok($$select * from app.feedback_triage_list()$$, '42501', null, 'the triage list is for platform staff only');
select is(app.am_i_platform_staff(), false, 'nina is not on the platform team');

-- The service role puts dave on the platform team: through A90's roster once it lands (1470), else the stand-in.
select pg_temp.as_platform();
do $$
begin
  if to_regclass('app.platform_operators') is not null then
    perform private.grant_platform_operator('dave@northwind.test', 'Support', 'Triages product feedback.');
  else
    insert into private.platform_staff (person_id, reason) values (pg_temp.id('dave'), 'Triages product feedback.');
  end if;
end;
$$;
select pg_temp.as_user('dave');
select is(app.am_i_platform_staff(), true, 'dave is on the platform team');
select is((select count(*)::int from app.feedback_triage_list()), 3, 'and reads every submission');
select is((select count(*)::int from app.feedback_triage_list('New')), 3, 'all of them New');
select lives_ok(format($$select app.triage_feedback((select f.id from app.feedback_submissions f where f.route = '/money'), 'Planned',
  'Pay tracker moves to Home.')$$), 'staff triage feedback with a note');
select is((select f.triaged_by from app.feedback_submissions f where f.route = '/money'), pg_temp.id('dave'),
  'recording who triaged it');
select throws_ok($$select app.triage_feedback((select f.id from app.feedback_submissions f limit 1), 'New')$$, 'XR001',
  'feedback_state_unknown: Triage moves feedback to Read, Planned or Closed.', 'triage never moves feedback back to New');

-- Staff open a screenshot only once its scan found it Clean (the storage policy's check, called as dave).
select pg_temp.claims('dave');
select is(private.staff_may_read_feedback_screenshot(pg_temp.id('nina')::text || '/shot.png'), false,
  'an unscanned screenshot stays closed to staff');
select pg_temp.as_platform();
insert into private.object_scans (bucket_id, object_name, scan_status, owner_id, scanned_at)
values ('support-screenshots', pg_temp.id('nina')::text || '/shot.png', 'Clean', pg_temp.id('nina_user')::text, now());
select pg_temp.claims('dave');
select is(private.staff_may_read_feedback_screenshot(pg_temp.id('nina')::text || '/shot.png'), true,
  'a Clean one opens');

-- Revoking access ends it at once.
select pg_temp.as_platform();
do $$
begin
  if to_regclass('app.platform_operators') is not null then
    update app.platform_operators set revoked_at = now(), revoke_reason = 'Left the team.'
    where person_id = pg_temp.id('dave') and revoked_at is null;
  else
    update private.platform_staff set revoked_at = now() where person_id = pg_temp.id('dave');
  end if;
end;
$$;
select pg_temp.as_user('dave');
select is((select count(*)::int from app.feedback_submissions), 0, 'revoked staff read nothing');

select * from finish();
rollback;

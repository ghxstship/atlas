-- pgTAP (A45, journey 57): a submitted timesheet asks its approvers for approval where approvals arrive,
-- and an approver approves it from the notification (the push action) without opening it. The submitter
-- and the worker are never asked (invariant 18); once decided, every other request leaves its Inbox.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(14);

create function pg_temp.requests(p_person text, p_sheet text) returns integer
language sql as $$
  select count(*)::int from app.notifications n
  where n.recipient_person_id = pg_temp.id(p_person) and n.subject_table = 'timesheets'
    and n.subject_id = pg_temp.id(p_sheet) and n.kind = 'approval.requested' and n.archived_at is null
$$;

-- Frank (Field) submits his own week; Owner, Admin and Manager may approve timesheets org-wide.
select pg_temp.as_user('frank');
with x as (insert into app.timesheets (project_id, membership_id, period_start, period_end)
           values (pg_temp.id('prj_a'), pg_temp.id('frank@org_a'), '2027-07-05', '2027-07-11') returning id)
  insert into world select 'ts', id from x;
select app.submit_timesheet(pg_temp.id('ts'), 'Week of the load-in.');
select pg_temp.as_platform();

select is(pg_temp.requests('carol', 'ts'), 1, 'the Manager is asked to approve the submitted timesheet');
select is(pg_temp.requests('bob', 'ts') + pg_temp.requests('alice', 'ts'), 2, 'so are the Admin and the Owner');
select is(pg_temp.requests('frank', 'ts'), 0, 'the worker who submitted it is never asked (invariant 18)');
select is(pg_temp.requests('dave', 'ts'), 0, 'a Member who cannot approve timesheets is not asked');
select is((select message_args ->> 'title' from app.notifications
           where recipient_person_id = pg_temp.id('carol') and subject_id = pg_temp.id('ts')),
  format('Timesheet %s, 2027-07-05 to 2027-07-11', (select full_name from app.people where id = pg_temp.id('frank'))),
  'the request names the worker and the period, so nothing needs opening');
insert into world select 'n_carol', id from app.notifications
  where recipient_person_id = pg_temp.id('carol') and subject_id = pg_temp.id('ts');
insert into world select 'n_bob', id from app.notifications
  where recipient_person_id = pg_temp.id('bob') and subject_id = pg_temp.id('ts');

select pg_temp.as_user('carol');
select is((select section from app.inbox_items where id = pg_temp.id('n_carol')), 'Needs You',
  'the request waits in the Manager''s Needs You');
select throws_ok($$select app.act_on_notification((select id from world where key = 'n_bob'), 'approve')$$, '42501', null,
  'nobody approves from someone else''s notification');
select throws_ok($$select app.act_on_notification((select id from world where key = 'n_carol'), 'reject')$$, 'XR001',
  'timesheet_rejection_reason: Say why when you reject a timesheet.', 'a rejection from the notification needs a reason');

-- The push action: Approve, without opening the timesheet.
select lives_ok($$select app.act_on_notification((select id from world where key = 'n_carol'), 'approve')$$,
  'the Manager approves from the notification');
select is((select timesheet_state::text from app.timesheets where id = pg_temp.id('ts')), 'Approved', 'the timesheet is approved');
select is((select approved_by from app.timesheet_approvals where timesheet_id = pg_temp.id('ts')), pg_temp.id('carol'),
  'the approval is recorded as the Manager''s, through app.decide_timesheet');
select pg_temp.as_platform();
select is(pg_temp.requests('bob', 'ts') + pg_temp.requests('alice', 'ts') + pg_temp.requests('carol', 'ts'), 0,
  'every request leaves every Inbox once the timesheet is decided');

-- Every timesheet rule still decides: a request for a timesheet the approver submitted cannot be approved.
select pg_temp.as_user('carol');
with x as (insert into app.timesheets (project_id, membership_id, period_start, period_end)
           values (pg_temp.id('prj_a'), pg_temp.id('frank@org_a'), '2027-07-12', '2027-07-18') returning id)
  insert into world select 'ts2', id from x;
select app.submit_timesheet(pg_temp.id('ts2'), 'Submitted for Frank.');
select pg_temp.as_platform();
select is(pg_temp.requests('carol', 'ts2'), 0, 'the Manager who submitted it for the worker is not asked either');
select pg_temp.as_user('bob');
select lives_ok($$select app.act_on_notification(
    (select id from app.notifications where recipient_person_id = (select id from world where key = 'bob')
       and subject_id = (select id from world where key = 'ts2')), 'reject', 'Missing the strike day.')$$,
  'the Admin rejects it from the notification with a reason');

select * from finish();
rollback;

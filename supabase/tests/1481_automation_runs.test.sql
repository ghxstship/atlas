-- pgTAP: the automation engine (A91, RRR-136, finding A65-010, ADR 0047). Domain events start runs for matching
-- automations, once per event, on the job queue; the worker API starts runs as the owner, records steps and settles
-- them through the queue's backoff; loop protection and the hourly limit skip runs; a run whose owner left the org or
-- lost org.automations.write fails closed and pauses the automation with a notice; the notify and call_webhook
-- operations act only inside a running run of the caller's own automation; failed runs retry; plan gating and RLS.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(41);

create function pg_temp.record(p_kind text, p_title text) returns uuid
language plpgsql as $$
declare v uuid;
begin
  insert into app.records (project_id, scope_node_id, record_kind, title, phase_code, xyz, xyz_basis)
  values (pg_temp.id('prj_a'), pg_temp.id('root_a'), p_kind, p_title, 'SCP', 'Y', 'Declared') returning id into v;
  return v;
end $$;

-- The run an event about a record started for the automation under test.
create function pg_temp.run_for(p_record text) returns uuid
language sql as $$
  select r.id from app.automation_runs r
  where r.automation_id = pg_temp.id('auto') and r.event_payload -> 'subject' ->> 'id' = pg_temp.id(p_record)::text
  order by r.created_at desc limit 1
$$;

-- Claims the queued automation.run job of a run, as the worker does.
create function pg_temp.claim(p_run uuid) returns uuid
language sql as $$
  select j.id from app.claim_jobs('pgtap-worker', 'automation.run', 100) j where j.subject_id = p_run
$$;

-- A session whose JWT carries the run its request acts for, as the worker's minted token does.
create function pg_temp.as_automation(p_key text, p_run uuid) returns void
language plpgsql as $$
begin
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', json_build_object('sub', pg_temp.id(p_key || '_user'), 'role', 'authenticated',
    'xos_automation_run_id', p_run)::text, true);
  perform set_config('role', 'authenticated', true);
end $$;

select pg_temp.as_user('bob');
insert into world values ('auto', app.save_automation(pg_temp.id('org_a'), null, 'Pick up tasks', null, 'record.created',
  '{"all": [{"field": "data.record_kind", "operator": "eq", "value": "Task"}]}',
  jsonb_build_array(jsonb_build_object('type', 'add_comment', 'body', 'Picked up {{data.title}}.'),
    jsonb_build_object('type', 'notify', 'recipient_person_id', pg_temp.id('carol'), 'title', 'New task')), true));
insert into world values ('hook', (select e.webhook_endpoint_id from app.create_webhook_endpoint(pg_temp.id('org_a'),
  'https://hooks.northwind.test/a91', array['shipment.created'], 'Automation target') e));

-- Fan-out: one run per matching automation and event, on the job queue ------------------------------------------------
select pg_temp.as_user('alice');
insert into world values ('task1', pg_temp.record('Task', 'Call the venue'));
select pg_temp.as_platform();
select is((select count(*)::integer from app.automation_runs where automation_id = pg_temp.id('auto')), 1,
  'a matching event starts one run');
select is((select concat_ws(':', r.run_status, r.depth, r.event_payload ->> 'type', r.event_payload -> 'data' ->> 'record_kind', j.job_kind, j.job_status)
  from app.automation_runs r join app.job_queue j on j.id = r.job_id where r.automation_id = pg_temp.id('auto')),
  'Queued:0:record.created:Task:automation.run:Queued', 'the run is queued on the job queue with the event body as its input');
select pg_temp.as_user('alice');
select pg_temp.record('Build', 'Install the truss');
select pg_temp.as_platform();
select is((select count(*)::integer from app.automation_runs where automation_id = pg_temp.id('auto')), 1,
  'an event that misses the conditions starts nothing');
select throws_ok($$insert into app.automation_runs (automation_id, domain_event_id, event_payload)
  select automation_id, domain_event_id, event_payload from app.automation_runs where automation_id = pg_temp.id('auto') limit 1$$,
  '23505', null, 'an event runs an automation at most once');

-- The worker: start as the owner, record steps, retry through the queue, succeed ------------------------------------------
insert into world values ('run1', pg_temp.run_for('task1'));
insert into world values ('job1', pg_temp.claim(pg_temp.id('run1')));
select is((select concat_ws(':', b ->> 'outcome', b ->> 'owner_user_id' = pg_temp.id('bob_user')::text, jsonb_array_length(b -> 'actions'), b -> 'completed')
  from (select app.begin_automation_run(pg_temp.id('run1'), pg_temp.id('job1')) b) s),
  'run:t:2:[]', 'the worker starts the run as its owner, with the actions in order');
select lives_ok($$select app.record_automation_step(pg_temp.id('run1'), 1::smallint, null, 'add_comment', 'comments.postOnSubject', 'Succeeded',
  '{"body": "Picked up Call the venue."}', '{"id": "c1"}', 201::smallint, null, null, now(), 42)$$, 'the worker records a step');
select is(app.finish_automation_run(pg_temp.id('run1'), pg_temp.id('job1'), 'retry', 'api_unavailable', 'The API answered 503.'),
  'Retrying'::app.automation_run_status, 'a failure the API may recover from is retried');
select is((select concat_ws(':', j.job_status, j.attempts, j.run_after > now()) from app.job_queue j where j.id = pg_temp.id('job1')),
  'Queued:1:t', 'through the job queue''s backoff');
update app.job_queue set run_after = now() where id = pg_temp.id('job1');
select pg_temp.claim(pg_temp.id('run1'));
select is(app.begin_automation_run(pg_temp.id('run1'), pg_temp.id('job1')) -> 'completed', '[1]'::jsonb,
  'a retried run skips the steps that already succeeded');
select is(app.finish_automation_run(pg_temp.id('run1'), pg_temp.id('job1'), 'succeeded'), 'Succeeded'::app.automation_run_status,
  'the run succeeds');
select is((select concat_ws(':', r.run_status, r.attempts, r.duration_ms is not null, j.job_status)
  from app.automation_runs r join app.job_queue j on j.id = r.job_id where r.id = pg_temp.id('run1')),
  'Succeeded:2:t:Succeeded', 'with its attempts and duration recorded and its job done');
select throws_like($$select app.record_automation_step(pg_temp.id('run1'), 2::smallint, null, 'notify', 'automationRuns.notify', 'Succeeded',
  null, null, 201::smallint, null, null, now(), 1)$$, 'automation_run_not_running%', 'a finished run records no more steps');

-- Loop protection --------------------------------------------------------------------------------------------------------
select pg_temp.as_automation('alice', pg_temp.id('run1'));
insert into world values ('task2', pg_temp.record('Task', 'Book the crew'));
select pg_temp.as_platform();
select is((select concat_ws(':', r.depth, r.parent_run_id = pg_temp.id('run1'), r.run_status) from app.automation_runs r
  where r.id = pg_temp.run_for('task2')), '1:t:Queued', 'an event an automation''s action caused starts a run one level deeper');
insert into world values ('run2', pg_temp.run_for('task2'));
update app.automation_runs set depth = 3 where id = pg_temp.id('run2');
select pg_temp.as_automation('alice', pg_temp.id('run2'));
insert into world values ('task3', pg_temp.record('Task', 'Order the barricades'));
select pg_temp.as_platform();
select is((select concat_ws(':', r.depth, r.run_status, r.error_code, r.job_id is null) from app.automation_runs r
  where r.id = pg_temp.run_for('task3')), '4:Skipped:loop_depth:t', 'past the depth limit a run is recorded Skipped and never queued');

-- The hourly limit -------------------------------------------------------------------------------------------------------
insert into app.domain_events (org_id, event_type, subject_table, subject_id)
select pg_temp.id('org_a'), 'record.replanned', 'records', gen_random_uuid() from generate_series(1, 1000);
insert into app.automation_runs (automation_id, domain_event_id, run_status, event_payload, finished_at, duration_ms)
select pg_temp.id('auto'), e.id, 'Succeeded', '{"filler": true}', now(), 0 from app.domain_events e
where e.org_id = pg_temp.id('org_a') and e.event_type = 'record.replanned' limit 1000;
select pg_temp.as_user('alice');
insert into world values ('task4', pg_temp.record('Task', 'Print the passes'));
select pg_temp.as_platform();
select is((select concat_ws(':', r.run_status, r.error_code) from app.automation_runs r where r.id = pg_temp.run_for('task4')),
  'Skipped:rate_limited', 'past the org''s hourly limit runs are recorded Skipped');
delete from app.automation_runs where event_payload = '{"filler": true}';

-- Fail closed: the owner lost org.automations.write ----------------------------------------------------------------------
select pg_temp.as_user('alice');
insert into world values ('task5', pg_temp.record('Task', 'Check the rigging'));
select pg_temp.as_platform();
insert into world values ('run5', pg_temp.run_for('task5'));
insert into world values ('job5', pg_temp.claim(pg_temp.id('run5')));
update app.membership_roles set deleted_at = now() where membership_id = pg_temp.id('bob@org_a') and deleted_at is null;
select is(app.begin_automation_run(pg_temp.id('run5'), pg_temp.id('job5')) ->> 'error_code', 'owner_lost_capability',
  'a run whose owner lost org.automations.write is refused');
select is((select concat_ws(':', r.run_status, a.enabled, a.pause_reason, j.job_status)
  from app.automation_runs r join app.automations a on a.id = r.automation_id join app.job_queue j on j.id = r.job_id
  where r.id = pg_temp.id('run5')), 'Failed:f:owner_lost_capability:Failed', 'it fails closed: the run fails and the automation pauses');
select ok(exists (select 1 from app.notifications n where n.kind = 'automation.paused' and n.recipient_person_id = pg_temp.id('alice')
  and n.subject_id = pg_temp.id('auto') and n.message_args ->> 'reason' = 'owner_lost_capability'),
  'the org''s automation managers are told why it paused');
select pg_temp.as_user('alice');
select is((select count(*)::integer from app.automation_runs where automation_id = pg_temp.id('auto')
  and event_payload -> 'subject' ->> 'id' = pg_temp.record('Task', 'Sweep the stage')::text), 0, 'a paused automation starts no runs');
select pg_temp.as_platform();
insert into app.membership_roles (membership_id, role_id) values (pg_temp.id('bob@org_a'), pg_temp.system_role('admin'));

-- Turning it on again makes the person who did it the owner; a queued run of an automation turned off is skipped ---------
select pg_temp.as_user('alice');
select app.set_automation_enabled(pg_temp.id('auto'), true);
select is((select concat_ws(':', owner_person_id = pg_temp.id('alice'), enabled, paused_at is null) from app.automations
  where id = pg_temp.id('auto')), 't:t:t', 'turning a paused automation on clears the pause and makes the caller its owner');
insert into world values ('task6', pg_temp.record('Task', 'Load the van'));
select pg_temp.as_user('bob');
select app.set_automation_enabled(pg_temp.id('auto'), false);
select pg_temp.as_platform();
insert into world values ('run6', pg_temp.run_for('task6'));
select is((select concat_ws(':', b ->> 'outcome', b ->> 'error_code') from (select app.begin_automation_run(pg_temp.id('run6'),
  pg_temp.claim(pg_temp.id('run6'))) b) s), 'skipped:automation_off', 'a queued run of an automation turned off is skipped');
select pg_temp.as_user('alice');
select app.set_automation_enabled(pg_temp.id('auto'), true);

-- The run-scoped operations: only the owner, only while the run runs ---------------------------------------------------------
insert into world values ('task7', pg_temp.record('Task', 'Confirm the caterer'));
select pg_temp.as_platform();
insert into world values ('run7', pg_temp.run_for('task7'));
insert into world values ('job7', pg_temp.claim(pg_temp.id('run7')));
select app.begin_automation_run(pg_temp.id('run7'), pg_temp.id('job7'));
select pg_temp.as_user('dave');
select throws_ok($$select app.send_automation_notice(pg_temp.id('run7'), pg_temp.id('carol'), 'Hi')$$, '42501', null,
  'only the automation''s owner acts inside its run');
select pg_temp.as_user('alice');
select lives_ok($$insert into world values ('notice', app.send_automation_notice(pg_temp.id('run7'), pg_temp.id('carol'), 'New task: Confirm the caterer'))$$,
  'the owner notifies a member during the run');
select pg_temp.as_platform();
select is((select concat_ws(':', n.kind, n.subject_table, n.subject_id = pg_temp.id('task7'), n.message_args ->> 'body', n.actor_person_id = pg_temp.id('alice'))
  from app.notifications n where n.id = pg_temp.id('notice')), 'automation.notice:records:t:New task: Confirm the caterer:t',
  'the notice is about the event''s subject, from the owner, and repeats its title without a message');
select pg_temp.as_user('alice');
select throws_like($$select app.send_automation_notice(pg_temp.id('run7'), pg_temp.id('xavier'), 'Hi')$$, 'automation_person_not_member%',
  'a notice goes only to members of the org');
select lives_ok($$insert into world values ('delivery', app.queue_automation_webhook(pg_temp.id('run7'), pg_temp.id('hook')))$$,
  'the owner sends the event to a webhook endpoint during the run');
select is((select d.domain_event_id = r.domain_event_id and d.delivery_status = 'Pending' from app.webhook_deliveries d, app.automation_runs r
  where d.id = pg_temp.id('delivery') and r.id = pg_temp.id('run7')), true, 'as a signed delivery of the run''s event on the webhook queue');

select pg_temp.as_platform();
select is(app.finish_automation_run(pg_temp.id('run7'), pg_temp.id('job7'), 'refused', 'owner_access_refused', 'The API answered 403.'),
  'Failed'::app.automation_run_status, 'a refusal of the owner''s access fails the run');
select is((select concat_ws(':', enabled, pause_reason) from app.automations where id = pg_temp.id('auto')), 'f:owner_access_refused',
  'and pauses the automation');
select pg_temp.as_user('alice');
select throws_ok($$select app.send_automation_notice(pg_temp.id('run7'), pg_temp.id('carol'), 'Hi')$$, '42501', null,
  'a finished run takes no more actions');

-- Retrying failed runs ---------------------------------------------------------------------------------------------------
select throws_like($$select app.retry_automation_run(pg_temp.id('run7'))$$, 'automation_off%', 'a paused automation''s runs wait until it is on');
select app.set_automation_enabled(pg_temp.id('auto'), true);
select lives_ok($$select app.retry_automation_run(pg_temp.id('run7'))$$, 'a failed run is retried');
select is((select concat_ws(':', r.run_status, j.job_status, r.job_id <> pg_temp.id('job7')) from app.automation_runs r
  join app.job_queue j on j.id = r.job_id where r.id = pg_temp.id('run7')), 'Queued:Queued:t', 'on a new job');
select throws_like($$select app.retry_automation_run(pg_temp.id('run1'))$$, 'automation_run_not_failed%', 'only failed runs are retried');

-- Failures tell the owner at most once an hour -----------------------------------------------------------------------------
insert into world values ('task8', pg_temp.record('Task', 'Hire the forklift'));
select pg_temp.as_platform();
select app.begin_automation_run(pg_temp.id('run7'), pg_temp.claim(pg_temp.id('run7')));
select app.finish_automation_run(pg_temp.id('run7'), (select job_id from app.automation_runs where id = pg_temp.id('run7')), 'failed',
  'record_title_grammar', 'A Task title starts with an imperative verb.');
insert into world values ('run8', pg_temp.run_for('task8'));
select app.begin_automation_run(pg_temp.id('run8'), pg_temp.claim(pg_temp.id('run8')));
select app.finish_automation_run(pg_temp.id('run8'), (select job_id from app.automation_runs where id = pg_temp.id('run8')), 'failed',
  'record_title_grammar', 'A Task title starts with an imperative verb.');
select is((select count(*)::integer from app.notifications n where n.kind = 'automation.failed' and n.recipient_person_id = pg_temp.id('alice')
  and n.subject_id = pg_temp.id('auto')), 1, 'two failed runs tell the owner once');

-- Who reads the ledger -------------------------------------------------------------------------------------------------------
select pg_temp.as_user('xavier');
select is((select count(*)::integer from app.automation_runs), 0, 'another org cannot read the runs');
select pg_temp.as_user('dave');
select is((select count(*)::integer from app.automation_run_steps), 0, 'nor can a member without org.automations.write read the steps');
select pg_temp.as_user('bob');
select ok((select count(*) from app.automation_runs where automation_id = pg_temp.id('auto')) > 0, 'automation managers read the run history');
select throws_ok($$select app.begin_automation_run(pg_temp.id('run8'))$$, '42501', null, 'the worker API is for the service role only');

-- Plan gating and a departed owner -------------------------------------------------------------------------------------------
select pg_temp.as_platform();
update app.subscriptions set plan_code = 'core' where org_id = pg_temp.id('org_a');
select pg_temp.as_user('alice');
insert into world values ('task9', pg_temp.record('Task', 'Collect the radios'));
select is(pg_temp.run_for('task9'), null, 'without the automations feature events start no runs');
select pg_temp.as_platform();
update app.subscriptions set plan_code = 'team' where org_id = pg_temp.id('org_a');
select pg_temp.as_user('bob');
select app.set_automation_enabled(pg_temp.id('auto'), false);
select app.set_automation_enabled(pg_temp.id('auto'), true);
select pg_temp.as_user('alice');
insert into world values ('task10', pg_temp.record('Task', 'Return the radios'));
select pg_temp.as_platform();
update app.memberships set valid_from = now() - interval '10 days', valid_to = now() - interval '1 day'
where id = pg_temp.id('bob@org_a');
select is(app.begin_automation_run(pg_temp.run_for('task10'), pg_temp.claim(pg_temp.run_for('task10'))) ->> 'error_code', 'owner_left_org',
  'a run whose owner left the org fails closed');

select * from finish();
rollback;

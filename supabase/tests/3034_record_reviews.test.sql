-- pgTAP: record reviews as a done-gate (3034, B14 G-268; ADR 0153 D5). A record that requires review is not Complete
-- without an approved latest review, through app.transition_record and app.bulk_update_records alike. Requesting a
-- review creates an Approval record "Review of KEY-n" owned by an eligible reviewer and moves the record In Review;
-- the requester never decides it; asking for changes needs a note, moves the record back to Active with the note and
-- tells the requester; Approve and Reject also work from Inbox. Clearing the flag needs projects.settings.write, and
-- templates carry the flag both ways.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(35);

create function pg_temp.new_record(p_key text, p_title text, p_review boolean default true) returns uuid
language plpgsql as $$
declare v uuid;
begin
  insert into app.records (project_id, record_kind, record_subtype, title, xyz, xyz_basis, requires_review)
  values (pg_temp.id('prj_a'), 'Task', 'Execute', p_title, 'Y', 'Declared', p_review) returning id into v;
  insert into world values (p_key, v);
  return v;
end $$;
create function pg_temp.start(p_key text) returns void
language sql as $$
  select app.transition_record(pg_temp.id(p_key), 'Proposed', 'Ready', 'Ready.');
  select app.transition_record(pg_temp.id(p_key), 'Ready', 'Active', 'Started.');
$$;
create function pg_temp.bulk_complete(p_key text) returns text
language sql as $$
  select app.bulk_update_records(jsonb_build_array(jsonb_build_object('id', pg_temp.id(p_key),
    'set', jsonb_build_object('record_state', 'Complete'))), false, 'Done.') -> 'refused' -> 0 ->> 'rule'
$$;

select has_column('app', 'records', 'requires_review', 'records carry requires_review');
select has_function('app', 'request_record_review', array['uuid', 'uuid', 'text'], 'app.request_record_review exists');

-- carol, a Manager, flags a task and starts it.
select pg_temp.as_user('carol');
select pg_temp.new_record('t1', 'Rig the follow spots');
select pg_temp.start('t1');
select throws_ok(format($$select app.transition_record(%L, 'Active', 'Complete', 'Done.')$$, pg_temp.id('t1')),
  'XR001', 'record_review_required: This record needs an approved review before it is Complete.',
  'a flagged record is not Complete without a review');
select is(pg_temp.bulk_complete('t1'), 'record_review_required', 'nor through bulk edit');

-- Who reviews.
select throws_ok(format('select app.request_record_review(%L, %L)', pg_temp.id('t1'), pg_temp.id('carol')),
  'XR001', 'sod_approval_requester: An approval is decided by an eligible approver, never the requester.',
  'the requester cannot name themselves');
select throws_ok(format('select app.request_record_review(%L, %L)', pg_temp.id('t1'), pg_temp.id('gina')),
  'XR001', 'approval_not_eligible: Only a person who may write the project''s records decides its approvals.',
  'a reviewer who could not decide is refused');
select lives_ok(format($$insert into world select 'ap1', app.request_record_review(%L, %L, 'Check the focus positions.')$$,
  pg_temp.id('t1'), pg_temp.id('erin')), 'carol asks erin, a Coordinator of the project, to review it');
select is((select row(r.title, r.record_kind, r.owner_party_id, r.record_state)::text from app.records r where r.id = pg_temp.id('ap1')),
  row('Review of NWL-' || (select record_number from app.records where id = pg_temp.id('t1')), 'Approval', pg_temp.id('erin'), 'Active')::text,
  'an Active Approval record "Review of KEY-n" owned by the reviewer');
select is((select row(a.subject_record_id, a.requester_person_id, a.decision)::text from app.record_approval a where a.record_id = pg_temp.id('ap1')),
  row(pg_temp.id('t1'), pg_temp.id('carol'), null::app.approval_decision)::text, 'its approval names the record and the requester');
select is((select record_state from app.records where id = pg_temp.id('t1')), 'In Review', 'the record is In Review');
select is((select reason from app.record_state_transitions where record_id = pg_temp.id('t1') order by created_at desc, id desc limit 1),
  'Check the focus positions.', 'with the note as the reason');
select pg_temp.as_platform();
select is((select count(*)::integer from app.notifications n where n.recipient_person_id = pg_temp.id('erin') and n.kind = 'approval.requested'
           and n.subject_table = 'app.records' and n.subject_id = pg_temp.id('ap1')
           and n.message_args ->> 'recordKey' = 'NWL-' || (select record_number from app.records where id = pg_temp.id('t1'))
           and n.message_args ->> 'title' = 'Rig the follow spots'), 1,
  'the reviewer gets approval.requested with the title and the record key');
select pg_temp.as_user('carol');
select throws_ok(format('select app.request_record_review(%L)', pg_temp.id('t1')),
  'XR001', 'record_review_state: Start the work before asking for a review.', 'a record In Review is not asked again');
select throws_ok(format($$select app.transition_record(%L, 'In Review', 'Complete', 'Done.')$$, pg_temp.id('t1')),
  'XR001', 'record_review_pending: The review is still open.', 'not Complete while the review is open');

-- Deciding.
select throws_ok(format($$select app.decide_record_review(%L, 'Approved')$$, pg_temp.id('ap1')),
  'XR001', 'sod_approval_requester: An approval is decided by an eligible approver, never the requester.',
  'the requester cannot decide their own review');
select pg_temp.as_user('erin');
select throws_ok(format($$select app.decide_record_review(%L, 'Rejected')$$, pg_temp.id('ap1')),
  'XR001', 'record_review_note_required: Say what to change when you ask for changes.', 'asking for changes needs a note');
select lives_ok(format($$select app.decide_record_review(%L, 'Rejected', 'Re-aim spot two at the lectern.')$$, pg_temp.id('ap1')),
  'the reviewer asks for changes');
select is((select record_state from app.records where id = pg_temp.id('t1')), 'Active', 'the record is back to Active');
select is((select reason from app.record_state_transitions where record_id = pg_temp.id('t1') order by created_at desc, id desc limit 1),
  'Changes requested: Re-aim spot two at the lectern.', 'with the note in its history');
select is((select row(r.record_state, a.approver_person_id, a.decision)::text from app.records r
           join app.record_approval a on a.record_id = r.id where r.id = pg_temp.id('ap1')),
  row('Complete', pg_temp.id('erin'), 'Rejected')::text, 'the Approval record is Complete with the reviewer as approver');
select pg_temp.as_platform();
select is((select count(*)::integer from app.notifications where subject_id = pg_temp.id('ap1') and kind = 'approval.requested'
           and archived_at is null), 0, 'the reviewer''s request leaves the Inbox');
select is((select message_args ->> 'decision' from app.notifications where recipient_person_id = pg_temp.id('carol')
           and kind = 'approval.decided' and subject_id = pg_temp.id('ap1')), 'rejected', 'the requester gets approval.decided');
select pg_temp.as_user('carol');
select throws_ok(format($$select app.transition_record(%L, 'Active', 'Complete', 'Done.')$$, pg_temp.id('t1')),
  'XR001', 'record_review_changes_requested: The reviewer asked for changes; ask for another review.',
  'not Complete after changes were requested');

-- A second review, decided from Inbox.
insert into world select 'ap2', app.request_record_review(pg_temp.id('t1'), pg_temp.id('erin'), 'Re-aimed.');
select pg_temp.as_user('erin');
insert into world select 'n2', n.id from app.notifications n where n.subject_id = pg_temp.id('ap2') and n.kind = 'approval.requested';
select throws_ok(format($$select app.act_on_notification(%L, 'reject')$$, pg_temp.id('n2')),
  'XR001', 'record_review_note_required: Say what to change when you ask for changes.', 'Reject from Inbox needs a comment');
select lives_ok(format($$select app.act_on_notification(%L, 'approve')$$, pg_temp.id('n2')), 'the reviewer approves from Inbox');
select is((select record_state from app.records where id = pg_temp.id('t1')), 'In Review', 'an approval leaves the record In Review');
select pg_temp.as_user('carol');
select lives_ok(format($$select app.transition_record(%L, 'In Review', 'Complete', 'Done.')$$, pg_temp.id('t1')),
  'after an Approved decision the owner completes it');

-- An open review blocks another; an Approval record is not reviewed.
select pg_temp.new_record('t2', 'Label the cable runs');
select pg_temp.start('t2');
insert into world select 'ap3', app.request_record_review(pg_temp.id('t2'));
select app.transition_record(pg_temp.id('t2'), 'In Review', 'Active', 'Back to it.');
select throws_ok(format('select app.request_record_review(%L)', pg_temp.id('t2')),
  'XR001', 'record_review_open: A review of this record is still open; wait for its decision.', 'one open review at a time');
select throws_ok(format('select app.request_record_review(%L)', pg_temp.id('ap3')),
  'XR001', 'record_review_kind: An approval is decided, not reviewed.', 'an Approval record is not reviewed');

-- The flag.
select pg_temp.new_record('t3', 'Order the gaffer tape', false);
select pg_temp.as_user('dave');
select lives_ok(format('update app.records set requires_review = true where id = %L', pg_temp.id('t3')),
  'a Coordinator turns the flag on');
select throws_ok(format('update app.records set requires_review = false where id = %L', pg_temp.id('t3')),
  'XR001', 'record_review_flag_locked: Only someone who may change the project''s settings turns off Requires review.',
  'and cannot turn it off');
select pg_temp.as_user('carol');
select lives_ok(format('update app.records set requires_review = false where id = %L', pg_temp.id('t3')),
  'a Manager turns it off');

-- Templates carry the flag both ways.
with x as (insert into app.templates (org_id, name) values (pg_temp.id('org_a'), 'Reviewed Plan') returning id)
  insert into world select 'tpl', id from x;
with x as (insert into app.template_versions (template_id, default_time_zone) values (pg_temp.id('tpl'), 'America/New_York') returning id)
  insert into world select 'tv', id from x;
select throws_ok(format($$insert into app.template_items (template_version_id, item_kind, sort_order, name, scope_kind, scope_code_suffix, requires_review)
  values (%L, 'Scope Node', 1, 'Main Stage', 'Show', 'E02', true)$$, pg_temp.id('tv')), '23514', null, 'a Scope Node item never requires review');
insert into app.template_items (template_version_id, item_kind, sort_order, name, record_kind, xyz, requires_review)
  values (pg_temp.id('tv'), 'Record', 1, 'Sign off the rigging plan', 'Task', 'Y', true);
select app.publish_template_version(pg_temp.id('tv'));
insert into world select 'app_t', app.apply_template(pg_temp.id('tpl'), 'NWR', 'Northwind Reviewed', null, '2027-08-01');
insert into world select 'prj_t', a.project_id from app.template_applications a where a.id = pg_temp.id('app_t');
select is((select bool_and(requires_review) from app.records where project_id = pg_temp.id('prj_t')), true,
  'a Requires review item creates flagged records');
insert into world select 'tpl2', app.create_template_from_project(pg_temp.id('prj_t'), 'Reviewed Plan Again');
select is((select bool_and(i.requires_review) from app.template_items i join app.templates t on t.current_version_id = i.template_version_id
           where t.id = pg_temp.id('tpl2') and i.item_kind = 'Record'), true,
  'saving the project as a template keeps the flag');

select * from finish();
rollback;

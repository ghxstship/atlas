-- pgTAP: record reviews as a done-gate (6264, B14 G-268; ADR 0153 D5). A record that requires review is not Complete
-- without an approved latest review, through app.transition_record and app.bulk_update_records alike. Requesting a
-- review creates an Approval record "Review of KEY-n" owned by an eligible reviewer and moves the record In Review;
-- the requester never decides it; asking for changes needs a note, moves the record back to Active with the note and
-- tells the requester; Approve and Reject also work from Inbox. Only an independent decision about the work as it
-- stands counts: never one by the record's owner or by the person completing it, nor one decided before the record last
-- entered Active, so a hand-made Approval record with a borrowed requester, or a reopened record, needs a new review;
-- and a decided review is never moved onto another record or re-dated.
-- Clearing the flag needs projects.settings.write, and templates carry the flag both ways.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(65);

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
-- pgTAP runs in one transaction, where now() never moves. A review decided in a later request than the record's last
-- move into Active is decided after it; this ages what happened to the record so far by an hour, so the next step is
-- later than all of it, as it would be in another request.
create function pg_temp.an_hour_passes(p_key text) returns void
language plpgsql as $$
begin
  perform pg_temp.as_platform();
  alter table app.record_state_transitions disable trigger t95_append_only;
  alter table app.record_state_transitions disable trigger t90_stamp_audit_columns;
  update app.record_state_transitions set created_at = created_at - interval '1 hour' where record_id = pg_temp.id(p_key);
  alter table app.record_state_transitions enable trigger t95_append_only;
  alter table app.record_state_transitions enable trigger t90_stamp_audit_columns;
  alter table app.record_approval disable trigger t41_record_approval_fixed;
  update app.record_approval set decided_at = decided_at - interval '1 hour'
  where subject_record_id = pg_temp.id(p_key) and decided_at is not null;
  alter table app.record_approval enable trigger t41_record_approval_fixed;
end $$;
-- A decision recorded in a later request than everything before it: decided_at is fixed once set (t41), so the test
-- moves it with that trigger off.
create function pg_temp.decided_later(p_key text) returns void
language plpgsql as $$
begin
  perform pg_temp.as_platform();
  alter table app.record_approval disable trigger t41_record_approval_fixed;
  update app.record_approval set decided_at = decided_at + interval '1 minute' where record_id = pg_temp.id(p_key);
  alter table app.record_approval enable trigger t41_record_approval_fixed;
end $$;
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
-- The decision was a later request than the record's last move into Active.
select pg_temp.decided_later('ap2');
select pg_temp.as_user('carol');
select lives_ok(format($$select app.transition_record(%L, 'In Review', 'Complete', 'Done.')$$, pg_temp.id('t1')),
  'after an Approved decision the owner completes it');

-- Reopened, the record needs a new review: the approval was of the work before it went back to Active.
select pg_temp.an_hour_passes('t1');
select pg_temp.as_user('carol');
select app.transition_record(pg_temp.id('t1'), 'Complete', 'Active', 'One spot drifted overnight.');
select throws_ok(format($$select app.transition_record(%L, 'Active', 'Complete', 'Done again.')$$, pg_temp.id('t1')),
  'XR001', 'record_review_required: This record needs an approved review before it is Complete.',
  'a reopened record is not completed again on its old approval');

-- An Approved review followed by a Rejected one that is then deleted: the record went back to Active after the
-- approval, so it no longer stands.
select pg_temp.new_record('t6', 'Focus the side fills');
select pg_temp.start('t6');
insert into world select 'ap6', app.request_record_review(pg_temp.id('t6'), pg_temp.id('erin'), 'Focused.');
select pg_temp.as_user('erin');
select app.decide_record_review(pg_temp.id('ap6'), 'Approved');
select pg_temp.an_hour_passes('t6');
select pg_temp.as_user('carol');
select app.transition_record(pg_temp.id('t6'), 'In Review', 'Active', 'Moving the fills for the new set.');
insert into world select 'ap7', app.request_record_review(pg_temp.id('t6'), pg_temp.id('erin'), 'Refocused.');
select pg_temp.as_user('erin');
select app.decide_record_review(pg_temp.id('ap7'), 'Rejected', 'Fill three spills onto the screen.');
select pg_temp.as_platform();
update app.records set deleted_at = now() where id = pg_temp.id('ap7');
select pg_temp.as_user('carol');
select throws_ok(format($$select app.transition_record(%L, 'Active', 'Complete', 'Done.')$$, pg_temp.id('t6')),
  'XR001', 'record_review_required: This record needs an approved review before it is Complete.',
  'deleting the Rejected review does not bring back the older approval');

-- The owner of a record never reviews it.
select pg_temp.new_record('t5', 'Hang the scrim');
update app.records set owner_party_id = pg_temp.id('erin') where id = pg_temp.id('t5');
select pg_temp.start('t5');
select throws_ok(format('select app.request_record_review(%L)', pg_temp.id('t5')),
  '22023', 'a review names its reviewer', 'a review names its reviewer');
select throws_ok(format('select app.request_record_review(%L, %L)', pg_temp.id('t5'), pg_temp.id('erin')),
  'XR001', 'sod_record_review_owner: The owner of a record cannot review it.', 'the owner is not asked to review it');
insert into world select 'ap5', app.request_record_review(pg_temp.id('t5'), pg_temp.id('dave'), 'Hung.');
select pg_temp.as_user('erin');
select throws_ok(format($$select app.decide_record_review(%L, 'Approved')$$, pg_temp.id('ap5')),
  'XR001', 'sod_record_review_owner: The owner of a record cannot review it.', 'nor decides a review of it');

-- An Approval record made by hand, with someone else named as requester, does not complete the work of the person
-- who approved it.
select pg_temp.as_user('carol');
select pg_temp.new_record('t7', 'Tie off the drape line');
select pg_temp.start('t7');
with r as (insert into app.records (project_id, record_kind, title, xyz, xyz_basis)
  values (pg_temp.id('prj_a'), 'Approval', 'Review of NWL-' || (select record_number from app.records where id = pg_temp.id('t7')), 'Y', 'Declared')
  returning id) insert into world select 'ap_spoof', id from r;
select lives_ok(format($$insert into app.record_approval (record_id, subject_record_id, requester_person_id, decision)
  values (%L, %L, %L, 'Approved')$$, pg_temp.id('ap_spoof'), pg_temp.id('t7'), pg_temp.id('erin')),
  'carol records an approval of her own task, naming erin as requester');
select is((select approver_person_id from app.record_approval where record_id = pg_temp.id('ap_spoof')), pg_temp.id('carol'),
  'the database names carol as its approver');
select pg_temp.decided_later('ap_spoof');
select pg_temp.as_user('carol');
select throws_ok(format($$select app.transition_record(%L, 'Active', 'Complete', 'Done.')$$, pg_temp.id('t7')),
  'XR001', 'record_review_required: This record needs an approved review before it is Complete.',
  'her own approval does not let her complete it');
-- Nor does someone else's: erin's Approved review of another task cannot be moved onto carol's, or re-dated past
-- the reopen that voided it, by anyone who may write the project's records.
select throws_ok(format('update app.record_approval set subject_record_id = %L where record_id = %L',
  pg_temp.id('t7'), pg_temp.id('ap6')),
  'XR001', 'approval_subject_immutable: An approval stays with the record it was raised about.',
  'a decided review is not re-pointed at another record');
select throws_ok(format($$update app.record_approval set decided_at = decided_at + interval '1 day' where record_id = %L$$,
  pg_temp.id('ap6')),
  'XR001', 'approval_decided: A decided approval is final; raise a new approval instead.',
  'nor re-dated');

-- An open review blocks another; an Approval record is not reviewed.
select pg_temp.new_record('t2', 'Label the cable runs');
select pg_temp.start('t2');
insert into world select 'ap3', app.request_record_review(pg_temp.id('t2'), pg_temp.id('erin'));
select app.transition_record(pg_temp.id('t2'), 'In Review', 'Active', 'Back to it.');
select throws_ok(format('select app.request_record_review(%L)', pg_temp.id('t2')),
  'XR001', 'record_review_open: A review of this record is still open; wait for its decision.', 'one open review at a time');
select throws_ok(format('select app.request_record_review(%L)', pg_temp.id('ap3')),
  'XR001', 'record_review_kind: An approval is decided, not reviewed.', 'an Approval record is not reviewed');

-- An Approval record that asks for a review is completed by its decision, never by hand.
select pg_temp.as_user('erin');
select throws_ok(format($$select app.transition_record(%L, 'Active', 'Complete', 'Done.')$$, pg_temp.id('ap3')),
  'XR001', 'record_review_undecided: Decide the review before completing it.', 'an undecided review is not completed by hand');
select pg_temp.as_user('carol');

-- A subject in another project. dave writes prj_a only, and carol writes both.
with x as (insert into app.records (project_id, record_kind, record_subtype, title, xyz, xyz_basis)
  values (pg_temp.id('prj_a2'), 'Task', 'Execute', 'Winter gala secret seating', 'Y', 'Declared') returning id)
  insert into world select 'foreign', id from x;
select app.transition_record(pg_temp.id('foreign'), 'Proposed', 'Ready', 'Ready.');
select app.transition_record(pg_temp.id('foreign'), 'Ready', 'Active', 'Started.');
select pg_temp.as_user('dave');
with r as (insert into app.records (project_id, record_kind, title, xyz, xyz_basis, owner_party_id)
  values (pg_temp.id('prj_a'), 'Approval', 'Review of another project', 'Y', 'Declared', pg_temp.id('erin'))
  returning id) insert into world select 'ap_foreign', id from r;
insert into app.record_approval (record_id, subject_record_id, requester_person_id)
  values (pg_temp.id('ap_foreign'), pg_temp.id('foreign'), pg_temp.id('dave'));
select app.transition_record(pg_temp.id('ap_foreign'), 'Proposed', 'Ready', 'Ready.');
select app.transition_record(pg_temp.id('ap_foreign'), 'Ready', 'Active', 'Started.');
select pg_temp.as_platform();
select private.notify(pg_temp.id('org_a'), pg_temp.id('erin'), 'approval.requested', 'app.records', pg_temp.id('ap_foreign'),
  pg_temp.id('prj_a'), jsonb_build_object('title', 'x', 'recordKey', 'x', 'actorName', 'x'));
insert into world select 'n_foreign', n.id from app.notifications n
  where n.subject_id = pg_temp.id('ap_foreign') and n.kind = 'approval.requested';
select pg_temp.as_user('erin');
select throws_ok(format($$select app.decide_record_review(%L, 'Rejected', 'Change the seating.')$$, pg_temp.id('ap_foreign')),
  '42501', 'work.record.write is required on the project', 'a review of a record in another project is not decided');
select throws_ok(format($$select app.act_on_notification(%L, 'approve')$$, pg_temp.id('n_foreign')),
  '42501', 'work.record.write is required on the project', 'nor from Inbox');
select pg_temp.as_platform();
select is((select record_state from app.records where id = pg_temp.id('foreign')), 'Active', 'the foreign record has not moved');
select is((select count(*)::integer from app.notifications where subject_id = pg_temp.id('ap_foreign') and kind = 'approval.decided'), 0,
  'and its title was sent to nobody');
select pg_temp.as_user('carol');
select lives_ok(format($$insert into world select 'ap_b', app.request_record_review(%L, %L, 'Seating done.')$$, pg_temp.id('foreign'), pg_temp.id('bob')),
  'another project''s undecided Approval does not hold a review open');

-- Who may be asked follows who may decide.
select pg_temp.as_platform();
insert into app.roles (org_id, code, name, band) values (pg_temp.id('org_a'), 'record_writer', 'Record Writer', 5);
insert into app.role_capabilities (role_id, capability_code, reach)
  select r.id, 'work.record.write', 'organization' from app.roles r where r.code = 'record_writer';
delete from app.membership_roles where membership_id = pg_temp.id('gina@org_a');
insert into app.membership_roles (membership_id, role_id)
  select pg_temp.id('gina@org_a'), r.id from app.roles r where r.code = 'record_writer';
select pg_temp.as_user('carol');
select pg_temp.new_record('t8', 'Walk the egress routes');
select pg_temp.start('t8');
select throws_ok(format('select app.request_record_review(%L, %L)', pg_temp.id('t8'), pg_temp.id('gina')),
  'XR001', 'approval_not_eligible: Only a person who may write the project''s records decides its approvals.',
  'organization reach alone, on a project the person is not on, without projects.members.manage, is refused');
select pg_temp.as_user('gina');
select throws_ok(format('select app.eligible_record_reviewers(%L)', pg_temp.id('t8')),
  '42501', 'work.record.write is required on the project', 'nor may that person list reviewers');
select pg_temp.as_user('alice');
insert into app.user_capability_grants (membership_id, capability_code, scope_kind, scope_id, reason)
  values (pg_temp.id('mia@org_a'), 'work.record.write', 'project', pg_temp.id('prj_a'), 'Covering the egress walk.');
select pg_temp.as_user('carol');
select ok((select pg_temp.id('mia') in (select app.eligible_record_reviewers(pg_temp.id('t8')))), 'a project-grant holder is offered');
select ok((select pg_temp.id('erin') in (select app.eligible_record_reviewers(pg_temp.id('t8')))), 'and so is a project member who writes records');
select ok((select pg_temp.id('gina') not in (select app.eligible_record_reviewers(pg_temp.id('t8')))), 'the org-reach non-member is not');
select ok((select pg_temp.id('carol') not in (select app.eligible_record_reviewers(pg_temp.id('t8')))), 'nor is the caller');
select lives_ok(format($$update app.records set owner_party_id = %L where id = %L$$, pg_temp.id('dave'), pg_temp.id('t8')), 'dave owns it');
select ok((select pg_temp.id('dave') not in (select app.eligible_record_reviewers(pg_temp.id('t8')))), 'nor is the owner');
select lives_ok(format($$insert into world select 'ap8', app.request_record_review(%L, %L, 'Walked.')$$, pg_temp.id('t8'), pg_temp.id('mia')),
  'a project-grant holder is accepted at request');
select pg_temp.as_user('mia');
select lives_ok(format($$select app.decide_record_review(%L, 'Approved')$$, pg_temp.id('ap8')), 'and is able to decide');

-- An Approval record never carries the flag.
select pg_temp.as_user('carol');
select throws_ok(format('update app.records set requires_review = true where id = %L', pg_temp.id('ap8')),
  '23514', null, 'an Approval record cannot require review');
select lives_ok(format('update app.records set title = title where id = %L', pg_temp.id('ap8')), 'the constraint leaves it otherwise alone');

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
select throws_ok(format($$insert into app.template_items (template_version_id, item_kind, sort_order, name, record_kind, xyz, requires_review)
  values (%L, 'Record', 1, 'Approve the plan', 'Approval', 'Y', true)$$, pg_temp.id('tv')), '23514', null,
  'a Template Record item of kind Approval never requires review');
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

-- A review under way is this project's work, not its plan; an Approval made on purpose is still a plan item.
insert into app.records (project_id, record_kind, title, xyz, xyz_basis)
  values (pg_temp.id('prj_t'), 'Approval', 'Review of NWR-1', 'Y', 'Declared');
insert into app.record_approval (record_id, subject_record_id, requester_person_id)
  select r.id, (select s.id from app.records s where s.project_id = pg_temp.id('prj_t') and s.record_kind = 'Task' limit 1), pg_temp.id('carol')
  from app.records r where r.project_id = pg_temp.id('prj_t') and r.title = 'Review of NWR-1';
insert into app.records (project_id, record_kind, title, xyz, xyz_basis)
  values (pg_temp.id('prj_t'), 'Approval', 'Sign off the budget', 'Y', 'Declared');
insert into world select 'tpl3', app.create_template_from_project(pg_temp.id('prj_t'), 'Reviewed Plan Once More');
select is((select array_agg(i.name order by i.name) from app.template_items i join app.templates t on t.current_version_id = i.template_version_id
           where t.id = pg_temp.id('tpl3') and i.item_kind = 'Record' and i.record_kind = 'Approval'), array['Sign off the budget'],
  'saving a project as a template leaves out the Approval records of open reviews');

select * from finish();
rollback;

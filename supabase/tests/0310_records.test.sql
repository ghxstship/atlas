-- pgTAP: record spine (Section 3.10, Section 7.4). Same-tenant allow, cross-tenant deny, anon deny,
-- role bands, invariant 2 (records readable by project members and assigned people, not the org),
-- the kind-scoped subtype key, title grammar, the nine-state machine (every rule allowed and a
-- representative set refused), Blocked and Deferred rules, retention of Canceled records, the replan
-- log from Scheduled onward, checklist ticks, dependencies, kind extensions and Approval (invariant 18).
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(91);

create function pg_temp.new_record(p_project text, p_kind text, p_title text, p_subtype text default null) returns uuid
language plpgsql as $$
declare v uuid;
begin
  insert into app.records (project_id, record_kind, record_subtype, title, xyz, xyz_basis)
  values (pg_temp.id(p_project), p_kind, p_subtype, p_title, 'Y', 'Declared') returning id into v;
  return v;
end $$;

create function pg_temp.grammar(p_kind text, p_title text) returns text
language plpgsql as $$
begin
  perform pg_temp.new_record('prj_a', p_kind, p_title);
  return 'accepted';
exception when sqlstate 'XR001' then
  return sqlerrm;
end $$;

create function pg_temp.state(p_key text) returns text
language sql as $$ select record_state from app.records where id = pg_temp.id(p_key) $$;

-- Creation, keys and the kind-scoped subtype --------------------------------------------------------
select pg_temp.as_user('dave');
insert into world values ('task1', pg_temp.new_record('prj_a', 'Task', 'Install the truss', 'Execute'));
insert into world values ('task2', pg_temp.new_record('prj_a', 'Task', 'Verify the rigging plan', 'Verify'));
select is((select app.record_display_key(r) from app.records r where r.id = pg_temp.id('task1')), 'NWL-1', 'the first record of the project is NWL-1');
select is((select app.record_display_key(r) from app.records r where r.id = pg_temp.id('task2')), 'NWL-2', 'the next record is NWL-2');
select is((select app.record_class(r) from app.records r where r.id = pg_temp.id('task1')), 'Work', 'the record class is derived from the kind');
select is((select record_state from app.records where id = pg_temp.id('task1')), 'Proposed', 'a new record is Proposed');
select throws_ok($$select pg_temp.new_record('prj_a', 'Task', 'Book the crew', 'Crew')$$, '23503', null, 'a Booking subtype cannot be stored on a Task');
select throws_ok($$insert into app.records (project_id, record_kind, title, xyz, xyz_basis, record_state) values ((select id from world where key = 'prj_a'), 'Task', 'Hang the banner', 'Y', 'Declared', 'Active')$$,
  'XR001', null, 'a record starts Proposed');
select throws_ok($$update app.records set record_number = 99 where id = (select id from world where key = 'task1')$$, 'XR001', null, 'a record keeps its number');
select throws_ok($$update app.records set record_kind = 'Build' where id = (select id from world where key = 'task1')$$, 'XR001', null, 'a record keeps its kind');
select throws_ok($$insert into app.records (project_id, scope_node_id, record_kind, title, xyz, xyz_basis) values ((select id from world where key = 'prj_a'), (select id from world where key = 'root_a2'), 'Task', 'Hang the banner', 'Y', 'Declared')$$,
  'XR001', null, 'a record''s scope node belongs to its project');
select throws_ok($$insert into app.records (project_id, record_kind, title, xyz, xyz_basis, urid) values ((select id from world where key = 'prj_a'), 'Task', 'Hang the banner', 'Z', 'Category', '0000.01.01')$$,
  'XR001', null, 'an XYZ tag with basis Category must equal the category''s tag');
select lives_ok($$insert into app.records (project_id, record_kind, title, xyz, xyz_basis, urid) values ((select id from world where key = 'prj_a'), 'Task', 'Hang the banner', 'X', 'Category', '0000.01.01')$$,
  'an XYZ tag inherited from the category is accepted');

-- Title grammar ---------------------------------------------------------------------------------------------
select is(pg_temp.grammar('Task', 'Installing the truss'), 'record_title_grammar: A Task title starts with an imperative verb, not "Installing": write the command form, for example "Install" rather than "Installing".', 'a gerund is refused with a correction');
select is(pg_temp.grammar('Build', 'The stage deck'), 'record_title_grammar: A Build title starts with an imperative verb, for example "Install the truss"; "The" is not a verb.', 'an article is not an imperative verb');
select is(pg_temp.grammar('Payment', 'Transferred the deposit'), 'record_title_grammar: A Payment title starts with an imperative verb, not the past tense "Transferred": write the command form, for example "Install" rather than "Installed".', 'the past tense is refused');
select is(pg_temp.grammar('Risk', 'The generator will fail'), 'record_title_grammar: A Risk title is a noun phrase naming the thing, not a sentence describing it; for example "Rigging Plan" rather than "The rigging plan is late".', 'a Risk names the exposure, not a sentence');
select is(pg_temp.grammar('Risk', 'Generator Failure'), 'accepted', 'a Risk noun phrase is accepted');
select is(pg_temp.grammar('Milestone', 'Stage almost ready'), 'record_title_grammar: A Milestone title states the result as already true, for example "Permits Approved" or "Stage Load-In Complete".', 'a Milestone states a completed condition');
select is(pg_temp.grammar('Milestone', 'Stage Load-In Complete'), 'accepted', 'a completed-state Milestone is accepted');
select is(pg_temp.grammar('Goal', 'Sell-Through Achieved'), 'accepted', 'an achieved-state Goal is accepted');
select is(pg_temp.grammar('Event', 'Opening night on the Pier'), 'record_title_grammar: A Event title is a proper title in Title Case; capitalize "night".', 'an Event is a proper title in Title Case');
select is(pg_temp.grammar('Event', 'Opening Night on the Pier'), 'accepted', 'a Title Case Event is accepted');
select is(pg_temp.grammar('Shift', 'Stagehand load-in'), 'record_title_grammar: A Shift title is written role · block, for example "Stagehand · Load-in".', 'a Shift is written role · block');
select is(pg_temp.grammar('Shift', 'Stagehand · Load-in'), 'accepted', 'a role · block Shift is accepted');
select is(pg_temp.grammar('Document', 'Rigging Plan.'), 'record_title_grammar: A Document title is not a sentence; remove the closing punctuation.', 'titles carry no closing punctuation');
select is(pg_temp.grammar('Document', 'Rigging ' || chr(8212) || ' Plan'), 'record_title_grammar: Titles never contain an em dash; use a comma, a colon or the word and.', 'titles refuse the em dash');
select throws_ok($$update app.records set title = 'Installing the truss' where id = (select id from world where key = 'task1')$$, 'XR001', null, 'the grammar is checked on update too');

-- Same-tenant allow, cross-tenant deny, anon deny, invariant 2 ------------------------------------------------
select pg_temp.as_user('carol');
insert into world values ('gala1', pg_temp.new_record('prj_a2', 'Meeting', 'Gala Planning Session'));
select ok((select count(*) from app.records where project_id = pg_temp.id('prj_a')) >= 3, 'a Manager reads records of every project (oversight)');
select pg_temp.as_user('dave');
select is((select count(*)::int from app.records where project_id = pg_temp.id('prj_a2')), 0, 'a Member reads no records of a project they are not in (invariant 2)');
select ok((select count(*) from app.records where project_id = pg_temp.id('prj_a')) >= 3, 'a Member reads the records of their project');
select pg_temp.as_user('frank');
select ok((select count(*) from app.records where project_id = pg_temp.id('prj_a')) >= 3, 'a Field project member reads the project''s records');
select pg_temp.as_user('gina');
select is((select count(*)::int from app.records), 0, 'a Viewer in no project reads no records, not the whole org');
select pg_temp.as_user('mia');
select is((select count(*)::int from app.records), 0, 'mia reads no records before assignment');
select pg_temp.as_user('carol');
select lives_ok($$insert into app.record_assignments (record_id, membership_id) values ((select id from world where key = 'gala1'), (select id from world where key = 'mia@org_a'))$$, 'a Manager assigns mia to a record');
select pg_temp.as_user('mia');
select is((select array_agg(id) from app.records), array[pg_temp.id('gala1')], 'an assigned person reads exactly the record assigned to them (invariant 2)');
select is((select array_agg(id) from app.projects), array[pg_temp.id('prj_a2')], 'and the header of its project');
select pg_temp.as_user('xavier');
select is((select count(*)::int from app.records where org_id = pg_temp.id('org_a')), 0, 'another org reads no records');
select is((select count(*)::int from app.record_state_transitions where org_id = pg_temp.id('org_a')), 0, 'nor their state ledger');
select pg_temp.as_anon();
select throws_ok('select 1 from app.records', '42501', null, 'anon cannot read records');
select throws_ok('select 1 from app.record_task', '42501', null, 'anon cannot read record extensions');
select pg_temp.as_user('gina');
select throws_ok($$select pg_temp.new_record('prj_a', 'Task', 'Sweep the deck')$$, '42501', null, 'a Viewer cannot create records');
select pg_temp.as_user('erin');
select lives_ok($$select pg_temp.new_record('prj_a', 'Task', 'Sweep the deck')$$, 'a Collaborator who is a project member creates records there');
select throws_ok($$select pg_temp.new_record('prj_a2', 'Task', 'Sweep the stage')$$, '42501', null, 'but not in another project');
select pg_temp.as_platform();

-- State machine ---------------------------------------------------------------------------------------------------------
select is((select count(*)::int from private.lifecycle_transition_rules where lifecycle = 'record'), 33, 'the record lifecycle declares 33 moves');
select ok(not exists (select 1 from private.lifecycle_transition_rules where lifecycle = 'record' and from_state = 'Canceled'), 'Canceled is terminal');
select ok(not exists (select 1 from private.lifecycle_transition_rules r where r.lifecycle = 'record'
  and (r.from_state not in (select record_state from xpms.dim_record_state) or r.to_state not in (select record_state from xpms.dim_record_state))),
  'every rule names canon record states');

select pg_temp.as_user('dave');
update app.records set starts_at = '2027-06-01 08:00+00', ends_at = '2027-06-01 18:00+00' where id = pg_temp.id('task1');
update app.records set starts_at = '2027-06-02 08:00+00', ends_at = '2027-06-02 18:00+00' where id = pg_temp.id('task1');
select is((select count(*)::int from app.record_replans where record_id = pg_temp.id('task1')), 0, 'edits while Proposed overwrite with no replan entry');
select throws_ok($$update app.records set record_state = 'Scheduled' where id = (select id from world where key = 'task1')$$, 'XR001', null, 'the record state changes only through its RPC');
select throws_ok($$select app.transition_record((select id from world where key = 'task1'), 'Proposed', 'Complete', 'Done.')$$,
  'XR001', 'record_transition_not_allowed: A record cannot move from Proposed to Complete.', 'Proposed cannot jump to Complete');
select lives_ok($$select app.transition_record((select id from world where key = 'task1'), 'Proposed', 'Scheduled', 'Crew booked.')$$, 'Proposed to Scheduled');
select is((select count(*)::int from app.record_replans where record_id = pg_temp.id('task1')), 0, 'leaving Proposed is not a replan');
update app.records set starts_at = '2027-06-03 08:00+00', ends_at = '2027-06-03 18:00+00', replan_reason = 'Venue access moved.' where id = pg_temp.id('task1');
select is((select count(*)::int from app.record_replans where record_id = pg_temp.id('task1')), 1, 'a date change while Scheduled is a logged replan');
select is((select reason from app.record_replans where record_id = pg_temp.id('task1')), 'Venue access moved.', 'the replan keeps its reason');
select throws_ok($$select app.transition_record((select id from world where key = 'task1'), 'Scheduled', 'Blocked', 'Stuck.')$$,
  'XR001', 'record_blocker_required: A Blocked record names its blocker.', 'Blocked needs a blocker');
select lives_ok($$select app.transition_record((select id from world where key = 'task1'), 'Scheduled', 'Blocked', 'Stuck.', 'Truss delivery late.')$$, 'Scheduled to Blocked with a blocker');
select is((select blocker_text from app.records where id = pg_temp.id('task1')), 'Truss delivery late.', 'the blocker is recorded');
select throws_ok($$update app.records set blocker_text = null where id = (select id from world where key = 'task1')$$, '23514', null, 'a Blocked record cannot lose its blocker');
select lives_ok($$select app.transition_record((select id from world where key = 'task1'), 'Blocked', 'Active', 'Truss arrived.')$$, 'Blocked to Active');
select is((select blocker_text from app.records where id = pg_temp.id('task1')), null, 'leaving Blocked clears the blocker');
select throws_ok($$select app.transition_record((select id from world where key = 'task1'), 'Active', 'Deferred', 'Later.')$$,
  'XR001', 'record_replan_reason_required: A Deferred record carries a replan reason.', 'Deferred needs a replan reason');
select lives_ok($$select app.transition_record((select id from world where key = 'task1'), 'Active', 'In Review', 'Ready for sign-off.')$$, 'Active to In Review');
select lives_ok($$select app.transition_record((select id from world where key = 'task1'), 'In Review', 'Active', 'Rework needed.')$$, 'In Review back to Active');
select lives_ok($$select app.transition_record((select id from world where key = 'task1'), 'Active', 'Deferred', 'Moved.', null, 'Moved to the second weekend.')$$, 'Active to Deferred with a reason');
select lives_ok($$select app.transition_record((select id from world where key = 'task1'), 'Deferred', 'Canceled', 'Dropped from scope.')$$, 'Deferred to Canceled');
select throws_ok($$select app.transition_record((select id from world where key = 'task1'), 'Canceled', 'Active', 'Revive.')$$, 'XR001', 'record_transition_not_allowed: A record cannot move from Canceled to Active.', 'Canceled is terminal');
select throws_ok($$select app.transition_record((select id from world where key = 'task2'), 'Active', 'Complete', 'Stale.')$$, 'XR001', null, 'a stale expected state is refused (compare-and-set)');
select is((select count(*)::int from app.record_state_transitions where record_id = pg_temp.id('task1')), 8, 'the ledger holds the creation entry and seven moves');
select is((select count(*)::int from app.record_replans where record_id = pg_temp.id('task1')), 7, 'every state change from Scheduled onward is also a logged replan');
select throws_ok($$update app.records set deleted_at = now() where id = (select id from world where key = 'task1')$$, 'XR001', 'record_retained: Canceled records are retained, never deleted.', 'a Canceled record cannot be trashed');
select lives_ok($$update app.records set deleted_at = now() where id = (select id from world where key = 'task2')$$, 'a record that is not Canceled can be trashed');
select pg_temp.as_platform();
select throws_ok($$delete from app.records where id = (select id from world where key = 'task1')$$, 'XR001', null, 'a Canceled record cannot be deleted even by the platform');
select throws_ok($$update app.record_replans set reason = 'x'$$, 'XR001', null, 'the replan log is append-only');
select is((select count(*)::int from app.domain_events where event_type = 'record.state_changed' and subject_id = pg_temp.id('task1')), 7, 'each move emitted record.state_changed about the record');
select is((select count(*)::int from app.domain_events where event_type = 'record.created' and project_id = pg_temp.id('prj_a')), (select count(*)::int from app.records where project_id = pg_temp.id('prj_a')), 'each new record emitted record.created');

-- Checklist, dependencies, extensions ----------------------------------------------------------------------------------
select pg_temp.as_user('dave');
insert into world values ('task3', pg_temp.new_record('prj_a', 'Task', 'Rig the lighting truss'));
insert into world values ('task4', pg_temp.new_record('prj_a', 'Task', 'Focus the lights'));
insert into app.record_checklist_items (record_id, position, label) values (pg_temp.id('task3'), 1, 'Check the shackles'), (pg_temp.id('task3'), 2, 'Check the slings');
update app.record_checklist_items set checked_at = '2000-01-01' where record_id = pg_temp.id('task3') and position = 2;
select is((select checked_by from app.record_checklist_items where record_id = pg_temp.id('task3') and position = 2), pg_temp.id('dave'), 'a tick is stamped with the session person');
select is((select count(*)::int from app.record_checklist_items where record_id = pg_temp.id('task3') and checked_at is not null), 1, 'the tick lands only on the item it names');
select throws_ok($$update app.record_checklist_items set record_id = (select id from world where key = 'task4') where position = 1$$, 'XR001', null, 'a checklist item stays on its record');
insert into app.record_dependencies (predecessor_record_id, successor_record_id) values (pg_temp.id('task3'), pg_temp.id('task4'));
select throws_ok($$insert into app.record_dependencies (predecessor_record_id, successor_record_id) values ((select id from world where key = 'task4'), (select id from world where key = 'task3'))$$,
  'XR001', 'dependency_cycle: This dependency would make the schedule circular.', 'a dependency cycle is refused');
select lives_ok($$insert into app.record_task (record_id, progress_pct) values ((select id from world where key = 'task3'), 40)$$, 'a Task record takes a Task extension');
insert into world values ('ms1', pg_temp.new_record('prj_a', 'Milestone', 'Truss Rigged'));
select throws_ok($$insert into app.record_task (record_id) values ((select id from world where key = 'ms1'))$$, '23503', null, 'a Task extension cannot attach to a Milestone');
select throws_ok($$insert into app.record_task (record_id, record_kind) values ((select id from world where key = 'ms1'), 'Milestone')$$, '23514', null, 'and cannot claim another kind');
insert into world values ('insp1', pg_temp.new_record('prj_a', 'Inspection', 'Rigging Safety Check'));
select throws_ok($$insert into app.record_inspection (record_id, result_enum_id) values ((select id from world where key = 'insp1'), 'ENM-097')$$, 'XR001', null, 'an inspection result comes from the Inspection Result enumeration');
select lives_ok($$insert into app.record_inspection (record_id, result_enum_id) values ((select id from world where key = 'insp1'), 'ENM-082')$$, 'a Passed result is accepted');
select pg_temp.as_platform();

-- Approval (invariant 18) ---------------------------------------------------------------------------------------------------
select pg_temp.as_user('dave');
insert into world values ('appr1', pg_temp.new_record('prj_a', 'Approval', 'Lighting Plot'));
insert into app.record_approval (record_id, subject_record_id, requester_person_id) values (pg_temp.id('appr1'), pg_temp.id('task3'), pg_temp.id('dave'));
select throws_ok($$update app.record_approval set decision = 'Approved' where record_id = (select id from world where key = 'appr1')$$,
  'XR001', 'sod_approval_requester: An approval is decided by an eligible approver, never the requester.', 'inv_18_eligible_approver: the requester cannot approve (invariant 18)');
select pg_temp.as_user('alice');
select lives_ok($$update app.record_approval set decision = 'Approved' where record_id = (select id from world where key = 'appr1')$$, 'another eligible person approves');
select is((select approver_person_id from app.record_approval where record_id = pg_temp.id('appr1')), pg_temp.id('alice'), 'the approver is the session person');
select throws_ok($$update app.record_approval set decision = 'Rejected' where record_id = (select id from world where key = 'appr1')$$, 'XR001', null, 'a decision is final');
select pg_temp.as_platform();

-- Scope helpers for records ------------------------------------------------------------------------------------------------
select is(private.scope_org('record', pg_temp.id('gala1')), pg_temp.id('org_a'), 'scope_org resolves a record');
select pg_temp.claims('mia');
select ok(private.is_assigned_to_scope(pg_temp.id('org_a'), pg_temp.id('gala1')), 'an assignee is assigned to the record scope');
select ok(not private.is_assigned_to_scope(pg_temp.id('org_a'), pg_temp.id('task3')), 'but not to records of a project they are not in');
select pg_temp.as_user('gina');
select throws_ok($$insert into app.record_watchers (record_id, person_id) values ((select id from world where key = 'task3'), (select id from world where key = 'gina'))$$,
  '42501', null, 'a person cannot watch a record they cannot read');
select pg_temp.as_user('frank');
select lives_ok($$insert into app.record_watchers (record_id, person_id) values ((select id from world where key = 'task3'), (select id from world where key = 'frank'))$$,
  'a project member watches a record');
select pg_temp.as_platform();

select * from finish();
rollback;

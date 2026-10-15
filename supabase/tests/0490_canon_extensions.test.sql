-- pgTAP: canon extension proposals and the A16 audit trail (Section 7.2, Section 4.5.9, Section 8.2).
-- Same-tenant allow, cross-tenant deny, anon deny, role bands (Owner and Admin extend, Manager reads,
-- Field sees nothing), the .50 to .99 range, codes already canon, parents, the lifecycle with every
-- allowed and refused move, sod_approval_requester, frozen decisions, events and audit rows.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(41);

select ok((select relrowsecurity from pg_class where oid = 'app.canon_extension_proposals'::regclass), 'proposals have row level security');
select is((select count(*)::int from app.lifecycle_transition_rules where lifecycle = 'canon_extension'), 3, 'the canon extension lifecycle declares three moves');

-- Proposing ------------------------------------------------------------------------------------------------
select pg_temp.as_user('bob');
with x as (insert into app.canon_extension_proposals (org_id, extension_level, parent_code, proposed_code, label, rationale)
  values (pg_temp.id('org_a'), 'Discipline', '1000', '1000.90', 'Drone Light Shows', 'We run drone shows at most events.') returning id)
  insert into world select 'disc', id from x;
select is((select proposal_state::text from app.canon_extension_proposals where id = pg_temp.id('disc')), 'Proposed', 'a proposal starts Proposed');
select is((select count(*)::int from app.canon_extension_state_transitions where canon_extension_proposal_id = pg_temp.id('disc')), 1, 'creation writes the ledger entry');
select is((select count(*)::int from app.domain_events where subject_id = pg_temp.id('disc') and event_type = 'canon_extension.proposed'), 1, 'proposing emits canon_extension.proposed');
select ok(exists (select 1 from app.audit_events where subject_id = pg_temp.id('disc')), 'proposing writes an audit event');

select throws_ok($$insert into app.canon_extension_proposals (org_id, extension_level, parent_code, proposed_code, label, rationale)
  values ((select id from world where key = 'org_a'), 'Discipline', '1000', '1000.10', 'Inside Canon', 'Reason.')$$,
  '23514', null, 'a code outside .50 to .99 is refused');
select throws_ok($$insert into app.canon_extension_proposals (org_id, extension_level, parent_code, proposed_code, label, rationale)
  values ((select id from world where key = 'org_a'), 'Discipline', '1000', '1000.50', 'Already Canon', 'Reason.')$$,
  'XR001', 'canon_extension_exists: The code is already canon; propose another code in .50 to .99.', 'a code already in canon is refused');
select throws_ok($$insert into app.canon_extension_proposals (org_id, extension_level, parent_code, proposed_code, label, rationale)
  values ((select id from world where key = 'org_a'), 'Discipline', '2000', '1000.91', 'Wrong Parent', 'Reason.')$$,
  '23514', null, 'a code outside its parent is refused');
select throws_ok($$insert into app.canon_extension_proposals (org_id, extension_level, parent_code, proposed_code, label, rationale)
  values ((select id from world where key = 'org_a'), 'Discipline', '1000', '1000.90', 'Duplicate', 'Reason.')$$,
  '23505', null, 'an open proposal holds its code');
select throws_ok($$insert into app.canon_extension_proposals (org_id, extension_level, parent_code, proposed_code, label, rationale)
  values ((select id from world where key = 'org_a'), 'Category', '1000.90', '1000.90.01', 'Early Child', 'Reason.')$$,
  'XR001', null, 'a category cannot sit under a discipline that is not yet approved');
select throws_ok($$insert into app.canon_extension_proposals (org_id, extension_level, parent_code, proposed_code, label, rationale)
  values ((select id from world where key = 'org_a'), 'Discipline', '1000', '1000.92', 'Bad ' || chr(8212) || ' Label', 'Reason.')$$,
  '23514', null, 'an em dash is refused');
select throws_ok($$insert into app.canon_extension_proposals (org_id, extension_level, parent_code, proposed_code, label, rationale, decided_by, decided_at)
  values ((select id from world where key = 'org_a'), 'Discipline', '1000', '1000.93', 'Self Decided', 'Reason.', (select id from world where key = 'bob'), now())$$,
  'XR001', null, 'a proposal is never inserted decided');
select throws_ok($$update app.canon_extension_proposals set proposal_state = 'Approved' where id = (select id from world where key = 'disc')$$,
  'XR001', null, 'the state changes only through the RPC');
select throws_ok($$update app.canon_extension_proposals set proposed_code = '1000.94' where id = (select id from world where key = 'disc')$$,
  'XR001', null, 'the code is fixed');
select lives_ok($$update app.canon_extension_proposals set label = 'Drone Shows' where id = (select id from world where key = 'disc')$$,
  'the label is editable while Proposed');

-- Role bands --------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
select is((select count(*)::int from app.canon_extension_proposals where org_id = pg_temp.id('org_a')), 1, 'a Manager reads proposals');
select throws_ok($$insert into app.canon_extension_proposals (org_id, extension_level, parent_code, proposed_code, label, rationale)
  values ((select id from world where key = 'org_a'), 'Discipline', '1000', '1000.95', 'Manager Idea', 'Reason.')$$,
  '42501', null, 'a Manager cannot propose');
select throws_ok($$select app.decide_canon_extension((select id from world where key = 'disc'), 'Proposed', 'Approved', 'Fine.')$$,
  '42501', null, 'a Manager cannot decide');
select pg_temp.as_user('frank');
select is((select count(*)::int from app.canon_extension_proposals), 0, 'Field reads no proposals');
select pg_temp.as_user('gina');
select is((select count(*)::int from app.canon_extension_proposals), 1, 'a Viewer reads proposals');
select pg_temp.as_user('xavier');
select is((select count(*)::int from app.canon_extension_proposals where org_id = pg_temp.id('org_a')), 0, 'another org reads no proposals');
select throws_ok($$select app.decide_canon_extension((select id from world where key = 'disc'), 'Proposed', 'Approved', 'x')$$,
  '42501', null, 'another org cannot decide');
select pg_temp.as_anon();
select throws_ok('select 1 from app.canon_extension_proposals', '42501', null, 'anon cannot read proposals');
select throws_ok($$select app.decide_canon_extension(gen_random_uuid(), 'Proposed', 'Approved', 'x')$$, '42501', null, 'anon cannot decide');

-- Deciding --------------------------------------------------------------------------------------------------------
select pg_temp.as_user('bob');
select throws_ok($$select app.decide_canon_extension((select id from world where key = 'disc'), 'Proposed', 'Approved', 'Mine.')$$,
  'XR001', null, 'the proposer cannot approve (sod_approval_requester)');
select throws_ok($$select app.decide_canon_extension((select id from world where key = 'disc'), 'Proposed', 'Rejected', 'Mine.')$$,
  'XR001', null, 'the proposer cannot reject');
select pg_temp.as_user('alice');
select throws_ok($$select app.decide_canon_extension((select id from world where key = 'disc'), 'Approved', 'Rejected', 'Stale.')$$,
  'XR001', null, 'compare-and-set refuses a stale expected state');
select lives_ok($$select app.decide_canon_extension((select id from world where key = 'disc'), 'Proposed', 'Approved', 'Core service.')$$,
  'another Owner approves');
select is((select proposal_state::text from app.canon_extension_proposals where id = pg_temp.id('disc')), 'Approved', 'the proposal is Approved');
select is((select decided_by from app.canon_extension_proposals where id = pg_temp.id('disc')), pg_temp.id('alice'), 'the decider is recorded');
select is((select count(*)::int from app.domain_events where subject_id = pg_temp.id('disc') and event_type = 'canon_extension.decided'), 1, 'deciding emits canon_extension.decided');
select throws_ok($$select app.decide_canon_extension((select id from world where key = 'disc'), 'Approved', 'Withdrawn', 'Undo.')$$,
  'XR001', null, 'an approved proposal cannot be withdrawn');
select throws_ok($$update app.canon_extension_proposals set label = 'Changed' where id = (select id from world where key = 'disc')$$,
  'XR001', null, 'a decided proposal never changes');
select throws_ok($$update app.canon_extension_proposals set decided_at = now() + interval '1 day' where id = (select id from world where key = 'disc')$$,
  'XR001', null, 'decision columns change only through the RPC');

-- Categories under the approved discipline, rejection and withdrawal ----------------------------------------------------
select pg_temp.as_user('bob');
with x as (insert into app.canon_extension_proposals (org_id, extension_level, parent_code, proposed_code, label, rationale)
  values (pg_temp.id('org_a'), 'Category', '1000.90', '1000.90.01', 'Drone Swarms', 'Large swarms.') returning id)
  insert into world select 'cat', id from x;
with x as (insert into app.canon_extension_proposals (org_id, extension_level, parent_code, proposed_code, label, rationale)
  values (pg_temp.id('org_a'), 'Category', '0000.01', '0000.01.60', 'Canon Parent Child', 'Under a canon discipline.') returning id)
  insert into world select 'cat2', id from x;
select is((select count(*)::int from app.canon_extension_proposals where id in (pg_temp.id('cat'), pg_temp.id('cat2'))), 2,
  'categories sit under an approved org discipline or a canon discipline');
select lives_ok($$select app.decide_canon_extension((select id from world where key = 'cat2'), 'Proposed', 'Withdrawn', 'Not needed.')$$,
  'the proposer withdraws');
select throws_ok($$select app.decide_canon_extension((select id from world where key = 'cat2'), 'Withdrawn', 'Proposed', 'Again.')$$,
  'XR001', null, 'a withdrawn proposal is final');
select is((select decided_by from app.canon_extension_proposals where id = pg_temp.id('cat2')), null::uuid, 'a withdrawal records no decider');
select pg_temp.as_user('alice');
select lives_ok($$select app.decide_canon_extension((select id from world where key = 'cat'), 'Proposed', 'Rejected', 'Covered elsewhere.')$$,
  'another Owner rejects');
select pg_temp.as_platform();
select is((select count(*)::int from xpms.dim_category where cat_urid in ('1000.90.01', '0000.01.60')), 0, 'canon is never written');

select * from finish();
rollback;

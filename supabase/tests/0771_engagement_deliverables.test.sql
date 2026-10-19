-- pgTAP: migration 0771, engagement deliverables (Section 4.4.4 Contractor). The Deliverable state machine (allowed and
-- refused moves), the party hands in and the org accepts or returns with a reason, separation of duties, record of the
-- same project, RLS (same tenant, cross tenant, anon, role band) and the external projection with the time box.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

select * from no_plan();

create function pg_temp.n(p_who text, p_sql text) returns integer
language plpgsql as $$
declare v integer;
begin
  perform pg_temp.as_user(p_who);
  execute 'select count(*)::int from (' || p_sql || ') x' into v;
  perform pg_temp.as_platform();
  return v;
end $$;

create function pg_temp.state(p_key text) returns text language sql as $$
  select deliverable_state::text from app.engagement_deliverables where id = pg_temp.id(p_key);
$$;

select pg_temp.move_engagement('eng_ivy_a', 'Onboarding', 'Active');
select pg_temp.as_user('alice');
with r as (insert into app.records (project_id, record_kind, title, xyz, xyz_basis) values (pg_temp.id('prj_a'), 'Document', 'Stage Plot', 'Y', 'Declared') returning id)
  insert into world select 'rec', id from r;
with r as (insert into app.records (project_id, record_kind, title, xyz, xyz_basis) values (pg_temp.id('prj_a2'), 'Document', 'Gala Plot', 'Y', 'Declared') returning id)
  insert into world select 'rec_other', id from r;
with d as (insert into app.documents (org_id, project_id, title) values (pg_temp.id('org_a'), pg_temp.id('prj_a'), 'Stage Plot v1') returning id)
  insert into world select 'doc', id from d;
select pg_temp.as_platform();

-- Adding -----------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('gina');
select throws_ok(format($$select app.add_engagement_deliverable('%s', '%s')$$, pg_temp.id('eng_ivy_a'), pg_temp.id('rec')), '42501', null, 'role band: a Viewer cannot add');
select pg_temp.as_user('xavier');
select throws_ok(format($$select app.add_engagement_deliverable('%s', '%s')$$, pg_temp.id('eng_ivy_a'), pg_temp.id('rec')), '42501', null, 'cross tenant: another org cannot add');
select pg_temp.as_user('carol');
select throws_ok(format($$select app.add_engagement_deliverable('%s', '%s')$$, pg_temp.id('eng_ivy_a'), pg_temp.id('rec_other')), 'XR001', null,
  'a deliverable is a record of the engagement''s project');
with d as (select app.add_engagement_deliverable(pg_temp.id('eng_ivy_a'), pg_temp.id('rec')) as id) insert into world select 'dlv', id from d;
select throws_ok(format($$select app.add_engagement_deliverable('%s', '%s')$$, pg_temp.id('eng_ivy_a'), pg_temp.id('rec')), '23505', null, 'a record is owed once per engagement');
select throws_ok(format($$select app.decide_deliverable('%s', 'Approved', null)$$, pg_temp.id('dlv')), 'XR001', 'deliverable_state_conflict: The deliverable is not in the expected state Submitted.', 'Open cannot jump to Accepted');
select pg_temp.as_platform();
select is(pg_temp.state('dlv'), 'Open', 'a new deliverable is Open');

-- Handing in ---------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('quinn');
select throws_ok(format($$select app.submit_deliverable('%s', null, 'Not mine.')$$, pg_temp.id('dlv')), '42501', null, 'another party cannot hand it in');
select pg_temp.as_user('ivy');
select is((select count(*)::int from api_external.deliverables where deliverable_state = 'Open'), 1, 'own engagement: the party sees what is owed');
select lives_ok(format($$select app.submit_deliverable('%s', '%s', 'First pass of the plot.')$$, pg_temp.id('dlv'), pg_temp.id('doc')), 'the party hands it in');
select throws_ok(format($$select app.submit_deliverable('%s', null, 'Again.')$$, pg_temp.id('dlv')), 'XR001', 'deliverable_transition_not_allowed: A deliverable cannot move from Submitted to Submitted.', 'Submitted cannot be handed in again until returned');
select pg_temp.as_platform();
select is(pg_temp.state('dlv'), 'Submitted', 'the deliverable is Submitted');
select is((select submitted_by from app.engagement_deliverables where id = pg_temp.id('dlv')), pg_temp.id('ivy'), 'the submitter comes from the session');

-- Deciding ----------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
select throws_ok(format($$select app.decide_deliverable('%s', 'Rejected', ' ')$$, pg_temp.id('dlv')), 'XR001', null, 'a return says why');
select lives_ok(format($$select app.decide_deliverable('%s', 'Rejected', 'Add the trim heights.')$$, pg_temp.id('dlv')), 'the org returns it');
select pg_temp.as_platform();
select is(pg_temp.state('dlv'), 'Returned', 'the deliverable is Returned');
select pg_temp.as_user('ivy');
select is((select return_reason from api_external.deliverables), 'Add the trim heights.', 'the party reads why');
select lives_ok(format($$select app.submit_deliverable('%s', null, 'Trim heights added.')$$, pg_temp.id('dlv')), 'the party hands it in again');
select is((select return_reason from api_external.deliverables), null, 'the return reason clears on resubmission');
select pg_temp.as_user('carol');
select lives_ok(format($$select app.decide_deliverable('%s', 'Approved', null)$$, pg_temp.id('dlv')), 'the org accepts it');
select pg_temp.as_platform();
select is(pg_temp.state('dlv'), 'Accepted', 'the deliverable is Accepted');
select is((select count(*)::int from app.deliverable_state_transitions where engagement_deliverable_id = pg_temp.id('dlv')), 5, 'every move is in the ledger');
select throws_ok(format($$update app.engagement_deliverables set deliverable_state = 'Open' where id = '%s'$$, pg_temp.id('dlv')), 'XR001', null,
  'the state changes only through the RPCs');

-- Separation of duties: a member of the org engaged as the party ---------------------------------------------------------------------
select pg_temp.as_user('xavier');
with r as (insert into app.records (project_id, record_kind, title, xyz, xyz_basis) values (pg_temp.id('prj_b'), 'Document', 'Set List', 'Y', 'Declared') returning id)
  insert into world select 'rec_b', id from r;
select pg_temp.as_platform();
select pg_temp.move_engagement('eng_mia_b', 'Onboarding', 'Active');
select pg_temp.as_user('xavier');
with d as (select app.add_engagement_deliverable(pg_temp.id('eng_mia_b'), pg_temp.id('rec_b')) as id) insert into world select 'dlv_mia', id from d;
select pg_temp.as_user('mia');
select app.submit_deliverable(pg_temp.id('dlv_mia'), null, 'Set list attached.');
select throws_ok(format($$select app.decide_deliverable('%s', 'Approved', null)$$, pg_temp.id('dlv_mia')), '42501', null,
  'mia holds no engagement write in Harbor Lights, so she cannot accept her own work');
select pg_temp.as_platform();

-- RLS ------------------------------------------------------------------------------------------------------------------------------
select is(pg_temp.n('carol', 'select 1 from app.engagement_deliverables'), 1, 'same tenant: the org reads its deliverables');
select is(pg_temp.n('ivy', 'select 1 from app.engagement_deliverables'), 0, 'externals read through api_external only');
select is(pg_temp.n('quinn', 'select 1 from api_external.deliverables'), 0, 'denial: another party');
select pg_temp.as_anon();
select throws_ok('select 1 from app.engagement_deliverables', '42501', null, 'anon deny');
select throws_ok('select 1 from api_external.deliverables', '42501', null, 'anon deny on the projection');
select pg_temp.as_platform();
select hasnt_column('api_external', 'deliverables', 'decided_by', 'who decided never reaches externals');

-- Time box --------------------------------------------------------------------------------------------------------------------------
select pg_temp.move_engagement('eng_ivy_a', 'Active', 'Closing');
select pg_temp.move_engagement('eng_ivy_a', 'Closing', 'Complete');
select is(pg_temp.n('ivy', 'select 1 from api_external.deliverables'), 0, 'Complete: deliverables close with the operational area');

select * from finish();
rollback;

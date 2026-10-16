-- pgTAP: org state labels (Section 4.10, A33). Same-tenant allow, cross-tenant deny, anon deny, role
-- bands (org.views.write edits: Owner and Admin, not Manager), the invariants (one label per state,
-- unique labels, never another state's canon name, the state never changes) and the display view.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0200_identity_world.psql

select plan(15);

select pg_temp.as_user('bob');
select lives_ok($$with x as (insert into app.org_state_labels (org_id, record_state, label) values ((select id from world where key = 'org_a'), 'In Review', 'With Client') returning id) insert into world select 'lbl', id from x$$,
  'an Admin relabels In Review');
select throws_ok($$insert into app.org_state_labels (org_id, record_state, label) values ((select id from world where key = 'org_a'), 'In Review', 'Client Review')$$,
  '23505', null, 'a state has one label per org');
select throws_ok($$insert into app.org_state_labels (org_id, record_state, label) values ((select id from world where key = 'org_a'), 'Ready', 'with client')$$,
  '23505', null, 'two states never share a label');
select throws_ok($$insert into app.org_state_labels (org_id, record_state, label) values ((select id from world where key = 'org_a'), 'Ready', 'Complete')$$,
  'XR001', null, 'a label never takes another state''s canon name');
select throws_ok($$insert into app.org_state_labels (org_id, record_state, label) values ((select id from world where key = 'org_a'), 'Invented', 'Made Up')$$,
  '23503', null, 'only the nine canon states are relabeled; no lifecycle is minted');
select throws_ok($$update app.org_state_labels set record_state = 'Ready' where id = (select id from world where key = 'lbl')$$,
  'XR001', null, 'a label keeps its state');
select lives_ok($$update app.org_state_labels set label = 'Client Review' where id = (select id from world where key = 'lbl')$$, 'a label can be renamed');
select pg_temp.as_user('carol');
select throws_ok($$insert into app.org_state_labels (org_id, record_state, label) values ((select id from world where key = 'org_a'), 'Blocked', 'Stuck')$$,
  '42501', null, 'a Manager cannot relabel states');
select is((select label from app.record_state_display where org_id = pg_temp.id('org_a') and record_state = 'In Review'), 'Client Review', 'members see the org''s label');
select is((select label from app.record_state_display where org_id = pg_temp.id('org_a') and record_state = 'Ready'), 'Ready', 'and the canon name where the org set none');
select is((select count(*)::int from app.record_state_display where org_id = pg_temp.id('org_a')), 9, 'every one of the nine states has a display label');
select pg_temp.as_user('xavier');
select is((select count(*)::int from app.org_state_labels where org_id = pg_temp.id('org_a')), 0, 'another org reads no labels');
select is((select label from app.record_state_display where org_id = pg_temp.id('org_b') and record_state = 'In Review'), 'In Review', 'and keeps the canon name in its own org');
select pg_temp.as_anon();
select throws_ok('select 1 from app.org_state_labels', '42501', null, 'anon cannot read labels');
select pg_temp.as_platform();
select is((select count(*)::int from app.domain_events where event_type = 'state_label.changed' and subject_id = pg_temp.id('lbl')), 2, 'every change emits state_label.changed');

select * from finish();
rollback;

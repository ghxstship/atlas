-- pgTAP: A10 guest lists (0431, 0965) and advancing comment subjects. Same-tenant allow, cross-tenant and anon
-- deny, invariant 2 role bands; the state machine (Requested to Approved or Declined to Checked In, refused moves),
-- review authority and sod_guest_requester; stamps set by the database; a decided guest keeps its guest; scope node
-- of the same project; engaged artist, representative and denial paths through request_engaged_guest and
-- engaged_guest_list; events scoped to their subject rows.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

select plan(32);

select pg_temp.move_engagement('eng_art_a', 'Onboarding', 'Active');

-- Internal guest list ------------------------------------------------------------------------------------------------
select pg_temp.as_user('frank');
with x as (insert into app.guest_list_entries (project_id, scope_node_id, guest_name, plus_ones, note)
  values (pg_temp.id('prj_a'), pg_temp.id('show_a'), 'Jordan Pike', 1, 'Side stage.') returning id) insert into world select 'g1', id from x;
select is((select entry_state::text from app.guest_list_entries where id = pg_temp.id('g1')), 'Requested', 'a Field project member requests a guest');
select is((select org_id from app.guest_list_entries where id = pg_temp.id('g1')), pg_temp.id('org_a'), 'the org is derived from the project');
select throws_ok($$insert into app.guest_list_entries (project_id, guest_name, entry_state) values ((select id from world where key = 'prj_a'), 'Comp', 'Approved')$$,
  'XR001', 'guest_entry_authority: Approving guests needs advancing.submission.review on the project.', 'only a reviewer adds a guest as Approved');
select throws_ok($$insert into app.guest_list_entries (project_id, guest_name, decided_at, decided_by) values ((select id from world where key = 'prj_a'), 'Comp', now(), (select id from world where key = 'frank'))$$,
  'XR001', 'guest_entry_stamped: Decision and check-in times are set by the database.', 'decision stamps are never supplied');
select throws_ok($$insert into app.guest_list_entries (project_id, scope_node_id, guest_name) values ((select id from world where key = 'prj_a'), (select id from world where key = 'root_a2'), 'Wrong Show')$$,
  'XR001', null, 'the show belongs to the same project');
select throws_ok($$insert into app.guest_list_entries (project_id, guest_name, plus_ones) values ((select id from world where key = 'prj_a'), 'Crowd', 21)$$,
  '23514', null, 'plus-ones run 0 to 20');
select throws_ok($$update app.guest_list_entries set entry_state = 'Approved' where id = (select id from world where key = 'g1')$$,
  'XR001', null, 'a Field member cannot approve a guest');
select throws_ok($$update app.guest_list_entries set entry_state = 'Checked In' where id = (select id from world where key = 'g1')$$,
  'XR001', 'guest_entry_transition: A guest moves from Requested only as the guest list allows.', 'a requested guest is not checked in');
select pg_temp.as_user('gina');
select is((select count(*)::int from app.guest_list_entries), 0, 'a Viewer outside the project reads no guests (invariant 2)');
select pg_temp.as_user('xavier');
select is((select count(*)::int from app.guest_list_entries where org_id = pg_temp.id('org_a')), 0, 'another org reads no guests');
select throws_ok($$insert into app.guest_list_entries (project_id, guest_name) values ((select id from world where key = 'prj_a'), 'Intruder')$$,
  '42501', null, 'another org cannot add guests');
select pg_temp.as_anon();
select throws_ok('select 1 from app.guest_list_entries', '42501', null, 'anon cannot read guest lists');

-- Decisions and check-in -----------------------------------------------------------------------------------------
select pg_temp.as_user('dave');
with x as (insert into app.guest_list_entries (project_id, guest_name) values (pg_temp.id('prj_a'), 'Morgan Lee') returning id) insert into world select 'g2', id from x;
select throws_ok($$update app.guest_list_entries set entry_state = 'Approved' where id = (select id from world where key = 'g2')$$,
  'XR001', 'sod_guest_requester: The person who requested a guest cannot approve or decline the request.', 'the requester cannot approve their own guest');
select lives_ok($$update app.guest_list_entries set entry_state = 'Approved', decided_at = '2000-01-01' where id = (select id from world where key = 'g1')$$,
  'a Member with review authority approves another person''s request');
select is((select decided_by from app.guest_list_entries where id = pg_temp.id('g1')), pg_temp.id('dave'), 'the decision is stamped with the reviewer');
select ok((select decided_at > '2020-01-01' from app.guest_list_entries where id = pg_temp.id('g1')), 'and the database time');
select throws_ok($$update app.guest_list_entries set guest_name = 'Someone Else' where id = (select id from world where key = 'g1')$$,
  'XR001', null, 'a decided guest keeps its name');
select throws_ok($$update app.guest_list_entries set entry_state = 'Declined' where id = (select id from world where key = 'g1')$$,
  'XR001', null, 'an approved guest is not declined afterwards');
select pg_temp.as_user('frank');
select lives_ok($$update app.guest_list_entries set entry_state = 'Checked In' where id = (select id from world where key = 'g1')$$, 'the door checks an approved guest in');
select is((select checked_in_by from app.guest_list_entries where id = pg_temp.id('g1')), pg_temp.id('frank'), 'the check-in is stamped with who checked in');
select throws_ok($$update app.guest_list_entries set entry_state = 'Approved' where id = (select id from world where key = 'g1')$$,
  'XR001', null, 'a checked-in guest stays checked in');
select pg_temp.as_user('carol');
select lives_ok($$update app.guest_list_entries set entry_state = 'Declined' where id = (select id from world where key = 'g2')$$, 'a Manager declines a request');
select pg_temp.as_platform();
select is((select count(*)::int from app.domain_events where subject_id = pg_temp.id('g1') and event_type like 'guest_list_entry.%'), 3,
  'the approved and checked-in guest emits requested, decided and checked_in');
select is((select count(*)::int from app.domain_events where subject_id = pg_temp.id('g2') and event_type = 'guest_list_entry.decided'), 1,
  'the decline emits decided once');

-- Engaged party path (0965) --------------------------------------------------------------------------------------
-- R9 (2715): a party asks for guests only while the project offers a guest list.
select pg_temp.as_platform();
insert into app.setting_values (org_id, setting_key, scope_kind, scope_id, value_text, locked)
values (pg_temp.id('org_a'), 'offerings.guest_list', 'Project', pg_temp.id('prj_a'), 'provided', false);
select pg_temp.as_user('art');
select isnt(app.request_engaged_guest(pg_temp.id('eng_art_a'), 'Sasha Bell', 2, 'Family.'), null, 'the engaged artist requests a guest');
select is((select count(*)::int from app.engaged_guest_list(pg_temp.id('eng_art_a'))), 1, 'and sees their own guest list');
select throws_ok($$select app.request_engaged_guest((select id from world where key = 'eng_art_a'), 'X', 21)$$, '23514', null, 'the same limits apply');
select pg_temp.as_user('rita');
select is((select count(*)::int from app.engaged_guest_list(pg_temp.id('eng_art_a'))), 1, 'the Advance representative sees the artist''s list');
select pg_temp.as_user('quinn');
select throws_ok($$select app.request_engaged_guest((select id from world where key = 'eng_art_a'), 'Stranger')$$, '42501', null, 'another party cannot add to the list');
select throws_ok($$select * from app.engaged_guest_list((select id from world where key = 'eng_art_a'))$$, '42501', null, 'nor read it');
select pg_temp.as_user('dave');
select is((select count(*)::int from app.guest_list_entries where engagement_id = pg_temp.id('eng_art_a') and entry_state = 'Requested'), 1,
  'the production sees the artist''s request to decide');

-- Comment subjects -----------------------------------------------------------------------------------------------
select pg_temp.as_platform();
select ok((select count(*) = 5 from private.comment_subjects where table_name in
  ('app.advance_packets', 'app.advance_submissions', 'app.riders', 'app.reconciliations', 'app.guest_list_entries')),
  'packets, answers, riders, reconciliations and guests take comments and attachments');

select * from finish();
rollback;

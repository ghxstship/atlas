-- pgTAP: migration 2716 (R9, parity gap G-141), the credential naming deadline. A deadline needs an engagement; before
-- it the party names people on a credential pool it requested through an answer; after it the party cannot split,
-- unsplit or withdraw a named share (credential_names_closed) while production can; cascades still withdraw the named
-- share when the entry is withdrawn or the person declines; an answer naming a person after the deadline is refused
-- while a pool line goes in; allocations not requested through an answer are unaffected; the external views end with
-- names_due_at; with allowance overflow at review an over-allowance credential line stays Requested and the review
-- commits.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql
\ir 2654_project_facts_world.psql
\ir 2691_allocation_world.psql

select no_plan();

create function pg_temp.answer(p_section text, p_lines jsonb) returns uuid
language plpgsql as $$
begin
  perform pg_temp.as_user('victor');
  return app.submit_advance_answer(pg_temp.id('rcp'), pg_temp.id(p_section), null, null, p_lines, '{}');
end $$;

create function pg_temp.pool_of(p_answer text) returns uuid
language sql security definer as $$
  select a.id from app.advance_allocations a join app.advance_submission_lines l on l.id = a.advance_submission_line_id
  where l.advance_submission_id = pg_temp.id(p_answer) and a.engagement_id is not null limit 1
$$;

create function pg_temp.share_of(p_pool uuid, p_entry text) returns uuid
language sql security definer as $$
  select a.id from app.advance_allocations a
  where a.parent_allocation_id = p_pool and a.roster_entry_id = pg_temp.id(p_entry) and a.allocation_state = 'Approved' limit 1
$$;

-- Inserts a section into the packet as dave and returns its id.
create function pg_temp.add_section(p_position integer, p_kind text, p_window text, p_max integer, p_per_person boolean) returns uuid
language plpgsql as $$
declare v uuid;
begin
  perform pg_temp.as_user('dave');
  insert into app.advance_sections (advance_packet_id, position, title, section_kind, window_kind, max_lines, per_person)
  values (pg_temp.id('pkt'), p_position, p_kind || ' ' || p_position, p_kind::app.advance_section_kind, p_window::app.advance_window_kind,
    p_max, p_per_person)
  returning id into v;
  return v;
end $$;

-- Fixture: a Credential Request sent to Bayside Audio ---------------------------------------------------------------------------
select pg_temp.as_user('dave');
with x as (insert into app.advance_packets (project_id, title) values (pg_temp.id('prj_a'), 'Vendor Advance') returning id)
insert into world select 'pkt', id from x;
insert into world select v.k, pg_temp.add_section(v.pos, 'Credential Request', null, 5, false)
from (values ('s_cred', 1), ('s_cred2', 2), ('s_park', 3)) v (k, pos);
select pg_temp.as_user('dave');
insert into app.advance_section_choices (advance_section_id, credential_category_id) values
  (pg_temp.id('s_cred'), pg_temp.id('cat_crew')), (pg_temp.id('s_cred2'), pg_temp.id('cat_crew')), (pg_temp.id('s_park'), pg_temp.id('cat_park'));
with x as (insert into app.advance_recipients (advance_packet_id, counterparty_id) values (pg_temp.id('pkt'), pg_temp.id('cp_v_a')) returning id)
insert into world select 'rcp', id from x;
select throws_ok($$update app.advance_recipients set names_due_at = now() + interval '1 day' where id = (select id from world where key = 'rcp')$$,
  '23514', null, 'a naming deadline needs an engagement (advance_recipients_names_due_engagement)');
update app.advance_recipients set engagement_id = pg_temp.id('eng_vendor_a'), names_due_at = now() + interval '7 days' where id = pg_temp.id('rcp');
select app.send_advance_packet(pg_temp.id('pkt'));
select lives_ok($$update app.advance_recipients set names_due_at = now() + interval '3 days' where id = (select id from world where key = 'rcp')$$,
  'the deadline stays editable after send');

-- Before the deadline the party names its people ---------------------------------------------------------------------------------
insert into world values ('a1', pg_temp.answer('s_cred', jsonb_build_array(jsonb_build_object('credential_category_id', pg_temp.id('cat_crew'), 'quantity', 4))));
select pg_temp.as_user('carol');
update app.advance_submissions set review_outcome = 'Accepted' where id = pg_temp.id('a1');
insert into world values ('pool', pg_temp.pool_of('a1'));
select pg_temp.as_platform();
select is(pg_temp.state_of(pg_temp.id('pool')), 'Approved', 'accepting the answer approves the pool of four passes');
select pg_temp.as_user('victor');
select lives_ok($$select app.split_engaged_allocation((select id from world where key = 'pool'),
  jsonb_build_array(jsonb_build_object('roster_entry_id', (select id from world where key = 'e_kai'), 'quantity', 1),
                    jsonb_build_object('roster_entry_id', (select id from world where key = 'e_mo'), 'quantity', 1)))$$,
  'before the deadline the Account Owner names two people');
select pg_temp.as_platform();
select has_column('api_external', 'advance_allocations', 'names_due_at', 'api_external.advance_allocations has names_due_at');
select pg_temp.as_user('victor');
select ok((select names_due_at is not null from api_external.advance_allocations where allocation_id = pg_temp.share_of(pg_temp.id('pool'), 'e_kai')),
  'a named share reads its pool''s deadline in Gateway');

-- After the deadline only production changes names --------------------------------------------------------------------------------
select pg_temp.as_user('dave');
update app.advance_recipients set names_due_at = now() - interval '1 hour' where id = pg_temp.id('rcp');
select pg_temp.as_user('victor');
select throws_ok($$select app.split_engaged_allocation((select id from world where key = 'pool'),
  jsonb_build_array(jsonb_build_object('roster_entry_id', (select id from world where key = 'self_sam'), 'quantity', 1)))$$,
  'XR001', 'credential_names_closed: Passes can no longer be named; ask the producer to change them.', 'the party cannot name anyone after the deadline');
select throws_ok($$select app.unsplit_engaged_allocation(pg_temp.share_of((select id from world where key = 'pool'), 'e_kai'))$$,
  'XR001', 'credential_names_closed: Passes can no longer be named; ask the producer to change them.', 'nor unname someone');
select throws_ok($$select app.withdraw_engaged_allocation(pg_temp.share_of((select id from world where key = 'pool'), 'e_kai'), 'Not coming.')$$,
  'XR001', 'credential_names_closed: Passes can no longer be named; ask the producer to change them.', 'nor withdraw a named pass');
select pg_temp.as_user('dave');
select lives_ok($$select app.split_allocation((select id from world where key = 'pool'),
  jsonb_build_array(jsonb_build_object('roster_entry_id', (select id from world where key = 'self_sam'), 'quantity', 1)))$$,
  'production still names people after the deadline');
select lives_ok($$select app.unsplit_allocation(pg_temp.share_of((select id from world where key = 'pool'), 'self_sam'))$$,
  'and unnames them');

-- Cascades are never blocked ----------------------------------------------------------------------------------------------------------
select pg_temp.as_user('victor');
select lives_ok($$select app.withdraw_roster_entry((select id from world where key = 'e_mo'), 'Left the company.')$$,
  'after the deadline the Account Owner still withdraws a roster entry');
select pg_temp.as_platform();
select is((select allocation_state::text || ' ' || withdraw_cause::text from app.advance_allocations
  where parent_allocation_id = pg_temp.id('pool') and roster_entry_id = pg_temp.id('e_mo')), 'Withdrawn Entry Removed', 'and the named pass goes with it');
select pg_temp.as_user('kai');
select lives_ok($$select app.respond_roster_entry((select id from world where key = 'e_kai'), 'Declined')$$, 'a person still declines');
select pg_temp.as_platform();
select is((select allocation_state::text from app.advance_allocations
  where parent_allocation_id = pg_temp.id('pool') and roster_entry_id = pg_temp.id('e_kai')), 'Withdrawn', 'which withdraws their pass');

-- Answers after the deadline -------------------------------------------------------------------------------------------------------------
select throws_ok($$select pg_temp.answer('s_cred2', jsonb_build_array(jsonb_build_object('credential_category_id', pg_temp.id('cat_crew'), 'quantity', 1,
  'roster_entry_id', pg_temp.id('self_sam'))))$$,
  'XR001', 'credential_names_closed: Passes can no longer be named; ask the producer to change them.', 'an answer naming a person after the deadline is refused');
select lives_ok($$select pg_temp.answer('s_cred2', jsonb_build_array(jsonb_build_object('credential_category_id', pg_temp.id('cat_crew'), 'quantity', 2)))$$,
  'a pool line still goes in for review');

-- Allocations not requested through an answer ---------------------------------------------------------------------------------------------
insert into world values ('direct', pg_temp.alloc('assign', 'carol', 'eng_vendor_a', 'category', 'cat_crew', 2));
select pg_temp.as_user('victor');
select lives_ok($$select app.split_engaged_allocation((select id from world where key = 'direct'),
  jsonb_build_array(jsonb_build_object('roster_entry_id', (select id from world where key = 'self_sam'), 'quantity', 1)))$$,
  'a pool production assigned directly has no deadline');

-- The external view ends with the deadline -------------------------------------------------------------------------------------------------
select is((select column_name::text from information_schema.columns where table_schema = 'api_external' and table_name = 'my_advance_recipients'
  order by ordinal_position desc limit 1), 'names_due_at', 'api_external.my_advance_recipients ends with names_due_at');
select pg_temp.as_user('victor');
select ok((select names_due_at < now() from api_external.my_advance_recipients where id = pg_temp.id('rcp')), 'the party reads its deadline');
select pg_temp.as_user('quinn');
select is((select count(*)::int from api_external.my_advance_recipients where id = pg_temp.id('rcp')), 0, 'another party reads nothing');
select pg_temp.as_user('kai');
select is((select count(*)::int from api_external.my_advance_recipients where id = pg_temp.id('rcp')), 0, 'nor an Account Member nobody assigned');

-- Overflow at review: the answer commits, the over-allowance line waits ---------------------------------------------------------------------
select pg_temp.as_user('alice');
select app.set_setting(pg_temp.id('org_a'), 'advancing.allowance_overflow', 'Project', pg_temp.id('prj_a'), 'review');
insert into app.offering_rules (org_id, project_id, offering, offering_mode, cap_per_engagement)
values (pg_temp.id('org_a'), pg_temp.id('prj_a'), 'Parking', 'Provided', 1);
insert into world values ('a_park', pg_temp.answer('s_park', jsonb_build_array(jsonb_build_object('credential_category_id', pg_temp.id('cat_park'), 'quantity', 3))));
select pg_temp.as_user('carol');
select lives_ok($$update app.advance_submissions set review_outcome = 'Accepted' where id = (select id from world where key = 'a_park')$$,
  'accepting an answer with an over-allowance parking line commits');
select pg_temp.as_platform();
select is(pg_temp.state_of(pg_temp.pool_of('a_park')), 'Requested', 'and leaves that allocation Requested for a reviewer to decide with a reason');

select * from finish();
rollback;

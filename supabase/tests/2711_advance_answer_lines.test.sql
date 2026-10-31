-- pgTAP: migration 2711 (R9), typed advance answers. One open answer per section and recipient (unreviewed and Accepted
-- refuse, Returned allows); a Crew Roster section takes no answer; a typed answer only through app.submit_advance_answer;
-- line validation for each kind with max_lines, a person exactly when per person, a person of the engagement's roster;
-- a direct line insert refused. Item and credential lines become Requested allocations linked to their line; accepting
-- approves them, one that needs sources stays Requested while the review commits, returning declines them. Dock slots
-- from an accepted Load In window: the Accepted rule, booked once, overlap refused. The section 8.7 matrix on the new
-- api_external views.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql
\ir 2654_project_facts_world.psql
\ir 2691_allocation_world.psql

select no_plan();

create function pg_temp.n(p_who text, p_sql text) returns integer
language plpgsql as $$
declare v integer;
begin
  perform pg_temp.as_user(p_who);
  execute 'select count(*)::int from (' || p_sql || ') x' into v;
  perform pg_temp.as_platform();
  return v;
end $$;

-- Answers a section as victor, Bayside Audio's Account Owner.
create function pg_temp.answer(p_section text, p_lines jsonb default '[]', p_text text default null, p_note text default null) returns uuid
language plpgsql as $$
begin
  perform pg_temp.as_user('victor');
  return app.submit_advance_answer(pg_temp.id('rcp'), pg_temp.id(p_section), p_text, p_note, p_lines, '{}');
end $$;

create function pg_temp.line(p_kind text, p_item text, p_quantity integer, p_entry text default null) returns jsonb
language sql as $$
  select jsonb_strip_nulls(jsonb_build_object(
    case p_kind when 'class' then 'asset_class_id' else 'credential_category_id' end, pg_temp.id(p_item),
    'quantity', p_quantity, 'roster_entry_id', case when p_entry is not null then pg_temp.id(p_entry) end))
$$;

create function pg_temp.window_line(p_from text, p_to text) returns jsonb
language sql as $$
  select jsonb_build_object('needed_window_start', p_from, 'needed_window_end', p_to, 'window_zone', 'America/New_York')
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

-- Fixture: carts are offered too; a packet with every kind goes to Bayside Audio --------------------------------------------
select pg_temp.as_user('alice');
select app.set_setting(pg_temp.id('org_a'), 'offerings.carts', 'Organization', null, 'provided');
insert into world values ('cls_cart', app.ensure_offering_asset_class(pg_temp.id('org_a'), 'Carts'));
select pg_temp.as_user('dave');
with x as (insert into app.advance_packets (project_id, title) values (pg_temp.id('prj_a'), 'Vendor Advance') returning id)
insert into world select 'pkt', id from x;
insert into world select v.k, pg_temp.add_section(v.pos, v.kind, v.win, v.mx, v.pp) from (values
  ('s_text', 1, 'Text', null, null, false), ('s_roster', 2, 'Crew Roster', null, null, false),
  ('s_win', 3, 'Schedule Window', 'Load In', 2, false), ('s_items', 4, 'Item Request', null, 3, false),
  ('s_items_pp', 5, 'Item Request', null, 2, true), ('s_cred', 6, 'Credential Request', null, 5, false),
  ('s_guests', 7, 'Guest List', null, null, false)) v (k, pos, kind, win, mx, pp);
select pg_temp.as_user('dave');
insert into app.advance_section_choices (advance_section_id, asset_class_id) values
  (pg_temp.id('s_items'), pg_temp.id('cls_radio')), (pg_temp.id('s_items'), pg_temp.id('cls_cart')), (pg_temp.id('s_items_pp'), pg_temp.id('cls_radio'));
insert into app.advance_section_choices (advance_section_id, credential_category_id) values (pg_temp.id('s_cred'), pg_temp.id('cat_crew'));
with x as (insert into app.advance_recipients (advance_packet_id, counterparty_id, engagement_id)
  values (pg_temp.id('pkt'), pg_temp.id('cp_v_a'), pg_temp.id('eng_vendor_a')) returning id) insert into world select 'rcp', id from x;
select app.send_advance_packet(pg_temp.id('pkt'));
select pg_temp.as_platform();

-- One open answer ---------------------------------------------------------------------------------------------------------------
insert into world values ('a_text', pg_temp.answer('s_text', '[]', 'Two trucks, one forklift.'));
select pg_temp.as_platform();
select is((select body from app.advance_submissions where id = pg_temp.id('a_text')), 'Two trucks, one forklift.', 'a text answer keeps its body');
select throws_ok($$select pg_temp.answer('s_text', '[]', 'Three trucks.')$$,
  'XR001', 'advance_answer_pending: This section is answered; answer again only after it is returned.', 'an unreviewed answer is the open one');
select pg_temp.as_user('carol');
update app.advance_submissions set review_outcome = 'Returned', return_reason = 'Say which dock.' where id = pg_temp.id('a_text');
select lives_ok($$select pg_temp.answer('s_text', '[]', 'Two trucks at dock 2.')$$, 'a Returned answer is answered again');
select pg_temp.as_user('carol');
update app.advance_submissions set review_outcome = 'Accepted'
where advance_section_id = pg_temp.id('s_text') and review_outcome is null;
select throws_ok($$select pg_temp.answer('s_text', '[]', 'Changed my mind.')$$,
  'XR001', 'advance_answer_pending: This section is answered; answer again only after it is returned.', 'an Accepted answer stays the answer');
select throws_ok($$select pg_temp.answer('s_text', '[]', 'x', 'a note')$$, 'XR001', null, 'a text answer carries no note');

-- Kinds that take no answer, and the one writer --------------------------------------------------------------------------------
select throws_ok($$select pg_temp.answer('s_roster')$$,
  'XR001', 'advance_section_derived: The crew roster section is read from the engagement''s roster and takes no answer.', 'the Crew Roster section takes no answer');
select pg_temp.as_platform();
select throws_ok($$insert into app.advance_submissions (advance_section_id, advance_recipient_id, body)
  values ((select id from world where key = 's_win'), (select id from world where key = 'rcp'), 'A window')$$,
  'XR001', 'advance_typed_answer_rpc: A typed answer is recorded with app.submit_advance_answer.', 'a typed answer is never inserted directly');
select pg_temp.as_user('quinn');
select throws_ok($$select app.submit_advance_answer((select id from world where key = 'rcp'), (select id from world where key = 's_win'), null, null,
  '[]', '{}')$$, '42501', null, 'another party cannot answer');
select pg_temp.as_user('kai');
select throws_ok($$select app.submit_advance_answer((select id from world where key = 'rcp'), (select id from world where key = 's_win'), null, null,
  '[]', '{}')$$, '42501', null, 'an Account Member nobody assigned is not the recipient side (R4, owner decision 6)');

-- Schedule Window ------------------------------------------------------------------------------------------------------------------
select throws_ok($$select pg_temp.answer('s_win', jsonb_build_array(pg_temp.window_line('2027-06-01 08:00+00', '2027-06-01 10:00+00') || '{"quantity": 2}'))$$,
  'XR001', 'advance_line_kind: A schedule window line gives a start, an end and a time zone only.', 'a window line carries no quantity');
select throws_ok($$select pg_temp.answer('s_win', jsonb_build_array(pg_temp.window_line('2027-06-01 08:00+00', '2027-06-01 10:00+00'),
  pg_temp.window_line('2027-06-01 11:00+00', '2027-06-01 12:00+00'), pg_temp.window_line('2027-06-01 13:00+00', '2027-06-01 14:00+00')))$$,
  'XR001', 'advance_line_limit: Give 1 to 2 lines.', 'max_lines holds');
select throws_ok($$select pg_temp.answer('s_win', jsonb_build_array(pg_temp.window_line('2027-06-01 10:00+00', '2027-06-01 08:00+00')))$$,
  'XR001', 'advance_line_window: A window runs from a start to a later end.', 'a window ends after it starts');
insert into world values ('a_win', pg_temp.answer('s_win', jsonb_build_array(pg_temp.window_line('2027-06-01 08:00+00', '2027-06-01 10:00+00'),
  pg_temp.window_line('2027-06-01 09:00+00', '2027-06-01 11:00+00'))));
select pg_temp.as_platform();
select is((select body from app.advance_submissions where id = pg_temp.id('a_win')),
  E'SCHEDULE_WINDOW 2027-06-01T08:00:00Z/2027-06-01T10:00:00Z America/New_York\nSCHEDULE_WINDOW 2027-06-01T09:00:00Z/2027-06-01T11:00:00Z America/New_York',
  'the body of a typed answer is its locale-neutral summary');
select is((select count(*)::int from app.advance_submission_lines where advance_submission_id = pg_temp.id('a_win')), 2, 'with one line per window');
select throws_ok($$insert into app.advance_submission_lines (advance_submission_id, line_number, needed_window, window_zone)
  values ((select id from world where key = 'a_win'), 3, '[2027-06-02 08:00+00,2027-06-02 09:00+00)', 'UTC')$$,
  'XR001', 'advance_line_direct: Answer lines are written with the answer by app.submit_advance_answer.', 'lines are never inserted directly');
select throws_ok($$update app.advance_submission_lines set note = 'x' where advance_submission_id = (select id from world where key = 'a_win')$$,
  'XR001', null, 'lines never change');

-- Item Request -------------------------------------------------------------------------------------------------------------------------
select throws_ok($$select pg_temp.answer('s_items', jsonb_build_array(pg_temp.line('class', 'cls_cable', 2)))$$,
  'XR001', 'advance_line_kind: An item line names one of the section''s items and a quantity.', 'an item that is not a choice is refused');
select throws_ok($$select pg_temp.answer('s_items', jsonb_build_array(pg_temp.line('class', 'cls_radio', 2, 'e_kai')))$$,
  'XR001', 'advance_line_person: This section asks for the party''s items, not per person.', 'a pool section names nobody');
select throws_ok($$select pg_temp.answer('s_items_pp', jsonb_build_array(pg_temp.line('class', 'cls_radio', 1)))$$,
  'XR001', 'advance_line_person: Each item line names a person on the roster.', 'a per-person section names a person on every line');
select throws_ok($$select pg_temp.answer('s_items_pp', jsonb_build_array(jsonb_build_object('asset_class_id', pg_temp.id('cls_radio'), 'quantity', 1,
  'roster_entry_id', (select r.id from app.engagement_roster_entries r where r.engagement_id <> pg_temp.id('eng_vendor_a') limit 1))))$$,
  'XR001', null, 'a person on another engagement''s roster is refused');
insert into world values ('a_items', pg_temp.answer('s_items', jsonb_build_array(pg_temp.line('class', 'cls_radio', 2), pg_temp.line('class', 'cls_cart', 1)),
  null, 'Delivered to the FOH riser.'));
select pg_temp.as_platform();
select is((select count(*)::int from app.advance_allocations a join app.advance_submission_lines l on l.id = a.advance_submission_line_id
  where l.advance_submission_id = pg_temp.id('a_items') and a.allocation_state = 'Requested' and a.engagement_id = pg_temp.id('eng_vendor_a')), 2,
  'each item line becomes a Requested allocation of the engagement''s pool, linked to its line');
select is((select a.created_by from app.advance_allocations a join app.advance_submission_lines l on l.id = a.advance_submission_line_id
  where l.advance_submission_id = pg_temp.id('a_items') limit 1), pg_temp.id('victor'), 'requested by the person who answered');
select is((select note from app.advance_submissions where id = pg_temp.id('a_items')), 'Delivered to the FOH riser.', 'the answer keeps its note');
select is((select count(*)::int from app.advance_allocations a join app.advance_submission_lines l on l.id = a.advance_submission_line_id
  where l.advance_submission_id = pg_temp.id('a_items') and lower(a.needed_during) = '2027-06-01 04:00+00'), 2,
  'a line without a window is needed from the engagement''s start in the project''s zone');
select throws_ok($$update app.advance_allocations set advance_submission_line_id = null
  where advance_submission_line_id in (select id from app.advance_submission_lines where advance_submission_id = (select id from world where key = 'a_items'))$$,
  'XR001', null, 'an allocation keeps its answer line');

-- Credential Request ----------------------------------------------------------------------------------------------------------------------
select throws_ok($$select pg_temp.answer('s_cred', jsonb_build_array(pg_temp.line('category', 'cat_crew', 2, 'e_kai')))$$,
  'XR001', 'advance_line_kind: A credential for a named person is for one.', 'a named credential is for one');
insert into world values ('a_cred', pg_temp.answer('s_cred', jsonb_build_array(pg_temp.line('category', 'cat_crew', 4), pg_temp.line('category', 'cat_crew', 1, 'e_kai'))));
select pg_temp.as_platform();
select is((select count(*)::int from app.advance_allocations a join app.advance_submission_lines l on l.id = a.advance_submission_line_id
  where l.advance_submission_id = pg_temp.id('a_cred') and a.roster_entry_id = pg_temp.id('e_kai')), 1, 'a named credential line is the person''s allocation');

-- Guest List --------------------------------------------------------------------------------------------------------------------------------
insert into world values ('a_guests', pg_temp.answer('s_guests'));
select pg_temp.as_platform();
select is((select body from app.advance_submissions where id = pg_temp.id('a_guests')), 'GUEST_LIST_CONFIRMED', 'a guest list confirmation has a fixed body');

-- Review decides the allocations ----------------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
select lives_ok($$update app.advance_submissions set review_outcome = 'Accepted' where id = (select id from world where key = 'a_items')$$,
  'accepting an answer whose cart line needs sources still commits');
select pg_temp.as_platform();
select is((select a.allocation_state::text from app.advance_allocations a join app.advance_submission_lines l on l.id = a.advance_submission_line_id
  where l.advance_submission_id = pg_temp.id('a_items') and a.asset_class_id = pg_temp.id('cls_radio')), 'Approved', 'the radio line is approved');
select is(pg_temp.holds((select a.id from app.advance_allocations a join app.advance_submission_lines l on l.id = a.advance_submission_line_id
  where l.advance_submission_id = pg_temp.id('a_items') and a.asset_class_id = pg_temp.id('cls_radio'))), 'stock:2', 'and holds class stock');
select is((select a.allocation_state::text from app.advance_allocations a join app.advance_submission_lines l on l.id = a.advance_submission_line_id
  where l.advance_submission_id = pg_temp.id('a_items') and a.asset_class_id = pg_temp.id('cls_cart')), 'Requested',
  'the cart line, which has no stock to hold, stays Requested for the Allocations queue');
select is((select t.created_by from app.advance_allocation_state_transitions t join app.advance_allocations a on a.id = t.advance_allocation_id
  join app.advance_submission_lines l on l.id = a.advance_submission_line_id
  where l.advance_submission_id = pg_temp.id('a_items') and t.to_state = 'Approved'), pg_temp.id('carol'), 'the reviewer decided it');
select pg_temp.as_user('carol');
update app.advance_submissions set review_outcome = 'Returned', return_reason = 'Name everyone instead.' where id = pg_temp.id('a_cred');
select pg_temp.as_platform();
select is((select string_agg(distinct a.allocation_state::text, ',') from app.advance_allocations a
  join app.advance_submission_lines l on l.id = a.advance_submission_line_id where l.advance_submission_id = pg_temp.id('a_cred')), 'Declined',
  'returning an answer declines its allocations');
select is((select t.reason from app.advance_allocation_state_transitions t join app.advance_allocations a on a.id = t.advance_allocation_id
  join app.advance_submission_lines l on l.id = a.advance_submission_line_id
  where l.advance_submission_id = pg_temp.id('a_cred') and t.to_state = 'Declined' limit 1), 'Name everyone instead.', 'with the return reason');

-- Dock slots from an accepted window ----------------------------------------------------------------------------------------------------------
select pg_temp.as_user('alice');
with x as (insert into app.zones (venue_id, code, name) values (pg_temp.id('venue_a'), 'DOCK-1', 'Loading Dock') returning id) insert into world select 'dock', id from x;
insert into world select 'w1', id from app.advance_submission_lines where advance_submission_id = pg_temp.id('a_win') and line_number = 1;
insert into world select 'w2', id from app.advance_submission_lines where advance_submission_id = pg_temp.id('a_win') and line_number = 2;
select pg_temp.as_user('carol');
select throws_ok($$select app.book_dock_slot_from_answer((select id from world where key = 'w1'), (select id from world where key = 'dock'))$$,
  'XR001', 'advance_line_not_accepted: Accept the answer before booking its window.', 'an answer not yet Accepted is not booked');
update app.advance_submissions set review_outcome = 'Accepted' where id = pg_temp.id('a_win');
select throws_ok($$select app.book_dock_slot_from_answer((select id from app.advance_submission_lines where advance_submission_id = (select id from world where key = 'a_items') limit 1),
  (select id from world where key = 'dock'))$$,
  'XR001', 'advance_line_not_dock: Only a Load In or Load Out window is booked as a dock slot.', 'an item line is no dock window');
select pg_temp.as_user('gina');
select throws_ok($$select app.book_dock_slot_from_answer((select id from world where key = 'w1'), (select id from world where key = 'dock'))$$,
  '42501', null, 'booking needs logistics.dock_slot.write');
select pg_temp.as_user('carol');
insert into world values ('slot', app.book_dock_slot_from_answer(pg_temp.id('w1'), pg_temp.id('dock')));
select pg_temp.as_platform();
select is((select engagement_id from app.dock_slots where id = pg_temp.id('slot')), pg_temp.id('eng_vendor_a'), 'the slot is the recipient''s engagement''s');
select is((select starts_at from app.dock_slots where id = pg_temp.id('slot')), '2027-06-01 08:00+00'::timestamptz, 'over the window');
select pg_temp.as_user('carol');
select throws_ok($$select app.book_dock_slot_from_answer((select id from world where key = 'w1'), (select id from world where key = 'dock'))$$,
  'XR001', 'advance_line_booked: This window already has a dock slot.', 'a window is booked once');
select throws_ok($$select app.book_dock_slot_from_answer((select id from world where key = 'w2'), (select id from world where key = 'dock'))$$,
  'XR001', 'dock_slot_overlap: Slots at one dock never overlap.', 'the overlap guard applies');
select throws_ok($$update app.dock_slots set advance_submission_line_id = null where id = (select id from world where key = 'slot')$$,
  'XR001', null, 'a slot keeps its answer line');

-- Section 8.7 on the new views --------------------------------------------------------------------------------------------------------------------
select is(pg_temp.n('victor', 'select 1 from api_external.advance_submission_lines'), 6, 'the account Owner reads the lines of its answers');
select is(pg_temp.n('victor', 'select 1 from api_external.advance_section_choices'), 4, 'and the choices of its sections');
select is(pg_temp.n('victor', 'select 1 from api_external.advance_submission_lines where allocation_id is not null'), 4,
  'item and credential lines show the allocation they asked for');
select is(pg_temp.n('victor', $$select 1 from api_external.my_advance_recipients where engagement_id = (select id from world where key = 'eng_vendor_a')$$), 1,
  'the recipient shows its engagement');
select is(pg_temp.n('victor', $$select 1 from api_external.advance_sections where section_kind = 'Item Request' and max_lines = 3$$), 1,
  'sections show their kind and configuration');
select is(pg_temp.n('victor', 'select 1 from api_external.advance_submissions where answer_note is not null'), 1, 'answers show their note');
select is(pg_temp.n('quinn', 'select 1 from api_external.advance_submission_lines'), 0, 'another party reads no lines');
select is(pg_temp.n('ivy', 'select 1 from api_external.advance_section_choices'), 0, 'nor choices');
select is(pg_temp.n('kai', 'select 1 from api_external.advance_submission_lines'), 0, 'an Account Member nobody assigned reads nothing (owner decision 6)');
select is(pg_temp.n('xavier', 'select 1 from api_external.advance_submission_files'), 0, 'another tenant reads nothing');
select hasnt_column('api_external', 'advance_submission_lines', 'created_by', 'who wrote a line never appears');
select hasnt_column('api_external', 'advance_submissions', 'reviewed_by', 'who reviewed never appears');
select pg_temp.as_anon();
select throws_ok('select 1 from api_external.advance_submission_lines', '42501', null, 'anon reads no lines');
select pg_temp.move_engagement('eng_vendor_a', 'Active', 'Closing');
select pg_temp.move_engagement('eng_vendor_a', 'Closing', 'Complete');
select is(pg_temp.n('victor', 'select 1 from api_external.advance_submission_lines'), 0, 'after Complete the lines are closed to the party');

select * from finish();
rollback;

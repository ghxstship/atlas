-- pgTAP: migration 2715 (R9), guest list caps. A guest request is refused while the Guest List offering is Not Offered;
-- the cap counts each guest with its plus-ones, leaves Declined guests out, and refuses the request that goes beyond it.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

select no_plan();

select pg_temp.move_engagement('eng_art_a', 'Onboarding', 'Active');
select pg_temp.as_user('art');
select throws_ok($$select app.request_engaged_guest((select id from world where key = 'eng_art_a'), 'Sasha Bell', 1)$$,
  'XR001', 'offering_not_offered: A guest list is not offered on this engagement''s project.', 'Not Offered refuses a guest');

select pg_temp.as_user('alice');
insert into app.offering_rules (org_id, project_id, offering, offering_mode, cap_per_engagement)
values (pg_temp.id('org_a'), pg_temp.id('prj_a'), 'Guest List', 'Provided', 4);
select pg_temp.as_user('art');
insert into world values ('g1', app.request_engaged_guest(pg_temp.id('eng_art_a'), 'Sasha Bell', 1));
select ok(pg_temp.id('g1') is not null, 'a guest with one plus-one takes two of four places');
select throws_ok($$select app.request_engaged_guest((select id from world where key = 'eng_art_a'), 'Rowan Hale', 2)$$,
  'XR001', 'guest_list_cap: This engagement may bring 4 guests, plus-ones included; 2 are on the list.', 'the cap counts plus-ones');
select pg_temp.as_user('rita');
select lives_ok($$select app.request_engaged_guest((select id from world where key = 'eng_art_a'), 'Rowan Hale', 1)$$,
  'the representative fills the last two places');
select pg_temp.as_user('carol');
update app.guest_list_entries set entry_state = 'Declined' where id = pg_temp.id('g1');
select pg_temp.as_user('art');
select lives_ok($$select app.request_engaged_guest((select id from world where key = 'eng_art_a'), 'Jo Park', 1)$$,
  'a Declined guest no longer counts');
select throws_ok($$select app.request_engaged_guest((select id from world where key = 'eng_art_a'), 'One More')$$,
  'XR001', null, 'and the list is full again');

select * from finish();
rollback;

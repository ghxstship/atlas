-- pgTAP: migration 904110601, a declined roster entry is neither submitted nor accepted. Bayside Audio's Owner rosters
-- Kai and Mo; Kai declines, so the submit moves only Mo and Kai's entry stays a Draft. Kai changes their mind, is
-- submitted, then declines again while the entry waits for review: the reviewer cannot accept them
-- (roster_entry_declined) and returns the entry instead. Nothing left but a declined entry refuses roster_empty_submit.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

select plan(9);

-- As 2633: read as the platform, whoever the caller is, then restore the caller.
create function pg_temp.membership(p_account text, p_person text) returns uuid
language plpgsql as $$
declare
  v_role text := current_setting('role');
  v_claims text := current_setting('request.jwt.claims', true);
  v uuid;
begin
  perform set_config('role', 'postgres', true);
  select m.id into v from app.account_memberships m
  where m.org_id = pg_temp.id(p_account) and m.person_id = pg_temp.id(p_person) and m.deleted_at is null
    and (m.valid_to is null or m.valid_to > now());
  perform set_config('role', v_role, true);
  perform set_config('request.jwt.claims', coalesce(v_claims, ''), true);
  return v;
end $$;

-- Read as the platform; called only from it.
create function pg_temp.state(p_key text) returns text
language sql stable as $$
  select r.entry_state::text || '/' || r.person_response::text from app.engagement_roster_entries r where r.id = pg_temp.id(p_key)
$$;

select pg_temp.new_user('kai', 'kai@bayside-audio.test', 'Kai Morgan');
select pg_temp.new_user('mo', 'mo@bayside-audio.test', 'Mo Lindqvist');
select pg_temp.as_user('victor');
select app.add_account_member(pg_temp.id('acct_v'), pg_temp.id(p), 'Account Member') from unnest(array['kai', 'mo']) p;
select pg_temp.as_user('kai');
select app.accept_account_membership(pg_temp.membership('acct_v', 'kai'));
select pg_temp.as_user('mo');
select app.accept_account_membership(pg_temp.membership('acct_v', 'mo'));
select pg_temp.as_user('victor');
insert into world select 'e_kai', app.add_roster_entry(pg_temp.id('eng_vendor_a'), pg_temp.id('kai'));
insert into world select 'e_mo', app.add_roster_entry(pg_temp.id('eng_vendor_a'), pg_temp.id('mo'));

select pg_temp.as_user('kai');
select app.respond_roster_entry(pg_temp.id('e_kai'), 'Declined');

-- Submit ----------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('victor');
select is(app.submit_roster(pg_temp.id('eng_vendor_a')), 1, 'the submit moves only the entries nobody declined');
select pg_temp.as_platform();
select is(pg_temp.state('e_kai'), 'Draft/Declined', 'the declined entry stays a Draft for the lead to replace');
select is(pg_temp.state('e_mo'), 'Submitted/Pending', 'the other entry goes for review');
select pg_temp.as_user('victor');
select throws_like(format($$select app.submit_roster(%L)$$, pg_temp.id('eng_vendor_a')), 'roster_empty_submit:%',
  'a roster with only a declined entry left has nothing to submit');

-- Review ----------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('kai');
select app.respond_roster_entry(pg_temp.id('e_kai'), 'Accepted');
select pg_temp.as_user('victor');
select is(app.submit_roster(pg_temp.id('eng_vendor_a')), 1, 'once the person accepts, the entry is submitted');
select pg_temp.as_user('kai');
select app.respond_roster_entry(pg_temp.id('e_kai'), 'Declined');
select pg_temp.as_user('bob');
select throws_like(format($$select app.review_roster_entry(%L, 'Accepted')$$, pg_temp.id('e_kai')), 'roster_entry_declined:%',
  'the production cannot accept someone who declined while the entry waited for review');
select lives_ok(format($$select app.review_roster_entry(%L, 'Returned', 'Kai declined; name someone else.')$$, pg_temp.id('e_kai')),
  'it returns the entry instead');
select lives_ok(format($$select app.review_roster_entry(%L, 'Accepted')$$, pg_temp.id('e_mo')),
  'and accepts the person who did not decline');
select pg_temp.as_platform();
select is(pg_temp.state('e_kai'), 'Returned/Declined', 'the declined entry is back with the lead, never Accepted');

select * from finish();
rollback;

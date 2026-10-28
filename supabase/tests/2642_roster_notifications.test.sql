-- pgTAP: migrations 2641 and 2642 (R4), roster notifications. roster_entry.invited reaches the person put on a roster or
-- claiming an invitation, never someone adding themselves; roster_entry.returned reaches the roster's managers with the
-- reason; roster_entry.declined reaches the managers. A rostered person with no engagement or account membership of their
-- own is an external party of the producing org (2641), so private.notify reaches them.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

select no_plan();

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

create function pg_temp.notified(p_who text, p_kind text, p_entry text) returns integer
language sql as $$
  select count(*)::int from app.notifications n
  where n.recipient_person_id = pg_temp.id(p_who) and n.kind = p_kind and n.subject_id = pg_temp.id(p_entry)
    and n.subject_table = 'engagement_roster_entries'
$$;

select pg_temp.new_user('kai', 'kai@bayside-audio.test', 'Kai Morgan');
select pg_temp.new_user('pia', 'pia@bayside-audio.test', 'Pia Larsen');
select pg_temp.new_user('nell', 'nell@touring.test', 'Nell Okafor');
select pg_temp.as_user('victor');
select app.add_account_member(pg_temp.id('acct_v'), pg_temp.id(p), 'Account Member') from unnest(array['kai', 'pia']) p;
select pg_temp.as_user('kai');
select app.accept_account_membership(pg_temp.membership('acct_v', 'kai'));
select pg_temp.as_user('pia');
select app.accept_account_membership(pg_temp.membership('acct_v', 'pia'));
select pg_temp.as_user('victor');
select app.assign_engagement_member(pg_temp.id('eng_vendor_a'), pg_temp.membership('acct_v', 'pia'), 'Advancing Lead');
insert into world select 'e_kai', app.add_roster_entry(pg_temp.id('eng_vendor_a'), pg_temp.id('kai'));
select pg_temp.as_user('pia');
insert into world select 'e_pia', app.add_roster_entry(pg_temp.id('eng_vendor_a'), pg_temp.id('pia'));
select pg_temp.as_platform();

-- Invited ---------------------------------------------------------------------------------------------------------------------
select is(pg_temp.notified('kai', 'roster_entry.invited', 'e_kai'), 1, 'the person put on a roster is told');
select is((select message_args ->> 'partyName' from app.notifications where kind = 'roster_entry.invited' and subject_id = pg_temp.id('e_kai')),
  'Bayside Audio', 'with the party''s name');
select is((select message_args ->> 'projectName' from app.notifications where kind = 'roster_entry.invited' and subject_id = pg_temp.id('e_kai')),
  'Northwind Summer Series', 'and the project''s');
select is(pg_temp.notified('pia', 'roster_entry.invited', 'e_pia'), 0, 'adding oneself tells nobody');

select pg_temp.as_user('victor');
insert into world select 'e_nell', app.invite_to_roster(pg_temp.id('eng_vendor_a'), 'nell@touring.test');
select pg_temp.as_platform();
select is((select count(*)::int from app.notifications where subject_id = pg_temp.id('e_nell')), 0, 'an unclaimed invitation notifies nobody in the app');
select pg_temp.as_user('nell');
select app.respond_party_invitation('roster', (select i.invitation_id from app.my_pending_invitations() i where i.invitation_kind = 'roster'), true);
select pg_temp.as_platform();
select is(pg_temp.notified('nell', 'roster_entry.invited', 'e_nell'), 1, 'claiming an invitation tells the person they are on the roster');
select ok(pg_temp.id('org_a') in (select private.party_org_ids(pg_temp.id('nell'))), 'a rostered person is an external party of the producing org');

-- Returned ---------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('victor');
select app.submit_roster(pg_temp.id('eng_vendor_a'));
select pg_temp.as_user('bob');
select app.review_roster_entry(pg_temp.id('e_kai'), 'Returned', 'Add the arrival window.');
select pg_temp.as_platform();
select is(pg_temp.notified('victor', 'roster_entry.returned', 'e_kai'), 1, 'the account''s Owner is told of a return');
select is(pg_temp.notified('pia', 'roster_entry.returned', 'e_kai'), 1, 'and the Advancing Lead');
select is(pg_temp.notified('kai', 'roster_entry.returned', 'e_kai'), 0, 'not the rostered person');
select is((select message_args ->> 'reason' from app.notifications where kind = 'roster_entry.returned' and recipient_person_id = pg_temp.id('victor')
  and subject_id = pg_temp.id('e_kai')), 'Add the arrival window.', 'with the reason');
select pg_temp.as_user('bob');
select app.review_roster_entry(pg_temp.id('e_pia'), 'Accepted');
select pg_temp.as_platform();
select is((select count(*)::int from app.notifications where kind = 'roster_entry.returned' and subject_id = pg_temp.id('e_pia')), 0,
  'an acceptance sends no return notice');

-- Declined ---------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('kai');
select app.respond_roster_entry(pg_temp.id('e_kai'), 'Declined');
select pg_temp.as_platform();
select is(pg_temp.notified('victor', 'roster_entry.declined', 'e_kai'), 1, 'the Owner is told the person declined');
select is(pg_temp.notified('pia', 'roster_entry.declined', 'e_kai'), 1, 'and the Advancing Lead');
select pg_temp.as_user('kai');
select app.respond_roster_entry(pg_temp.id('e_kai'), 'Accepted');
select pg_temp.as_platform();
select is(pg_temp.notified('victor', 'roster_entry.declined', 'e_kai'), 1, 'accepting afterwards sends no decline');

select * from finish();
rollback;

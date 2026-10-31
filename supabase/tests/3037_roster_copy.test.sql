-- pgTAP: reusing a roster from a past event (3037, B14 G-252; ADR 0153 D4, C13). Bayside Audio supplies Northwind on
-- NWL and again on NWX, 28 days later. Its Account Owner, who manages both rosters, sees the past engagement as a source
-- and previews the reuse: an eligible team member is added as a Draft Pending entry with the arrival moved, an
-- unclaimed invitation is issued again, and the rest are skipped with reasons. The preview writes nothing and queues no
-- email; the commit writes the same rows and queues exactly one email per re-invited address. Nothing is submitted. The
-- producing org, the worker and a manager of neither roster get 42501; a source of another role is refused; a closed or
-- locked target is refused.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

select plan(19);

create temporary table pv (source_entry_id uuid, label text, outcome text, skip_reason text, arrival_window tstzrange);
create temporary table cm (like pv);
grant select, insert, delete on pv, cm to public;

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
create function pg_temp.entries(p_engagement text) returns integer
language sql as $$
  select count(*)::integer from app.engagement_roster_entries r
  where r.engagement_id = pg_temp.id(p_engagement) and r.deleted_at is null and not r.is_self
$$;
create function pg_temp.emails(p_to text) returns integer
language plpgsql as $$
declare
  v_role text := current_setting('role');
  v_claims text := current_setting('request.jwt.claims', true);
  v integer;
begin
  perform set_config('role', 'postgres', true);
  select count(*)::integer into v from private.platform_emails where template = 'party_invitation' and to_email = p_to;
  perform set_config('role', v_role, true);
  perform set_config('request.jwt.claims', coalesce(v_claims, ''), true);
  return v;
end $$;
create function pg_temp.outcome(p_label text) returns text
language sql as $$ select outcome || coalesce(':' || skip_reason, '') from pv where label = p_label $$;

-- Fixture: Bayside Audio's team (kai, mo, pia confirmed), NWL on 1 June and NWX on 29 June 2027, both engagements Active.
select pg_temp.new_user('kai', 'kai@bayside-audio.test', 'Kai Morgan');
select pg_temp.new_user('mo', 'mo@bayside-audio.test', 'Mo Lindqvist');
select pg_temp.new_user('pia', 'pia@bayside-audio.test', 'Pia Larsen');
select pg_temp.as_user('victor');
select app.add_account_member(pg_temp.id('acct_v'), pg_temp.id(p), 'Account Member') from unnest(array['kai', 'mo', 'pia']) p;
select pg_temp.as_user('kai');
select app.accept_account_membership(pg_temp.membership('acct_v', 'kai'));
select pg_temp.as_user('mo');
select app.accept_account_membership(pg_temp.membership('acct_v', 'mo'));
select pg_temp.as_user('pia');
select app.accept_account_membership(pg_temp.membership('acct_v', 'pia'));
select pg_temp.as_platform();
update app.projects set starts_on = '2027-06-01', ends_on = '2027-06-03' where id = pg_temp.id('prj_a');
update app.projects set starts_on = '2027-06-29', ends_on = '2027-07-01' where id = pg_temp.id('prj_a2');
select pg_temp.as_user('alice');
with x as (insert into app.engagements (project_id, person_id, counterparty_id, role_type, role_code, worker_classification, pay_basis,
    arrangement, start_date)
  values (pg_temp.id('prj_a2'), pg_temp.id('sam'), pg_temp.id('cp_v_a'), 'Vendor', '9000.50.02', 'VENDOR_SUPPLIED', 'Day Rate',
    'Per Engagement', '2027-06-29') returning id) insert into world select 'eng_vendor_a2', id from x;
with x as (insert into app.engagements (project_id, counterparty_id, role_type, start_date)
  values (pg_temp.id('prj_a'), pg_temp.id('cp_v_a'), 'Sponsor', '2027-06-01') returning id) insert into world select 'eng_sponsor', id from x;
select pg_temp.move_engagement('eng_vendor_a', 'Onboarding', 'Active');
select pg_temp.move_engagement('eng_vendor_a2', 'Onboarding', 'Active');

-- Last event's roster: pia with an arrival, kai (who later leaves the account), mo, an open invitation to nell and one to
-- quinn. This year's already has mo and quinn.
select pg_temp.as_user('victor');
insert into world select 'e_pia', app.add_roster_entry(pg_temp.id('eng_vendor_a'), pg_temp.id('pia'), '9000.50.02',
  '2027-06-01 13:00+00', '2027-06-01 15:00+00', 'America/New_York');
insert into world select 'e_kai', app.add_roster_entry(pg_temp.id('eng_vendor_a'), pg_temp.id('kai'));
insert into world select 'e_mo', app.add_roster_entry(pg_temp.id('eng_vendor_a'), pg_temp.id('mo'));
insert into world select 'e_nell', app.invite_to_roster(pg_temp.id('eng_vendor_a'), 'nell@touring.test', '9000.50.02');
insert into world select 'e_quinn', app.invite_to_roster(pg_temp.id('eng_vendor_a'), 'quinn@freelance.test');
select app.add_roster_entry(pg_temp.id('eng_vendor_a2'), pg_temp.id('mo'));
select app.invite_to_roster(pg_temp.id('eng_vendor_a2'), 'quinn@freelance.test');
select pg_temp.as_platform();
update app.account_memberships set deleted_at = now() where id = pg_temp.membership('acct_v', 'kai');

-- Sources ---------------------------------------------------------------------------------------------------------------------
select has_function('app', 'copy_roster_from_engagement', array['uuid', 'uuid', 'boolean'], 'app.copy_roster_from_engagement exists');
select pg_temp.as_user('victor');
select is((select string_agg(engagement_id::text || ':' || entries || ':' || invitations, ',') from app.roster_copy_sources(pg_temp.id('eng_vendor_a2'))),
  pg_temp.id('eng_vendor_a') || ':5:2', 'the Account Owner sees last event''s engagement with its entries and open invitations');
select pg_temp.as_user('carol');
select throws_ok(format('select * from app.roster_copy_sources(%L)', pg_temp.id('eng_vendor_a2')), '42501', null,
  'the producing org does not reuse a party''s roster');
select pg_temp.as_user('sam');
select throws_ok(format('select * from app.copy_roster_from_engagement(%L, %L)', pg_temp.id('eng_vendor_a2'), pg_temp.id('eng_vendor_a')),
  '42501', null, 'nor does the worker the engagement names, who manages no roster');

-- The preview ---------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('victor');
create temporary table before_counts as select pg_temp.entries('eng_vendor_a2') as entries, pg_temp.emails('nell@touring.test') as emails;
grant select on before_counts to public;
insert into pv select * from app.copy_roster_from_engagement(pg_temp.id('eng_vendor_a2'), pg_temp.id('eng_vendor_a'));
select is(pg_temp.outcome('Pia Larsen'), 'copy', 'an eligible team member is added');
select is((select arrival_window from pv where label = 'Pia Larsen'), tstzrange('2027-06-29 13:00+00', '2027-06-29 15:00+00', '[)'),
  'with the arrival moved 28 days on the wall clock');
select is(pg_temp.outcome('Kai Morgan'), 'skip:not_in_team', 'someone no longer in the team is skipped');
select is(pg_temp.outcome('Mo Lindqvist'), 'skip:already_on_roster', 'someone already on the roster is skipped');
select is(pg_temp.outcome('nell@touring.test'), 'invite', 'an unclaimed invitation is issued again');
select is(pg_temp.outcome('quinn@freelance.test'), 'skip:already_invited', 'an address already invited is skipped');
select is((select row(pg_temp.entries('eng_vendor_a2'), pg_temp.emails('nell@touring.test'))::text),
  (select row(entries, emails)::text from before_counts), 'the preview adds no entry and queues no email');

-- The commit ---------------------------------------------------------------------------------------------------------------------
insert into cm select * from app.copy_roster_from_engagement(pg_temp.id('eng_vendor_a2'), pg_temp.id('eng_vendor_a'), true);
select results_eq('select source_entry_id, outcome, skip_reason, arrival_window from cm order by source_entry_id',
  'select source_entry_id, outcome, skip_reason, arrival_window from pv order by source_entry_id', 'the commit returns the preview''s rows');
select pg_temp.as_platform();
select is((select row(r.entry_state, r.person_response, r.arrival_window)::text from app.engagement_roster_entries r
           where r.engagement_id = pg_temp.id('eng_vendor_a2') and r.person_id = pg_temp.id('pia')),
  row('Draft', 'Pending', tstzrange('2027-06-29 13:00+00', '2027-06-29 15:00+00', '[)'))::text,
  'pia is a Draft entry the person still accepts, nothing submitted');
select is(pg_temp.emails('nell@touring.test') - (select emails from before_counts), 1, 'the re-invitation queues exactly one email');
select is((select count(*)::integer from app.roster_invitations i join app.engagement_roster_entries r on r.id = i.roster_entry_id
           where r.engagement_id = pg_temp.id('eng_vendor_a2') and i.email = 'nell@touring.test' and i.revoked_at is null), 1,
  'to the address of the past invitation');
select is((select count(*)::integer from app.engagement_roster_entries r where r.engagement_id = pg_temp.id('eng_vendor_a2')
           and r.entry_state <> 'Draft' and not r.is_self), 0, 'every reused entry stays a Draft');

-- Refusals ------------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('victor');
select throws_ok(format('select * from app.copy_roster_from_engagement(%L, %L)', pg_temp.id('eng_vendor_a2'), pg_temp.id('eng_sponsor')),
  'XR001', 'roster_copy_source: Reuse a roster of the same company or artist with the same organization.',
  'a source of another role is refused');
select pg_temp.as_user('carol');
select app.set_roster_lock(pg_temp.id('eng_vendor_a2'), now() - interval '1 minute');
select pg_temp.as_user('victor');
select throws_ok(format('select * from app.copy_roster_from_engagement(%L, %L)', pg_temp.id('eng_vendor_a2'), pg_temp.id('eng_vendor_a')),
  'XR001', 'roster_locked: Names are locked on this engagement. Ask the producing organization to change the roster.',
  'a locked target is refused before anything is copied');
select pg_temp.move_engagement('eng_vendor_a2', 'Active', 'Canceled');
select pg_temp.as_user('victor');
select throws_ok(format('select * from app.copy_roster_from_engagement(%L, %L)', pg_temp.id('eng_vendor_a2'), pg_temp.id('eng_vendor_a')),
  'XR001', 'roster_closed: This engagement is complete or canceled, so its roster is closed.', 'a closed target is refused');

select * from finish();
rollback;

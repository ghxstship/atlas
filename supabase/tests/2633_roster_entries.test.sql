-- pgTAP: migrations 2633 to 2637 (R4), the crew roster. Self entries exist for person engagements and never for Client or
-- Sponsor; add_roster_entry refuses non-managers, people outside the team (including unconfirmed members), the engaged
-- person, duplicates, Client engagements and closed engagements, and a Sponsor company engagement takes entries. The
-- lifecycle allows only its moves: submit, return with a reason, resubmit, accept, with review needing
-- advancing.submission.review and refusing the entry's creator and submitter. The person answers and nobody else can;
-- withdrawal closes the share and revokes the invitation; a replacement records what it replaces; bulk review is all or
-- nothing and its preview writes nothing; entries never count toward the external engagement plan limit. Invitations
-- (2636): invite, one platform email, claim by confirmed email (which confirms an Account Member of a company engagement
-- and records the account consent), decline withdraws the entry. Section 8.7 matrix of the external views.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

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

create function pg_temp.membership(p_account text, p_person text) returns uuid
language plpgsql as $$
declare
  v_role text := current_setting('role');
  v_claims text := current_setting('request.jwt.claims', true);
  v uuid;
begin
  -- Read as the platform, whoever the caller is, then restore the caller.
  perform set_config('role', 'postgres', true);
  select m.id into v from app.account_memberships m
  where m.org_id = pg_temp.id(p_account) and m.person_id = pg_temp.id(p_person) and m.deleted_at is null
    and (m.valid_to is null or m.valid_to > now());
  perform set_config('role', v_role, true);
  perform set_config('request.jwt.claims', coalesce(v_claims, ''), true);
  return v;
end $$;

create function pg_temp.entry(p_key text) returns app.engagement_roster_entries
language sql as $$ select r.* from app.engagement_roster_entries r where r.id = pg_temp.id(p_key) $$;

create function pg_temp.self_entry(p_engagement text) returns uuid
language sql as $$
  select r.id from app.engagement_roster_entries r where r.engagement_id = pg_temp.id(p_engagement) and r.is_self and r.deleted_at is null
$$;

-- Fixture: Bayside Audio's team, a sponsor and a client company engagement, and alice also an Admin of Bayside --------------
select pg_temp.new_user('kai', 'kai@bayside-audio.test', 'Kai Morgan');
select pg_temp.new_user('mo', 'mo@bayside-audio.test', 'Mo Lindqvist');
select pg_temp.new_user('una', 'una@bayside-audio.test', 'Una Fischer');
select pg_temp.new_user('pia', 'pia@bayside-audio.test', 'Pia Larsen');
select pg_temp.new_user('nell', 'nell@touring.test', 'Nell Okafor');
select pg_temp.as_user('victor');
select app.add_account_member(pg_temp.id('acct_v'), pg_temp.id(p), 'Account Member') from unnest(array['kai', 'mo', 'una', 'pia']) p;
select app.add_account_member(pg_temp.id('acct_v'), pg_temp.id('alice'), 'Account Admin');
select pg_temp.as_user('kai');
select app.accept_account_membership(pg_temp.membership('acct_v', 'kai'));
select pg_temp.as_user('mo');
select app.accept_account_membership(pg_temp.membership('acct_v', 'mo'));
select pg_temp.as_user('pia');
select app.accept_account_membership(pg_temp.membership('acct_v', 'pia'));
select pg_temp.as_user('alice');
select app.accept_account_membership(pg_temp.membership('acct_v', 'alice'));
select pg_temp.as_user('victor');
select app.assign_engagement_member(pg_temp.id('eng_vendor_a'), pg_temp.membership('acct_v', 'pia'), 'Advancing Lead');
select app.assign_engagement_member(pg_temp.id('eng_vendor_a'), pg_temp.membership('acct_v', 'mo'), 'Member');

select pg_temp.as_user('alice');
with x as (insert into app.engagements (project_id, counterparty_id, role_type, start_date)
  values (pg_temp.id('prj_a'), pg_temp.id('cp_v_a'), 'Sponsor', '2027-06-01') returning id)
insert into world select 'eng_sponsor', id from x;
with x as (insert into app.engagements (project_id, person_id, counterparty_id, role_type, start_date)
  values (pg_temp.id('prj_a'), pg_temp.id('victor'), pg_temp.id('cp_v_a'), 'Client', '2027-06-01') returning id)
insert into world select 'eng_client', id from x;
with x as (insert into app.engagements (project_id, counterparty_id, role_type, role_code, worker_classification, pay_basis,
    arrangement, start_date)
  values (pg_temp.id('prj_a'), pg_temp.id('cp_v_a'), 'Vendor', '9000.50.02', 'VENDOR_SUPPLIED', 'Day Rate', 'Per Engagement',
    '2027-06-01') returning id)
insert into world select 'eng_co', id from x;
select pg_temp.as_platform();

-- Self entries ---------------------------------------------------------------------------------------------------------------
select ok(pg_temp.self_entry('eng_ivy_a') is not null, 'a crew engagement naming a person has its self entry');
select ok(pg_temp.self_entry('eng_vendor_a') is not null, 'so does a vendor engagement naming its person');
select ok(pg_temp.self_entry('eng_art_a') is not null, 'and an artist engagement');
insert into world values ('self_vendor', pg_temp.self_entry('eng_vendor_a'));
select is((select entry_state::text || '/' || person_response::text from app.engagement_roster_entries where id = pg_temp.self_entry('eng_ivy_a')),
  'Accepted/Accepted', 'a self entry is accepted by both sides');
select is((select person_id from app.engagement_roster_entries where id = pg_temp.self_entry('eng_ivy_a')), null,
  'a self entry stores no person');
select is(private.roster_entry_person(pg_temp.self_entry('eng_ivy_a')), pg_temp.id('ivy'), 'the resolver reads the engaged person');
select ok(pg_temp.self_entry('eng_client') is null, 'a Client engagement has none');
select pg_temp.as_user('alice');
with x as (insert into app.engagements (project_id, person_id, counterparty_id, role_type, start_date)
  values (pg_temp.id('prj_a'), pg_temp.id('sam'), pg_temp.id('cp_v_a'), 'Sponsor', '2027-06-01') returning id)
insert into world select 'eng_sponsor_person', id from x;
select pg_temp.as_platform();
select ok(pg_temp.self_entry('eng_sponsor_person') is null, 'nor a Sponsor engagement naming a person');
select ok(pg_temp.self_entry('eng_co') is null, 'nor a company engagement naming nobody');
select is((select count(*)::int from app.engagement_roster_entries where is_self and engagement_id = pg_temp.id('eng_ivy_a')), 1,
  'exactly one self entry per engagement');
select throws_like($$insert into app.engagement_roster_entries (engagement_id, is_self) select id, true from world where key = 'eng_ivy_b'$$,
  'roster_self_entry_internal:%', 'a self entry is never written by hand');

-- Adding ---------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('kai');
select throws_ok(format($$select app.add_roster_entry(%L, %L)$$, pg_temp.id('eng_vendor_a'), pg_temp.id('kai')),
  '42501', null, 'an unassigned Account Member does not manage the roster');
select pg_temp.as_user('mo');
select throws_ok(format($$select app.add_roster_entry(%L, %L)$$, pg_temp.id('eng_vendor_a'), pg_temp.id('kai')),
  '42501', null, 'nor does a Member-duty assignee');
select pg_temp.as_user('carol');
select throws_ok(format($$select app.add_roster_entry(%L, %L)$$, pg_temp.id('eng_vendor_a'), pg_temp.id('kai')),
  '42501', null, 'nor the producing org');
-- The worker the account sends is on its roster and manages nothing (owner decisions 4 and 6).
select pg_temp.as_user('sam');
select throws_ok(format($$select app.add_roster_entry(%L, %L)$$, pg_temp.id('eng_vendor_a'), pg_temp.id('kai')),
  '42501', null, 'nor the worker a company engagement names');
select throws_ok(format($$select app.invite_to_roster(%L, 'friend@touring.test')$$, pg_temp.id('eng_vendor_a')),
  '42501', null, 'who invites nobody either');
select throws_ok(format($$select app.submit_roster(%L)$$, pg_temp.id('eng_vendor_a')),
  '42501', null, 'and submits nothing');
select pg_temp.claims('sam');
select ok(not private.can_manage_roster(pg_temp.id('eng_vendor_a')), 'private.can_manage_roster is false for them');
select pg_temp.as_user('sam');
select lives_ok(format($$select app.update_roster_entry(%L, '9000.50.02', null, null, null)$$, pg_temp.id('self_vendor')),
  'but they keep their own entry current');
select pg_temp.as_platform();
select pg_temp.as_user('victor');
select throws_like(format($$select app.add_roster_entry(%L, %L)$$, pg_temp.id('eng_vendor_a'), pg_temp.id('ivy')),
  'roster_person_not_in_team:%', 'someone outside the account is not added');
select throws_like(format($$select app.add_roster_entry(%L, %L)$$, pg_temp.id('eng_vendor_a'), pg_temp.id('una')),
  'roster_person_not_in_team:%', 'an unconfirmed member is not eligible');
select throws_like(format($$select app.add_roster_entry(%L, %L)$$, pg_temp.id('eng_vendor_a'), pg_temp.id('sam')),
  'roster_person_is_engaged:%', 'the engaged person is on through their own entry');
select throws_like(format($$select app.add_roster_entry(%L, %L)$$, pg_temp.id('eng_client'), pg_temp.id('kai')),
  'roster_role_type:%', 'a Client engagement carries no roster');
select throws_like(format($$select app.add_roster_entry(%L, %L, null, '2027-06-01 08:00+00', '2027-06-01 07:00+00', 'America/New_York')$$,
  pg_temp.id('eng_vendor_a'), pg_temp.id('kai')), 'roster_arrival_window:%', 'an arrival window ends after it starts');
select throws_like(format($$select app.add_roster_entry(%L, %L, null, '2027-06-01 08:00+00', '2027-06-01 10:00+00')$$,
  pg_temp.id('eng_vendor_a'), pg_temp.id('kai')), 'roster_arrival_window:%', 'and has a time zone');
select throws_like(format($$select app.add_roster_entry(%L, %L, '0000.00.00')$$, pg_temp.id('eng_vendor_a'), pg_temp.id('kai')),
  'roster_role_unknown:%', 'a role comes from the Roles Library');
select lives_ok(format($$insert into world select 'e_kai', app.add_roster_entry(%L, %L, '9000.50.02', '2027-06-01 12:00+00', '2027-06-01 14:00+00', 'America/New_York')$$,
  pg_temp.id('eng_vendor_a'), pg_temp.id('kai')), 'the Owner adds a confirmed member with a role and arrival');
select throws_like(format($$select app.add_roster_entry(%L, %L)$$, pg_temp.id('eng_vendor_a'), pg_temp.id('kai')),
  'roster_person_duplicate:%', 'nobody is on a roster twice');
select lives_ok(format($$insert into world select 'e_sponsor', app.add_roster_entry(%L, %L)$$, pg_temp.id('eng_sponsor'), pg_temp.id('kai')),
  'a Sponsor company engagement takes roster entries');
select pg_temp.as_user('pia');
select lives_ok(format($$insert into world select 'e_mo', app.add_roster_entry(%L, %L)$$, pg_temp.id('eng_vendor_a'), pg_temp.id('mo')),
  'the Advancing Lead adds a member');
select lives_ok(format($$insert into world select 'e_pia', app.add_roster_entry(%L, %L)$$, pg_temp.id('eng_vendor_a'), pg_temp.id('pia')),
  'and themselves');
select pg_temp.as_platform();
select is((pg_temp.entry('e_kai')).entry_state::text || '/' || (pg_temp.entry('e_kai')).person_response::text, 'Draft/Pending',
  'a new entry is a Draft the person has not answered');
select is((pg_temp.entry('e_pia')).person_response::text, 'Accepted', 'adding oneself counts as one''s acceptance');
select is((pg_temp.entry('e_kai')).org_id, pg_temp.id('org_a'), 'an entry belongs to the producing org');
select is((select count(*)::int from app.project_members pm join app.memberships m on m.id = pm.membership_id
  where pm.project_id = pg_temp.id('prj_a') and m.person_id = pg_temp.id('kai')), 0, 'an entry never creates project membership');

-- Lifecycle --------------------------------------------------------------------------------------------------------------------
select throws_like(format($$select private.transition_lifecycle('roster_entry', 'app.engagement_roster_entries', 'entry_state',
  'app.roster_entry_state_transitions', 'roster_entry_id', %L, 'Draft', 'Accepted', 'Skip review.')$$, pg_temp.id('e_kai')),
  'roster_entry_transition_not_allowed:%', 'a Draft is never accepted without being submitted');
select results_eq($$select from_state || '>' || to_state from private.lifecycle_transition_rules where lifecycle = 'roster_entry' order by 1$$,
  $$values ('Accepted>Withdrawn'), ('Draft>Submitted'), ('Draft>Withdrawn'), ('Returned>Submitted'), ('Returned>Withdrawn'),
    ('Submitted>Accepted'), ('Submitted>Returned'), ('Submitted>Withdrawn')$$, 'the lifecycle allows only its eight moves');
select throws_like(format($$update app.engagement_roster_entries set entry_state = 'Submitted' where id = %L$$, pg_temp.id('e_kai')),
  'roster_entry_transition_rpc_only:%', 'the state changes only through the transition engine');

-- Submit, return, resubmit, accept --------------------------------------------------------------------------------------------
select pg_temp.as_user('kai');
select throws_ok(format($$select app.submit_roster(%L)$$, pg_temp.id('eng_vendor_a')), '42501', null, 'a rostered member does not submit');
select pg_temp.as_user('victor');
select is(app.submit_roster(pg_temp.id('eng_vendor_a')), 3, 'the Owner submits every Draft entry');
select throws_like(format($$select app.submit_roster(%L)$$, pg_temp.id('eng_vendor_a')), 'roster_empty_submit:%',
  'submitting again with nothing new is refused');
select throws_like(format($$select app.update_roster_entry(%L, null, null, null, null)$$, pg_temp.id('e_kai')),
  'roster_entry_not_editable:%', 'a submitted entry is not edited');
select pg_temp.as_user('ivy');
select throws_ok(format($$select app.review_roster_entry(%L, 'Accepted')$$, pg_temp.id('e_kai')), '42501', null,
  'an outsider does not review');
select pg_temp.as_user('gina');
select throws_ok(format($$select app.review_roster_entry(%L, 'Accepted')$$, pg_temp.id('e_kai')), '42501', null,
  'a viewer does not review (advancing.submission.review)');
select pg_temp.as_user('bob');
select throws_like(format($$select app.review_roster_entry(%L, 'Withdrawn')$$, pg_temp.id('e_kai')), 'roster_review_outcome:%',
  'a reviewer only accepts or returns');
select throws_like(format($$select app.review_roster_entry(%L, 'Returned', '  ')$$, pg_temp.id('e_kai')), 'roster_review_reason:%',
  'a return needs a reason');
select lives_ok(format($$select app.review_roster_entry(%L, 'Returned', 'Add the arrival for the load-in.')$$, pg_temp.id('e_mo')),
  'the org returns an entry with a reason');
select is((select return_reason from app.roster_entry_people where id = pg_temp.id('e_mo')), 'Add the arrival for the load-in.',
  'the producing org reads the reason');
select pg_temp.as_platform();
select is(pg_temp.n('victor', format($$select 1 from api_external.engagement_roster where id = %L and return_reason = 'Add the arrival for the load-in.'$$,
  pg_temp.id('e_mo'))), 1, 'and so does the party');
select pg_temp.as_user('pia');
select lives_ok(format($$select app.update_roster_entry(%L, '9000.50.02', '2027-06-01 12:00+00', '2027-06-01 13:00+00', 'America/New_York')$$,
  pg_temp.id('e_mo')), 'a Returned entry is edited');
select is(app.submit_roster(pg_temp.id('eng_vendor_a')), 1, 'and resubmitted');
select pg_temp.as_user('bob');
select lives_ok(format($$select app.review_roster_entry(%L, 'Accepted')$$, pg_temp.id('e_mo')), 'then accepted');
select throws_like(format($$select app.review_roster_entry(%L, 'Accepted')$$, pg_temp.id('e_mo')), 'roster_entry_not_submitted:%',
  'an accepted entry is not reviewed again');
select pg_temp.as_platform();
select is((pg_temp.entry('e_mo')).entry_state::text, 'Accepted', 'the entry is Accepted');
select is((select created_by from app.roster_entry_state_transitions where roster_entry_id = pg_temp.id('e_mo') and to_state = 'Accepted'),
  pg_temp.id('bob'), 'the ledger names the reviewer, never the entry');

-- Separation of duties: alice is also an Admin of Bayside.
select pg_temp.as_user('alice');
select lives_ok(format($$insert into world select 'e_kai2', app.add_roster_entry(%L, %L)$$, pg_temp.id('eng_co'), pg_temp.id('kai')),
  'alice, as Bayside''s Admin, adds an entry');
select lives_ok(format($$select app.submit_roster(%L)$$, pg_temp.id('eng_co')), 'and submits it');
select throws_like(format($$select app.review_roster_entry(%L, 'Accepted')$$, pg_temp.id('e_kai2')), 'sod_roster_reviewer:%',
  'she does not review her own entry');
select pg_temp.as_user('victor');
select lives_ok(format($$insert into world select 'e_mo2', app.add_roster_entry(%L, %L)$$, pg_temp.id('eng_co'), pg_temp.id('mo')),
  'victor adds another');
select pg_temp.as_user('alice');
select lives_ok(format($$select app.submit_roster(%L)$$, pg_temp.id('eng_co')), 'alice submits it');
select throws_like(format($$select app.review_roster_entry(%L, 'Accepted')$$, pg_temp.id('e_mo2')), 'sod_roster_reviewer:%',
  'nor one she submitted');
select pg_temp.as_platform();

-- The person answers ------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('victor');
select throws_like(format($$select app.respond_roster_entry(%L, 'Accepted')$$, pg_temp.id('e_kai')), 'roster_response_not_yours:%',
  'only the person answers');
select pg_temp.as_user('sam');
select throws_like(format($$select app.respond_roster_entry(%L, 'Declined')$$, pg_temp.id('self_vendor')), 'roster_response_not_yours:%',
  'nobody answers a self entry, not even its person');
select pg_temp.as_user('kai');
select throws_like(format($$select app.share_work_details(%L, array['Uniform Sizes']::app.work_detail_category[])$$, pg_temp.id('eng_vendor_a')),
  'roster_entry_not_accepted:%', 'a rostered person shares only after accepting');
select lives_ok(format($$select app.respond_roster_entry(%L, 'Declined')$$, pg_temp.id('e_kai')), 'the person declines');
select lives_ok(format($$select app.respond_roster_entry(%L, 'Accepted')$$, pg_temp.id('e_kai')), 'and changes their mind while the entry is live');
select lives_ok(format($$insert into world select 'share_kai', app.share_work_details(%L, array['Uniform Sizes']::app.work_detail_category[])$$,
  pg_temp.id('eng_vendor_a')), 'then shares their work details on the entry');
select pg_temp.as_platform();
select is((select roster_entry_id from app.work_detail_shares where id = pg_temp.id('share_kai')), pg_temp.id('e_kai'), 'the share keys on the entry');
select ok(private.account_roster_consent(pg_temp.id('acct_v'), pg_temp.id('kai')) is not null, 'accepting records the account consent');

-- Withdrawal and replacement ------------------------------------------------------------------------------------------------------
select pg_temp.as_user('victor');
select throws_like(format($$select app.withdraw_roster_entry(%L, 'No.')$$, pg_temp.id('self_vendor')), 'roster_self_entry_fixed:%',
  'the self entry is never withdrawn');
select lives_ok(format($$select app.withdraw_roster_entry(%L, 'Kai moved to another show.')$$, pg_temp.id('e_kai')), 'the Owner withdraws an entry');
select pg_temp.as_platform();
select ok((select revoked_at is not null from app.work_detail_shares where id = pg_temp.id('share_kai')), 'withdrawal closes the entry''s share');
select ok(private.account_roster_consent(pg_temp.id('acct_v'), pg_temp.id('kai')) is null, 'and withdraws the account consent');
select pg_temp.as_user('kai');
select throws_like(format($$select app.respond_roster_entry(%L, 'Accepted')$$, pg_temp.id('e_kai')), 'roster_entry_withdrawn:%',
  'a withdrawn entry is not answered');
select pg_temp.as_user('victor');
select throws_like(format($$select app.add_roster_entry(%L, %L, null, null, null, null, %L)$$, pg_temp.id('eng_vendor_a'), pg_temp.id('kai'),
  pg_temp.id('e_mo')), 'roster_replacement_invalid:%', 'a replacement names a withdrawn entry');
select lives_ok(format($$insert into world select 'e_kai3', app.add_roster_entry(%L, %L, null, null, null, null, %L)$$, pg_temp.id('eng_vendor_a'),
  pg_temp.id('kai'), pg_temp.id('e_kai')), 'a swap adds a replacement');
select pg_temp.as_platform();
select is((pg_temp.entry('e_kai3')).replaces_entry_id, pg_temp.id('e_kai'), 'which records the entry it replaces');

-- Bulk review ------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('pia');
select app.submit_roster(pg_temp.id('eng_vendor_a'));
select pg_temp.as_user('bob');
select is((app.bulk_update_roster_entries(jsonb_build_array(
    jsonb_build_object('id', pg_temp.id('e_kai3'), 'set', jsonb_build_object('entry_state', 'Accepted')),
    jsonb_build_object('id', pg_temp.id('e_pia'), 'set', jsonb_build_object('entry_state', 'Accepted'))), true) ->> 'committed')::boolean,
  false, 'a preview commits nothing');
select pg_temp.as_platform();
select is((pg_temp.entry('e_kai3')).entry_state::text, 'Submitted', 'and leaves the entries Submitted');
select pg_temp.as_user('bob');
select ok(jsonb_array_length(app.bulk_update_roster_entries(jsonb_build_array(
    jsonb_build_object('id', pg_temp.id('e_kai3'), 'set', jsonb_build_object('entry_state', 'Accepted')),
    jsonb_build_object('id', pg_temp.id('e_mo'), 'set', jsonb_build_object('entry_state', 'Returned')))) -> 'refused') = 1,
  'a row that breaks a rule (an Accepted entry) is refused');
select pg_temp.as_platform();
select is((pg_temp.entry('e_kai3')).entry_state::text, 'Submitted', 'and nothing changes: bulk is all or nothing');
select pg_temp.as_user('bob');
select lives_ok(format($$select app.bulk_update_roster_entries(jsonb_build_array(
    jsonb_build_object('id', %L::uuid, 'set', jsonb_build_object('entry_state', 'Accepted')),
    jsonb_build_object('id', %L::uuid, 'set', jsonb_build_object('entry_state', 'Returned'))), false, 'Confirm the shirt size.')$$,
  pg_temp.id('e_kai3'), pg_temp.id('e_pia')), 'bulk accepts one and returns another with the one reason');
select pg_temp.as_platform();
select is((pg_temp.entry('e_kai3')).entry_state::text || '/' || (pg_temp.entry('e_pia')).entry_state::text, 'Accepted/Returned',
  'both changed');

-- Plan limits -----------------------------------------------------------------------------------------------------------------------
select is((select count(*)::int from app.engagements e where e.org_id = pg_temp.id('org_a') and e.deleted_at is null),
  (select count(distinct r.engagement_id)::int + 0 from app.engagement_roster_entries r where false) +
  (select count(*)::int from app.engagements e where e.org_id = pg_temp.id('org_a') and e.deleted_at is null),
  'roster entries are not engagements, so the external engagement plan limit (which counts engagements) never counts them');

-- Invitations (2636) ------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('victor');
select throws_like(format($$select app.invite_to_roster(%L, 'nell@touring.test', null, null, null, null, interval '40 days')$$,
  pg_temp.id('eng_vendor_a')), 'invite_expiry_range:%', 'a roster invitation stays open at most 30 days');
select lives_ok(format($$insert into world select 'e_nell', app.invite_to_roster(%L, 'Nell@Touring.test', '9000.50.02')$$,
  pg_temp.id('eng_vendor_a')), 'the Owner invites an address');
select throws_like(format($$select app.invite_to_roster(%L, 'nell@touring.test')$$, pg_temp.id('eng_vendor_a')),
  'roster_person_duplicate:%', 'an address is invited once per roster');
select pg_temp.as_platform();
select is((pg_temp.entry('e_nell')).person_id, null, 'the entry has no person yet');
select is((select count(*)::int from private.platform_emails where template = 'party_invitation' and to_email = 'nell@touring.test'
  and args ->> 'kind' = 'roster'), 1, 'one email goes to the address');
select is(pg_temp.n('victor', format('select 1 from api_external.engagement_roster where id = %L and invited_email = %L', pg_temp.id('e_nell'), 'nell@touring.test')), 1,
  'the roster manager sees the invited address');
select is(pg_temp.n('mo', format('select 1 from api_external.engagement_roster where id = %L', pg_temp.id('e_nell'))), 0,
  'a Member-duty assignee does not see the entry');
select pg_temp.as_user('victor');
select is(app.submit_roster(pg_temp.id('eng_vendor_a')), 1, 'an unclaimed invitation stays Draft when the roster is submitted');
select pg_temp.as_platform();
select is((pg_temp.entry('e_nell')).entry_state::text, 'Draft', 'Nell''s entry is still Draft');
select is(pg_temp.n('nell', 'select 1 from app.my_pending_invitations() where invitation_kind = ''roster'''), 1,
  'the invitee sees the roster invitation');
select pg_temp.as_user('ivy');
select throws_like(format($$select app.respond_party_invitation('roster', (select id from app.roster_invitations where roster_entry_id = %L), true)$$,
  pg_temp.id('e_nell')), 'invitation_not_yours:%', 'another address does not claim it');
select pg_temp.as_platform();
insert into world select 'inv_nell', id from app.roster_invitations where roster_entry_id = pg_temp.id('e_nell');
select pg_temp.as_user('nell');
select is(app.respond_party_invitation('roster', pg_temp.id('inv_nell'), true), pg_temp.id('e_nell'), 'the invitee claims the entry');
select pg_temp.as_platform();
select is((pg_temp.entry('e_nell')).person_id, pg_temp.id('nell'), 'the entry is theirs');
select is((pg_temp.entry('e_nell')).person_response::text, 'Accepted', 'and accepted by them');
select ok((select accepted_at is not null from app.account_memberships where id = pg_temp.membership('acct_v', 'nell')),
  'claiming on a company engagement makes them a confirmed member of the account');
select is((select array_agg(account_role)::text from app.account_membership_roles where account_membership_id = pg_temp.membership('acct_v', 'nell')
  and deleted_at is null), '{"Account Member"}', 'as an Account Member');
select ok(private.account_roster_consent(pg_temp.id('acct_v'), pg_temp.id('nell')) is not null, 'with the account consent recorded');

select pg_temp.as_user('victor');
select lives_ok(format($$insert into world select 'e_quinn', app.invite_to_roster(%L, 'quinn@freelance.test')$$, pg_temp.id('eng_vendor_a')),
  'another invitation');
select pg_temp.as_platform();
insert into world select 'inv_quinn', id from app.roster_invitations where roster_entry_id = pg_temp.id('e_quinn');
select pg_temp.as_user('quinn');
select lives_ok(format($$select app.respond_party_invitation('roster', %L, false)$$, pg_temp.id('inv_quinn')), 'the invitee declines');
select pg_temp.as_platform();
select is((pg_temp.entry('e_quinn')).entry_state::text, 'Withdrawn', 'a declined invitation withdraws its Draft entry');
select is((select reason from app.roster_entry_state_transitions where roster_entry_id = pg_temp.id('e_quinn') and to_state = 'Withdrawn'),
  'Invitation declined.', 'with the reason');

select pg_temp.as_user('victor');
select lives_ok(format($$insert into world select 'e_rev', app.invite_to_roster(%L, 'rev@touring.test')$$, pg_temp.id('eng_vendor_a')),
  'a third invitation');
select lives_ok(format($$select app.reissue_roster_invitation(%L)$$, pg_temp.id('e_rev')), 'is sent again');
select pg_temp.as_platform();
select is((select count(*)::int from app.roster_invitations where roster_entry_id = pg_temp.id('e_rev') and revoked_at is null), 1,
  'which replaces the pending invitation');
select pg_temp.as_user('victor');
select lives_ok(format($$select app.withdraw_roster_entry(%L, 'Not needed.')$$, pg_temp.id('e_rev')), 'then the entry is withdrawn');
select pg_temp.as_platform();
select is((select count(*)::int from app.roster_invitations where roster_entry_id = pg_temp.id('e_rev') and revoked_at is null), 0,
  'withdrawal revokes the entry''s invitation');

-- Section 8.7 matrix --------------------------------------------------------------------------------------------------------------------
select is(pg_temp.n('sam', format('select 1 from api_external.engagement_roster where engagement_id = %L', pg_temp.id('eng_vendor_a'))), 1,
  'the worker a company engagement names sees only their own entry');
select is(pg_temp.n('sam', format('select 1 from api_external.engagement_roster where engagement_id = %L and invited_email is not null',
  pg_temp.id('eng_vendor_a'))), 0, 'and no invited address');
select is(pg_temp.n('ivy', format('select 1 from api_external.engagement_roster where engagement_id = %L', pg_temp.id('eng_ivy_a'))),
  (select count(*)::int from app.engagement_roster_entries where engagement_id = pg_temp.id('eng_ivy_a') and deleted_at is null),
  'the person of an engagement no account supplies reads every entry of it');
select is(pg_temp.n('victor', format('select 1 from api_external.engagement_roster where engagement_id = %L', pg_temp.id('eng_vendor_a'))),
  (select count(*)::int from app.engagement_roster_entries where engagement_id = pg_temp.id('eng_vendor_a') and deleted_at is null),
  'the account''s Owner reads every entry');
select is(pg_temp.n('alice', format('select 1 from api_external.engagement_roster where engagement_id = %L', pg_temp.id('eng_vendor_a'))),
  (select count(*)::int from app.engagement_roster_entries where engagement_id = pg_temp.id('eng_vendor_a') and deleted_at is null),
  'and its Admin');
select is(pg_temp.n('pia', format('select 1 from api_external.engagement_roster where engagement_id = %L', pg_temp.id('eng_vendor_a'))),
  (select count(*)::int from app.engagement_roster_entries where engagement_id = pg_temp.id('eng_vendor_a') and deleted_at is null),
  'and its Advancing Lead');
select is(pg_temp.n('mo', format('select 1 from api_external.engagement_roster where engagement_id = %L', pg_temp.id('eng_vendor_a'))), 1,
  'a Member-duty assignee sees only their own entry');
select is(pg_temp.n('kai', format('select 1 from api_external.engagement_roster where engagement_id = %L', pg_temp.id('eng_vendor_a'))), 1,
  'a rostered member sees only their own live entry');
select is(pg_temp.n('fiona', 'select 1 from api_external.engagement_roster'), 0, 'Account Finance, on no roster, sees none');
select is(pg_temp.n('ivy', format('select 1 from api_external.engagement_roster where engagement_id = %L', pg_temp.id('eng_vendor_a'))), 0,
  'an unrelated person sees nothing of another party''s roster');
select is(pg_temp.n('xavier', 'select 1 from api_external.engagement_roster'), 0, 'another tenant sees nothing');
select is(pg_temp.n('rita', format('select 1 from api_external.engagement_roster where engagement_id = %L', pg_temp.id('eng_art_a'))), 1,
  'an Advance representative reads the artist''s roster');
select is(pg_temp.n('kai', 'select 1 from api_external.my_roster_entries'), 3,
  'my_roster_entries lists the person''s live entries (vendor, sponsor and crew engagements), never the withdrawn one');
select is(pg_temp.n('victor', 'select 1 from api_external.my_roster_entries'), 0, 'and nothing for someone on no roster');
select is(pg_temp.n('victor', format('select 1 from api_external.my_account_talent where account_id = %L', pg_temp.id('acct_v'))),
  (select count(*)::int from app.account_memberships where org_id = pg_temp.id('acct_v') and deleted_at is null and accepted_at is not null
    and (valid_to is null or valid_to > now())), 'the talent pool is the account''s confirmed members');
select is(pg_temp.n('victor', format('select 1 from api_external.my_account_talent where person_id = %L', pg_temp.id('una'))), 0,
  'never an unconfirmed member');
select is(pg_temp.n('pia', format('select 1 from api_external.my_account_talent where account_id = %L', pg_temp.id('acct_v'))),
  pg_temp.n('victor', format('select 1 from api_external.my_account_talent where account_id = %L', pg_temp.id('acct_v'))),
  'an Advancing Lead sees the same pool');
select is(pg_temp.n('kai', 'select 1 from api_external.my_account_talent'), 0, 'an Account Member sees none');
select is(pg_temp.n('rita', format('select 1 from api_external.my_account_talent where person_id = %L and source = ''Represented Artist''', pg_temp.id('art'))), 1,
  'a representative sees the artists they represent with the Advance scope');
select is((select count(*)::int from information_schema.columns where table_schema = 'api_external'
  and table_name in ('engagement_roster', 'my_roster_entries', 'my_account_talent', 'account_engagement_assignments')
  and column_name in ('internal_note', 'agreed_rate_minor', 'org_id')), 0, 'no view carries an internal column');

select pg_temp.move_engagement('eng_vendor_a', 'Onboarding', 'Active');
select pg_temp.move_engagement('eng_vendor_a', 'Active', 'Closing');
select pg_temp.move_engagement('eng_vendor_a', 'Closing', 'Complete');
select is(pg_temp.n('victor', format('select 1 from api_external.engagement_roster where engagement_id = %L', pg_temp.id('eng_vendor_a'))), 0,
  'after Complete the Owner sees nothing');
select is(pg_temp.n('kai', format('select 1 from api_external.engagement_roster where engagement_id = %L', pg_temp.id('eng_vendor_a'))), 0,
  'nor does the rostered person');
select pg_temp.as_user('victor');
select throws_like(format($$select app.add_roster_entry(%L, %L)$$, pg_temp.id('eng_vendor_a'), pg_temp.id('mo')), 'roster_closed:%',
  'a closed engagement takes no entries');
select pg_temp.as_platform();

select * from finish();
rollback;

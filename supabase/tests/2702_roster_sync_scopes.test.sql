-- pgTAP: migration 2702 (R8), roster sync scopes and the holder's scans. rosterEntryIds appear for an entry accepted
-- by both sides on an Active engagement, with the entry's project as engagedProjectIds (audience crew), and disappear
-- when the entry is Withdrawn or the engagement Complete. app.resolve_asset_code resolves the unit a person holds on
-- their roster entry and answers unknown to a colleague on the same roster.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql
\ir 2654_project_facts_world.psql
\ir 2691_allocation_world.psql

select no_plan();

create function pg_temp.scopes(p_who text, p_key text) returns text[]
language sql security definer as $$
  select coalesce(array_agg(g.scope_value || ':' || g.audience order by g.scope_value), '{}')
  from private.sync_scope_grants g join app.people p on p.user_id = g.person_user_id
  where p.id = pg_temp.id(p_who) and g.scope_key = p_key
$$;

select ok(exists (select 1 from pg_constraint where conname = 'sync_scope_grants_scope_key'
  and pg_get_constraintdef(oid) like '%rosterEntryIds%'), 'rosterEntryIds is an allowed scope key');

-- Kai is accepted on the Active vendor engagement; Una is still a Draft.
select is(pg_temp.scopes('kai', 'rosterEntryIds'), array[pg_temp.id('e_kai')::text || ':crew'], 'Kai syncs his entry');
select is(pg_temp.scopes('kai', 'engagedProjectIds'), array[pg_temp.id('prj_a')::text || ':crew'], 'and its project, as crew');
select is(pg_temp.scopes('kai', 'engagementIds'), '{}'::text[], 'never the party''s engagement');
select is(pg_temp.scopes('una', 'rosterEntryIds'), '{}'::text[], 'a Draft entry syncs nothing');

select pg_temp.as_user('una');
select app.respond_roster_entry(pg_temp.id('e_una'), 'Accepted');
select pg_temp.as_user('victor');
select app.submit_roster(pg_temp.id('eng_vendor_a'));
select pg_temp.as_user('carol');
select app.review_roster_entry(pg_temp.id('e_una'), 'Accepted');
select is(pg_temp.scopes('una', 'rosterEntryIds'), array[pg_temp.id('e_una')::text || ':crew'],
  'Una syncs her entry once the reviewer accepts it');

-- The holder's scans ---------------------------------------------------------------------------------------------------------
insert into world select 'kai_radio', pg_temp.alloc('assign', 'carol', 'e_kai', 'class', 'cls_radio', 1);
select pg_temp.as_user('carol');
select app.issue_allocation('01920000-0000-7000-8702-000000000001', pg_temp.id('kai_radio'), '[{"asset_tag": "NWL-RAD-001"}]');
select pg_temp.as_user('kai');
select is((select subject_kind || ' ' || asset_tag from app.resolve_asset_code(pg_temp.id('org_a'), 'NWL-RAD-001')), 'unit NWL-RAD-001',
  'Kai resolves the radio he holds');
select is((select reason from app.resolve_asset_code(pg_temp.id('org_a'), 'NWL-RAD-002')), 'asset_code_unknown',
  'and not one he does not');
select pg_temp.as_user('una');
select is((select reason from app.resolve_asset_code(pg_temp.id('org_a'), 'NWL-RAD-001')), 'asset_code_unknown',
  'a colleague on the same roster gets unknown for Kai''s radio');
select pg_temp.as_user('ivy');
select throws_ok($$select * from app.resolve_asset_code(pg_temp.id('org_a'), 'NWL-RAD-001')$$, '42501', null,
  'someone with no operational engagement or entry with the org cannot scan');

-- Ivy works prj_a on her own Crew engagement and joins Bayside Audio's roster there too: her project keeps the Crew
-- audience rather than crew, and her entry still syncs.
select pg_temp.as_user('victor');
select app.add_account_member(pg_temp.id('acct_v'), pg_temp.id('ivy'), 'Account Member');
select pg_temp.as_user('ivy');
select app.accept_account_membership(pg_temp.membership('acct_v', 'ivy'));
select pg_temp.as_user('victor');
insert into world select 'e_ivy', app.add_roster_entry(pg_temp.id('eng_vendor_a'), pg_temp.id('ivy'), null, null, null, null, null);
select pg_temp.as_user('ivy');
select app.respond_roster_entry(pg_temp.id('e_ivy'), 'Accepted');
select pg_temp.as_user('victor');
select app.submit_roster(pg_temp.id('eng_vendor_a'));
select pg_temp.as_user('carol');
select app.review_roster_entry(pg_temp.id('e_ivy'), 'Accepted');
select pg_temp.move_engagement('eng_ivy_a', 'Onboarding', 'Active');
select is(pg_temp.scopes('ivy', 'rosterEntryIds'), array[pg_temp.id('e_ivy')::text || ':crew'], 'Ivy syncs her roster entry');
select is(pg_temp.scopes('ivy', 'engagedProjectIds'), array[pg_temp.id('prj_a')::text || ':Crew'],
  'and the project once, with her own engagement''s audience');

-- Losing the scope ---------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('victor');
select app.withdraw_roster_entry(pg_temp.id('e_una'), 'Swapped out.');
select is(pg_temp.scopes('una', 'rosterEntryIds'), '{}'::text[], 'a withdrawn entry syncs nothing');
select is(pg_temp.scopes('una', 'engagedProjectIds'), '{}'::text[], 'nor its project');
select pg_temp.move_engagement('eng_vendor_a', 'Active', 'Closing');
select is(pg_temp.scopes('kai', 'rosterEntryIds'), array[pg_temp.id('e_kai')::text || ':crew'], 'Closing keeps the scope');
select pg_temp.move_engagement('eng_vendor_a', 'Closing', 'Complete');
select is(pg_temp.scopes('kai', 'rosterEntryIds'), '{}'::text[], 'Complete ends it');
select is(pg_temp.scopes('kai', 'engagedProjectIds'), '{}'::text[], 'and the project''s');

select * from finish();
rollback;

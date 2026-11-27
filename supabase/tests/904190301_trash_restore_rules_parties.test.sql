-- pgTAP: migration 904190301, restore rules for the Trash tables members never update directly (RRR-198, ADR 0110
-- amendment of 4.19): the three that involve an outside party. rating_replies are restored by the person who replied,
-- party_threads by the org side or the party, shared_reports by the people who share and revoke reports. A person who
-- reads the row and does not manage it is refused; other parties, other orgs and anon stay out. The other six tables
-- are in 904190301_trash_restore_rules.test.sql.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

select plan(24);

create function pg_temp.trash(p_table text, p_key text) returns void
language plpgsql as $$
begin
  perform pg_temp.as_platform();
  execute format('update app.%I set deleted_at = now() where id = $1', p_table) using pg_temp.id(p_key);
end $$;

create function pg_temp.live(p_table text, p_key text) returns boolean
language plpgsql as $$
declare
  v_live boolean;
begin
  perform pg_temp.as_platform();
  execute format('select deleted_at is null from app.%I where id = $1', p_table) into v_live using pg_temp.id(p_key);
  return v_live;
end $$;

-- World -----------------------------------------------------------------------------------------------------------------

select pg_temp.move_engagement('eng_vendor_a', 'Onboarding', 'Active');
select pg_temp.move_engagement('eng_vendor_a', 'Active', 'Closing');
select pg_temp.move_engagement('eng_vendor_a', 'Closing', 'Complete');
select pg_temp.move_engagement('eng_ivy_a', 'Onboarding', 'Active');
select pg_temp.as_user('carol');
with r as (insert into app.ratings (engagement_id, rater_side, score, comment)
  values (pg_temp.id('eng_vendor_a'), 'Organization', 4, 'Clean load-in, late strike.') returning id)
  insert into world select 'rating_org', id from r;
select pg_temp.as_user('sam');
with r as (insert into app.ratings (engagement_id, rater_side, score, comment)
  values (pg_temp.id('eng_vendor_a'), 'Party', 5, 'Clear call sheets.') returning id)
  insert into world select 'rating_party', id from r;
with r as (insert into app.rating_replies (rating_id, body)
  values (pg_temp.id('rating_org'), 'Strike ran late because of the storm.') returning id)
  insert into world select 'reply', id from r;
select pg_temp.as_user('carol');
with t as (select app.start_party_thread(pg_temp.id('org_a'), pg_temp.id('ivy'), null, 'Next Season', 'Are you free for the autumn series?') as id)
  insert into world select 'thread', id from t;
with x as (insert into app.report_definitions (membership_id, name, source_code)
  values (pg_temp.id('carol@org_a'), 'Show Spend', 'finance') returning id) insert into world select 'rdef', id from x;
select pg_temp.as_platform();
with x as (insert into app.report_runs (report_definition_id, run_for_membership_id, export_format)
  values (pg_temp.id('rdef'), pg_temp.id('carol@org_a'), 'PDF') returning id) insert into world select 'run', id from x;
update app.report_runs set run_status = 'Succeeded', started_at = now(), finished_at = now(), row_count = 3 where id = pg_temp.id('run');
select pg_temp.as_user('carol');
insert into world values ('share', app.share_report(pg_temp.id('run'), pg_temp.id('eng_art_a'), 'Show Spend'));

-- rating_replies: the person who replied ---------------------------------------------------------------------------------

select pg_temp.trash('rating_replies', 'reply');
select pg_temp.as_user('sam');
select is((select count(*)::int from app.trash_items where subject_table = 'rating_replies' and subject_id = pg_temp.id('reply')), 1,
  'a deleted reply is in the Trash of the person who wrote it');
select pg_temp.as_user('carol');
select throws_ok($$select app.restore_trash_item('rating_replies', pg_temp.id('reply'))$$,
  '42501', 'you cannot edit this row, so you cannot restore it', 'the org that was answered reads the reply and cannot restore it');
select pg_temp.as_user('victor');
select throws_ok($$select app.restore_trash_item('rating_replies', pg_temp.id('reply'))$$,
  '42501', 'you cannot edit this row, so you cannot restore it', 'nor can the owner of the replier''s account');
select pg_temp.as_user('quinn');
select throws_ok($$select app.restore_trash_item('rating_replies', pg_temp.id('reply'))$$, '42501', 'the row is not visible to you',
  'a stranger does not see it');
select pg_temp.as_anon();
select throws_ok($$select app.restore_trash_item('rating_replies', pg_temp.id('reply'))$$, '42501', null, 'nor anon');
select pg_temp.as_user('sam');
select is(app.restore_trash_item('rating_replies', pg_temp.id('reply')), 1, 'the person who replied restores their reply');
select ok(pg_temp.live('rating_replies', 'reply'), 'and it is live again');
select is((select body from app.rating_replies where id = pg_temp.id('reply')), 'Strike ran late because of the storm.', 'as it was written');
select is((select count(*)::int from app.domain_events where event_type = 'trash.restored' and subject_id = pg_temp.id('reply')), 1,
  'trash.restored was emitted');

-- party_threads: the org side or the party -----------------------------------------------------------------------------------

select pg_temp.trash('party_threads', 'thread');
select pg_temp.as_user('quinn');
select throws_ok($$select app.restore_trash_item('party_threads', pg_temp.id('thread'))$$, '42501', 'the row is not visible to you',
  'a stranger to the conversation cannot restore it');
select pg_temp.as_user('xavier');
select throws_ok($$select app.restore_trash_item('party_threads', pg_temp.id('thread'))$$, '42501', null, 'nor another org');
select pg_temp.as_user('gina');
select throws_ok($$select app.restore_trash_item('party_threads', pg_temp.id('thread'))$$, '42501', null,
  'role band: a Viewer of the org cannot restore it');
select pg_temp.as_user('ivy');
select is(app.restore_trash_item('party_threads', pg_temp.id('thread')), 1, 'the party restores the conversation');
select ok(pg_temp.live('party_threads', 'thread'), 'and it is live again');
select pg_temp.trash('party_threads', 'thread');
select pg_temp.as_user('carol');
select is(app.restore_trash_item('party_threads', pg_temp.id('thread')), 1, 'the org side restores it too');
select pg_temp.as_platform();
select is((select count(*)::int from app.party_messages where party_thread_id = pg_temp.id('thread') and deleted_at is null), 1,
  'with its messages, which were never deleted');

-- shared_reports: the people who share and revoke reports ----------------------------------------------------------------

select pg_temp.trash('shared_reports', 'share');
select pg_temp.as_user('dave');
select is((select count(*)::int from app.trash_items where subject_table = 'shared_reports' and subject_id = pg_temp.id('share')), 1,
  'a Member who reads reports sees the deleted share in Trash');
select throws_ok($$select app.restore_trash_item('shared_reports', pg_temp.id('share'))$$,
  '42501', 'you cannot edit this row, so you cannot restore it', 'and, without reports.report.export, cannot restore it');
select pg_temp.as_user('art');
select throws_ok($$select app.restore_trash_item('shared_reports', pg_temp.id('share'))$$, '42501', 'the row is not visible to you',
  'the party it was shared with does not see a deleted share');
select pg_temp.as_user('xavier');
select throws_ok($$select app.restore_trash_item('shared_reports', pg_temp.id('share'))$$, '42501', null, 'nor another org');
select pg_temp.as_user('carol');
select is(app.restore_trash_item('shared_reports', pg_temp.id('share')), 1, 'a Manager who shares reports restores the share');
select pg_temp.as_user('art');
select is((select count(*)::int from app.shared_reports where id = pg_temp.id('share')), 1, 'and the party reads it again');
select pg_temp.as_user('carol');
select app.revoke_shared_report(pg_temp.id('share'));
select pg_temp.trash('shared_reports', 'share');
select pg_temp.as_user('carol');
select is(app.restore_trash_item('shared_reports', pg_temp.id('share')), 1, 'a revoked share is restored');
select pg_temp.as_user('art');
select is((select count(*)::int from app.shared_reports where id = pg_temp.id('share')), 0, 'and stays revoked: the party still reads nothing');

select * from finish();
rollback;

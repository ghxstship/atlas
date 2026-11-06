-- pgTAP: the day-90 org purge (1351) over an org the legal queue and an appeal's re-review have touched (RRR-248, ADR 0167). An
-- item is the platform's record and outlives the tenant: the purge clears its link and leaves it with its log. The re-review
-- record is the org's own and goes with the org. Neither blocks the purge.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

select plan(14);

select pg_temp.new_user('olga', 'olga@platform.test', 'Olga Brandt');
select pg_temp.as_platform();
select private.grant_platform_operator('olga@platform.test', 'Administrator', 'The only operator.');
with o as (
  insert into app.opportunities (project_id, requisition_id, role_type, role_code, title, visibility, rate_type, pay_min_minor, pay_max_minor,
    currency_code, starts_on, ends_on, deadline_at)
  values (pg_temp.id('prj_b'), pg_temp.id('requisition_b'), 'Crew', '5000.51.02', 'Harbor Riggers', 'Invited', 'Day', 70000, 90000, 'USD',
    '2027-06-01', '2027-06-03', now() + interval '7 days')
  returning id)
insert into world select 'opp_b', o.id from o;
insert into app.listing_reports (opportunity_id, reporter_person_id, reason, details)
values (pg_temp.id('opp_b'), pg_temp.id('ivy'), 'Fraud', 'Asks for a fee.');

create function pg_temp.as_op(p_key text) returns void
language plpgsql as $$
begin
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', pg_temp.id(p_key || '_user'), 'role', 'authenticated', 'aal', 'aal2')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;

select pg_temp.as_op('olga');
select lives_ok($$insert into world select 'decision', app.console_decide_listing(pg_temp.id('opp_b'), 'No Action', 'No Violation', 'Terms 7.6', 'No fee.', 'We found no violation.')$$, 'a decision on a report');
select pg_temp.as_user('ivy');
select lives_ok($$insert into world select 'appeal', app.file_moderation_appeal(pg_temp.id('decision'), 'They do charge it.')$$, 'an appeal of it');
select pg_temp.as_platform();
select private.sync_legal_queue_feeds();
insert into world select 'fed', id from app.legal_queue_items where source_id = pg_temp.id('appeal');
select pg_temp.as_op('olga');
select lives_ok($$select app.console_decide_appeal(pg_temp.id('appeal'), 'Upheld', 'It stands.', 'Read it again.')$$, 'a documented re-review');
select pg_temp.as_platform();

insert into world select 'cert', private.write_deletion_certificate(pg_temp.id('org_b'), 'cancellation', now(), now(), null);
update app.deletion_certificates set storage_cleared_at = now() where id = pg_temp.id('cert');
select is((select count(*)::int from private.moderation_appeal_reviews where org_id = pg_temp.id('org_b')), 1, 'the org has a re-review record');
select is((select tenant_org_id from app.legal_queue_items where id = pg_temp.id('fed')), pg_temp.id('org_b'), 'and a fed item says which org');

-- The console ledger's own row for the moderation decision stops the purge. That row is older than this work and not the queue's,
-- which writes no target org: the test shows the queue adds nothing to that list, and then clears it to see the rest through.
select is(private.purge_organization(pg_temp.id('cert')), null, 'the purge is held');
select is((select blocked_reason from app.deletion_certificates where id = pg_temp.id('cert')), 'Rows outside the org reference it: app.platform_operator_actions.',
  'only by the moderation decision''s row in the console ledger, and by nothing of the queue''s');
select private.begin_trusted_operation('retention_purge');
delete from app.platform_operator_actions where target_org_id = pg_temp.id('org_b');
select private.end_trusted_operation('retention_purge');

select cmp_ok(private.purge_organization(pg_temp.id('cert')), '>', 0::bigint, 'with that row gone, the org is purged');
select is((select count(*)::int from app.organizations where id = pg_temp.id('org_b')), 0, 'the org is gone');
select is((select count(*)::int from private.moderation_appeal_reviews where moderation_appeal_id = pg_temp.id('appeal')), 0, 'its re-review record went with it');
select is((select tenant_org_id from app.legal_queue_items where id = pg_temp.id('fed')), null, 'the queue item stays, with no link to the org');
select cmp_ok((select count(*)::int from private.legal_queue_events where legal_queue_item_id = pg_temp.id('fed')), '>', 0, 'and with its log, as evidence the clock was met');
select is(private.legal_queue_item_json((select i from app.legal_queue_items i where i.id = pg_temp.id('fed')), now()) ->> 'live_title', null, 'nothing of the tenant''s is left to read');
select is(private.sync_legal_queue_feeds() >= 0, true, 'and the feeds run on');

select * from finish();
rollback;

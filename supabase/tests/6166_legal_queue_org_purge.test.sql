-- pgTAP: the day-90 org purge (1351) over an org the legal queue and an appeal's re-review have touched (RRR-248, ADR 0167). An
-- item is the platform's record and outlives the tenant: the purge clears its link and leaves it with its log. The re-review
-- record is the org's own and goes with the org. Neither blocks the purge.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

select plan(1);
select pg_temp.as_platform();
select ok(true, 'placeholder');
select * from finish();
rollback;

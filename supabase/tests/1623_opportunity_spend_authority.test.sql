-- pgTAP: migration 1623, ADR 0033 decision 61 (2026-10-23, RRR-125). Spend authority when publishing an opportunity
-- applies only to orgs that set spend limits for requisitions. Without one, a Crew posting publishes without a
-- requisition and a named requisition only has to be live and match its project and role; a limit for other documents changes
-- nothing; once the org sets a requisition limit, Contractor, Crew and Staff postings publish only from an Approved
-- requisition again (0774's rule).
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

select plan(12);

create function pg_temp.publish(p_key text) returns void language plpgsql as $$
begin
  perform app.transition_opportunity(pg_temp.id(p_key), 'Draft', 'Pending Approval', 'Ready.');
  perform app.transition_opportunity(pg_temp.id(p_key), 'Pending Approval', 'Published', 'Approved.');
end $$;
grant execute on function pg_temp.publish(text) to public;

create function pg_temp.opp(p_key text, p_role_type text, p_role_code text, p_requisition text) returns void language plpgsql as $$
begin
  with o as (insert into app.opportunities (project_id, role_type, role_code, title, visibility, requisition_id)
    values (pg_temp.id('prj_a'), p_role_type::app.external_role_type, p_role_code, 'Summer Series ' || p_key, 'Invited',
            case when p_requisition is not null then pg_temp.id(p_requisition) end) returning id)
  insert into world select p_key, id from o;
end $$;
grant execute on function pg_temp.opp(text, text, text, text) to public;

-- A requisition still Proposed: without a limit nobody can approve it (0320), and nobody needs to.
select pg_temp.as_user('alice');
with r as (insert into app.requisitions (project_id, role_code, headcount, currency_code, justification)
  values (pg_temp.id('prj_a'), '5000.51.02', 2, 'USD', 'Two more riggers.') returning id) insert into world select 'req_open', id from r;
with r as (insert into app.requisitions (project_id, role_code, headcount, currency_code, justification)
  values (pg_temp.id('prj_a'), '5000.51.02', 1, 'USD', 'A rigger we no longer need.') returning id) insert into world select 'req_gone', id from r;
select pg_temp.as_platform();

select ok(not private.org_sets_spend_limits(pg_temp.id('org_a'), 'Requisition'), 'Northwind sets no spend limit for requisitions');

-- 1. No requisition limit: no spend authority before publishing ---------------------------------------------------------
select pg_temp.as_user('carol');
select pg_temp.opp('crew_free', 'Crew', '5000.51.02', null);
select pg_temp.opp('crew_open_req', 'Crew', '5000.51.02', 'req_open');
select pg_temp.opp('crew_wrong_role', 'Crew', '2000.50.02', 'req_open');
select pg_temp.opp('crew_gone_req', 'Crew', '5000.51.02', 'req_gone');
select pg_temp.as_platform();
update app.requisitions set deleted_at = now() where id = pg_temp.id('req_gone');
select pg_temp.as_user('carol');
select lives_ok($$select pg_temp.publish('crew_free')$$, 'a Crew posting publishes without a requisition');
select lives_ok($$select pg_temp.publish('crew_open_req')$$, 'and from a requisition nobody could approve, when it matches');
select throws_ok($$select pg_temp.publish('crew_wrong_role')$$, 'XR001',
  'requisition_mismatch: The requisition is for another project or role.', 'a named requisition still has to match the role');
select throws_ok($$select pg_temp.publish('crew_gone_req')$$, 'XR001',
  'requisition_missing: The requisition was deleted; choose another or publish without one.', 'and must not be deleted');

-- A limit for another document says nothing about staffing.
select pg_temp.as_user('alice');
insert into app.spend_authorities (org_id, role_id, document_type, currency_code, limit_minor)
values (pg_temp.id('org_a'), pg_temp.system_role('manager'), 'Expense', 'USD', 1000000);
select pg_temp.as_user('carol');
select pg_temp.opp('crew_expense_limit', 'Crew', '5000.51.02', null);
select lives_ok($$select pg_temp.publish('crew_expense_limit')$$, 'an expense limit alone does not require a requisition');

-- 2. A requisition limit brings spend authority back -------------------------------------------------------------------
select pg_temp.as_user('alice');
insert into app.spend_authorities (org_id, role_id, document_type, currency_code, limit_minor)
values (pg_temp.id('org_a'), pg_temp.system_role('manager'), 'Requisition', 'USD', 5000000);
select pg_temp.as_platform();
select ok(private.org_sets_spend_limits(pg_temp.id('org_a'), 'Requisition'), 'once Northwind sets a requisition limit');
select pg_temp.as_user('carol');
select pg_temp.opp('crew_limited', 'Crew', '5000.51.02', null);
select pg_temp.opp('crew_limited_open', 'Crew', '5000.51.02', 'req_open');
select pg_temp.opp('crew_limited_ok', 'Crew', '5000.51.02', 'requisition_a');
select pg_temp.opp('artist_limited', 'Artist', '2000.50.02', null);
select throws_ok($$select pg_temp.publish('crew_limited')$$, 'XR001',
  'requisition_required: Your organization sets spend limits for requisitions: publish Contractor, Crew and Staff opportunities from an Approved requisition.',
  'a Crew posting needs a requisition again');
select throws_ok($$select pg_temp.publish('crew_limited_open')$$, 'XR001', null, 'and one still Proposed is refused');
select lives_ok($$select pg_temp.publish('crew_limited_ok')$$, 'one from an Approved requisition publishes');
select lives_ok($$select pg_temp.publish('artist_limited')$$, 'an artist booking still needs none');

-- A limit that has ended no longer counts.
select pg_temp.as_platform();
update app.spend_authorities set valid_to = now() - interval '1 minute', valid_from = now() - interval '1 day'
where org_id = pg_temp.id('org_a') and document_type = 'Requisition';
select ok(not private.org_sets_spend_limits(pg_temp.id('org_a'), 'Requisition'), 'a requisition limit that has ended no longer counts');

select * from finish();
rollback;

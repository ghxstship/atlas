-- pgTAP: migration 0774. Spend authority before publishing (Contractor, Crew and Staff need an Approved requisition for
-- the same project and role; any named requisition must be Approved; the requisition is fixed once published), here for
-- an org that sets spend limits for requisitions, the only orgs the rule applies to since 1623 (ADR 0033 decision 61),
-- engagement and marketplace tables as comment subjects, and self-billing consent by the billed party only.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

select * from no_plan();

create function pg_temp.publish(p_key text) returns void language plpgsql as $$
begin
  perform app.transition_opportunity(pg_temp.id(p_key), 'Draft', 'Pending Approval', 'Ready.');
  perform app.transition_opportunity(pg_temp.id(p_key), 'Pending Approval', 'Published', 'Approved.');
end $$;
grant execute on function pg_temp.publish(text) to public;

-- Requisitions -------------------------------------------------------------------------------------------------------------
-- Northwind sets a spend limit for requisitions, so spend authority runs before publishing (1623).
select pg_temp.as_user('alice');
insert into app.spend_authorities (org_id, role_id, document_type, currency_code, limit_minor)
values (pg_temp.id('org_a'), pg_temp.system_role('manager'), 'Requisition', 'USD', 5000000);
with r as (insert into app.requisitions (project_id, role_code, headcount, currency_code, justification)
  values (pg_temp.id('prj_a'), '5000.51.02', 1, 'USD', 'One more rigger.') returning id) insert into world select 'req_open', id from r;
with r as (insert into app.requisitions (project_id, role_code, headcount, currency_code, justification)
  values (pg_temp.id('prj_a'), '9000.50.02', 1, 'USD', 'Front of house engineer.') returning id) insert into world select 'req_audio', id from r;
select pg_temp.as_platform();
select private.transition_lifecycle('requisition', 'app.requisitions', 'requisition_state', 'app.requisition_state_transitions',
  'requisition_id', pg_temp.id('req_audio'), 'Proposed', 'Approved', 'Fixture approval.');
select pg_temp.as_user('carol');
create function pg_temp.opp(p_key text, p_role_type text, p_role_code text, p_requisition text) returns void language plpgsql as $$
begin
  with o as (insert into app.opportunities (project_id, role_type, role_code, title, visibility, requisition_id)
    values (pg_temp.id('prj_a'), p_role_type::app.external_role_type, p_role_code, 'Summer Series ' || p_key, 'Invited',
            case when p_requisition is not null then pg_temp.id(p_requisition) end) returning id)
  insert into world select p_key, id from o;
end $$;
grant execute on function pg_temp.opp(text, text, text, text) to public;
select pg_temp.opp('no_req', 'Crew', '5000.51.02', null);
select pg_temp.opp('open_req', 'Crew', '5000.51.02', 'req_open');
select pg_temp.opp('wrong_role', 'Crew', '5000.51.02', 'req_audio');
select pg_temp.opp('ok', 'Crew', '5000.51.02', 'requisition_a');
select pg_temp.opp('artist_open_req', 'Artist', '5000.51.02', 'req_open');
select pg_temp.opp('artist_free', 'Artist', '2000.50.02', null);
select throws_ok($$select pg_temp.publish('no_req')$$, 'XR001', 'requisition_required: Your organization sets spend limits for requisitions: publish Contractor, Crew and Staff opportunities from an Approved requisition.',
  'a Crew posting needs a requisition');
select throws_ok($$select pg_temp.publish('open_req')$$, 'XR001', null, 'a requisition still Proposed is refused');
select throws_ok($$select pg_temp.publish('wrong_role')$$, 'XR001', null, 'a requisition for another role is refused');
select throws_ok($$select pg_temp.publish('artist_open_req')$$, 'XR001', null, 'any named requisition must be Approved');
select lives_ok($$select pg_temp.publish('artist_free')$$, 'an artist booking without a requisition publishes');
select lives_ok($$select pg_temp.publish('ok')$$, 'a Crew posting from an Approved requisition publishes');
select throws_ok(format($$update app.opportunities set requisition_id = '%s' where id = '%s'$$, pg_temp.id('req_open'), pg_temp.id('ok')),
  'XR001', null, 'the requisition is fixed once published');
select pg_temp.as_user('xavier');
select throws_ok(format($$insert into app.opportunities (project_id, role_type, title, requisition_id) values ('%s', 'Crew', 'Cross Org', '%s')$$,
  pg_temp.id('prj_b'), pg_temp.id('requisition_a')), 'XR001', null, 'a requisition of another org is refused');
select pg_temp.as_platform();

-- Comment subjects ----------------------------------------------------------------------------------------------------------
select is((select count(*)::int from app.comment_subjects where table_name in ('app.engagements', 'app.opportunities', 'app.applications',
  'app.offers', 'app.engagement_documents', 'app.onboarding_items', 'app.talent_pools', 'app.engagement_deliverables', 'app.client_approval_requests')), 9,
  'engagement and marketplace tables carry comments and attachments');

-- Self-billing consent --------------------------------------------------------------------------------------------------------
select pg_temp.as_user('fiona');
select throws_ok(format($$select app.agree_self_billing('%s')$$, pg_temp.id('eng_vendor_a')), '42501', null, 'Onboarding: the money area is closed');
select pg_temp.as_platform();
select pg_temp.move_engagement('eng_vendor_a', 'Onboarding', 'Active');
select pg_temp.move_engagement('eng_ivy_a', 'Onboarding', 'Active');
select pg_temp.as_user('sam');
select throws_ok(format($$select app.agree_self_billing('%s')$$, pg_temp.id('eng_vendor_a')), '42501', null, 'a supplied person cannot consent for the account');
select pg_temp.as_user('carol');
select throws_ok(format($$select app.agree_self_billing('%s')$$, pg_temp.id('eng_vendor_a')), '42501', null, 'the org cannot consent for the party');
select pg_temp.as_user('fiona');
select lives_ok(format($$select app.agree_self_billing('%s')$$, pg_temp.id('eng_vendor_a')), 'Account Finance consents for the billing account');
select throws_ok(format($$select app.agree_self_billing('%s')$$, pg_temp.id('eng_vendor_a')), 'XR001', null, 'one live consent per engagement');
select is((select count(*)::int from api_external.self_billing_agreements where is_active), 1, 'the consent shows to the account');
select pg_temp.as_user('ivy');
select lives_ok(format($$select app.agree_self_billing('%s')$$, pg_temp.id('eng_ivy_a')), 'an individual consents for her own engagement');
select is((select count(*)::int from api_external.self_billing_agreements), 1, 'ivy sees only her own consent');
select pg_temp.as_user('carol');
select is((select count(*)::int from app.self_billing_agreements), 2, 'same tenant: the org reads consents');
select pg_temp.as_user('xavier');
select is((select count(*)::int from app.self_billing_agreements), 0, 'cross tenant: none');
select pg_temp.as_user('victor');
select lives_ok(format($$select app.revoke_self_billing('%s')$$, pg_temp.id('eng_vendor_a')), 'the account Owner revokes');
select throws_ok(format($$select app.revoke_self_billing('%s')$$, pg_temp.id('eng_vendor_a')), 'XR001', null, 'nothing left to revoke');
select is((select count(*)::int from api_external.self_billing_agreements where not is_active), 1, 'the revoked consent stays as evidence');
select throws_ok('insert into app.self_billing_agreements (engagement_id) select id from app.engagements limit 1', '42501', null,
  'consents are written only through the RPCs');
select pg_temp.as_anon();
select throws_ok('select 1 from api_external.self_billing_agreements', '42501', null, 'anon deny');
select pg_temp.as_platform();

select * from finish();
rollback;

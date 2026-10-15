-- pgTAP: ways to join (invitation links, requests to join, automatic join for verified domains) and offboarding
-- with record reassignment (Section 4.8.1).
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(36);

create function pg_temp.as_service() returns void
language plpgsql as $$
begin
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  perform set_config('role', 'service_role', true);
end $$;

create temporary table k (key text primary key, id uuid, txt text);
grant select, insert, update on k to public;

-- Invitation links ------------------------------------------------------------------------------------------------
select pg_temp.as_user('dave');
select throws_ok($$select * from app.create_invite_link(pg_temp.id('org_a'), pg_temp.system_role('viewer'))$$, '42501', null,
  'a Member cannot create invitation links');
select pg_temp.as_user('bob');
select throws_ok($$select * from app.create_invite_link(pg_temp.id('org_a'), pg_temp.system_role('admin'))$$, 'XR001', null,
  'links never give Admin or Owner');
select throws_ok($$select * from app.create_invite_link(pg_temp.id('org_a'), pg_temp.system_role('viewer'), interval '60 days')$$, 'XR001', null,
  'links last at most 30 days');
insert into k (key, id, txt) select 'link', l.invite_link_id, l.invite_token
from app.create_invite_link(pg_temp.id('org_a'), pg_temp.system_role('viewer'), interval '7 days', 1) l;
select ok((select txt like 'xlnk_%' from k where key = 'link'), 'the token is returned once');
select is((select max_uses from app.invite_links where id = (select id from k where key = 'link')), 1,
  'the link keeps its use limit, and only a hash of the token is stored');
select pg_temp.as_user('nina');
select throws_ok($$select app.accept_invite_link('xlnk_wrong')$$, 'XR001', null, 'an unknown token is refused');
select ok(app.accept_invite_link((select txt from k where key = 'link')) is not null, 'a signed-in person joins with the link');
select is((select r.code from app.membership_roles mr join app.roles r on r.id = mr.role_id
  join app.memberships m on m.id = mr.membership_id where m.person_id = pg_temp.id('nina') and m.org_id = pg_temp.id('org_a')), 'viewer',
  'with the link''s role');
select pg_temp.as_user('xavier');
select throws_ok($$select app.accept_invite_link((select txt from k where key = 'link'))$$, 'XR001', null, 'a used-up link is refused');
select pg_temp.as_user('bob');
insert into k (key, id, txt) select 'link2', l.invite_link_id, l.invite_token
from app.create_invite_link(pg_temp.id('org_a'), pg_temp.system_role('viewer')) l;
select lives_ok($$select app.revoke_invite_link((select id from k where key = 'link2'))$$, 'an Admin revokes a link');
select pg_temp.as_user('xavier');
select throws_ok($$select app.accept_invite_link((select txt from k where key = 'link2'))$$, 'XR001', null, 'a revoked link is refused');
select throws_ok($$insert into app.invite_links (org_id, role_id, token_hash, expires_at, max_uses)
  values (pg_temp.id('org_a'), pg_temp.system_role('viewer'), extensions.digest('x', 'sha256'), now() + interval '1 day', 5)$$, '42501', null,
  'links are created only through the RPC');

-- Requests to join ------------------------------------------------------------------------------------------------
select pg_temp.as_user('alice');
select app.ensure_organization_profile(pg_temp.id('org_a'));
select pg_temp.as_user('paul');
select throws_ok($$select app.request_to_join(pg_temp.id('org_a'), 'I run a staging crew.')$$, 'XR001', null,
  'a stranger cannot ask to join an org whose profile they cannot see');
select pg_temp.as_user('alice');
update app.organization_profiles set visibility = 'Public' where org_id = pg_temp.id('org_a');
select pg_temp.as_user('paul');
insert into k (key, id) values ('request', app.request_to_join(pg_temp.id('org_a'), 'I run a staging crew.'));
select throws_ok($$select app.request_to_join(pg_temp.id('org_a'))$$, '23505', null, 'one pending request per org');
select is((select count(*)::integer from app.join_requests), 1, 'the person reads their own request');
select pg_temp.as_user('dave');
select is((select count(*)::integer from app.join_requests), 0, 'a Member does not read requests');
select throws_ok($$select app.decide_join_request((select id from k where key = 'request'), true, pg_temp.system_role('member'))$$, '42501', null,
  'a Member cannot approve');
select pg_temp.as_user('carol');
select throws_ok($$select app.decide_join_request((select id from k where key = 'request'), true, pg_temp.system_role('admin'))$$, '42501', null,
  'a Manager without org.members.manage cannot approve');
select pg_temp.as_user('bob');
select throws_ok($$select app.decide_join_request((select id from k where key = 'request'), true, pg_temp.system_role('owner'))$$, 'XR001', null,
  'an approver gives only roles at or below their band');
select ok(app.decide_join_request((select id from k where key = 'request'), true, pg_temp.system_role('member')) is not null,
  'an Admin approves with a role');
select is((select join_request_state::text from app.join_requests where id = (select id from k where key = 'request')), 'Approved',
  'the request records the decision');
select throws_ok($$select app.decide_join_request((select id from k where key = 'request'), false)$$, 'XR001', null, 'a decided request stays decided');

-- Automatic join --------------------------------------------------------------------------------------------------
select pg_temp.as_platform();
select pg_temp.new_user('quinn', 'quinn@northwind.test', 'Quinn Harper');
select pg_temp.as_user('quinn');
select throws_ok($$select app.join_by_verified_domain(pg_temp.id('org_a'))$$, 'XR001', null, 'no verified domain means no automatic join');
select pg_temp.as_user('alice');
insert into app.org_domains (org_id, hostname, purpose, auto_join_role_id)
values (pg_temp.id('org_a'), 'northwind.test', 'Verified Domain', pg_temp.system_role('member'));
select pg_temp.as_service();
select app.record_domain_verification((select id from app.org_domains where hostname = 'northwind.test'), true);
select pg_temp.as_user('quinn');
select throws_ok($$select app.join_by_verified_domain(pg_temp.id('org_a'))$$, 'XR001', null, 'automatic join waits for the Security setting');
select pg_temp.as_user('alice');
select app.set_setting(pg_temp.id('org_a'), 'security.auto_join_enabled', 'Organization', null, p_value_boolean => true);
select pg_temp.as_user('quinn');
select is((select org_slug from app.auto_join_offers()), 'northwind-live', 'the person is offered the org');
select ok(app.join_by_verified_domain(pg_temp.id('org_a')) is not null, 'a confirmed address at the verified domain joins automatically');
select is((select count(*)::integer from app.auto_join_offers()), 0, 'once joined, the offer goes away');
select pg_temp.as_user('xavier');
select throws_ok($$select app.join_by_verified_domain(pg_temp.id('org_a'))$$, 'XR001', null, 'another domain cannot join automatically');

-- Offboarding -----------------------------------------------------------------------------------------------------
select pg_temp.as_user('dave');
insert into app.records (project_id, record_kind, title, xyz, xyz_basis, owner_party_id)
values (pg_temp.id('prj_a'), 'Task', 'Rig plot', 'Y', 'Declared', pg_temp.id('dave'));
insert into k (key, id) select 'task', id from app.records where title = 'Rig plot';
select pg_temp.as_user('bob');
select app.end_membership(pg_temp.id('dave@org_a'));
select is((select count(*)::integer from app.offboardings where person_id = pg_temp.id('dave')), 1, 'ending a membership opens an offboarding');
insert into k (key, id) select 'offboarding', id from app.offboardings where person_id = pg_temp.id('dave');
select is((select responsibility from app.offboarding_open_records where record_id = (select id from k where key = 'task')), 'Owner',
  'the checklist lists the open records the person owned');
select throws_ok($$select app.complete_offboarding((select id from k where key = 'offboarding'))$$, 'XR001', null,
  'an offboarding cannot complete while records remain');
select throws_ok($$select app.reassign_offboarding_records((select id from k where key = 'offboarding'), pg_temp.id('dave'))$$, 'XR001', null,
  'records go only to someone who still belongs to the org');
select is(app.reassign_offboarding_records((select id from k where key = 'offboarding'), pg_temp.id('carol')), 1,
  'an Admin reassigns the open records');
select lives_ok($$select app.complete_offboarding((select id from k where key = 'offboarding'))$$, 'then completes the offboarding');
select pg_temp.as_user('dave');
select is((select count(*)::integer from app.offboardings), 0, 'the departed person does not read the offboarding');
select ok(app.ensure_my_profile() is not null, 'the person keeps their own profile after leaving');

select * from finish();
rollback;

-- pgTAP: standing partner grants and leaving a partner (1354, A79, finding A65-026, Section 4.6.1). The client Owner
-- records a standing grant (one read scope, an expiry, the agreement clause) as a record grant; either side ends it.
-- A client org leaves its partner and becomes a direct customer with its data, members and brand intact; the partner's
-- access ends and billing moves to the org.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0200_identity_world.psql

select plan(28);

-- Standing grants -------------------------------------------------------------------------------------------------
select pg_temp.as_user('cora');
select throws_like($$select app.record_standing_grant((select id from world where key = 'org_c'), 'org.billing.read', now() + interval '90 days', 'Clause 7.2')$$,
  'standing_grant_scope:%', 'billing is never in a standing grant''s scope');
select throws_like($$select app.record_standing_grant((select id from world where key = 'org_c'), 'org.members.manage', now() + interval '90 days', 'Clause 7.2')$$,
  'standing_grant_scope:%', 'nor is any write: partner staff never write');
select throws_like($$select app.record_standing_grant((select id from world where key = 'org_c'), 'org.settings.read', now() + interval '400 days', 'Clause 7.2')$$,
  'standing_grant_expiry:%', 'a standing grant ends within a year');
insert into world select 'sg1', app.record_standing_grant(pg_temp.id('org_c'), 'org.settings.read', now() + interval '90 days', 'Partner agreement clause 7.2: settings review');
select ok(pg_temp.id('sg1') is not null, 'the client Owner records a standing grant from the agreement');
select pg_temp.as_platform();
select ok((select g.grantee_org_id = pg_temp.id('org_p') and g.capability_code = 'org.settings.read' and g.valid_to > now() + interval '89 days'
  from app.record_grants g join app.partner_standing_grants s on s.record_grant_id = g.id where s.id = pg_temp.id('sg1')),
  'it is a record_grants row for the partner with scope and expiry');
select pg_temp.claims('paul');
select ok(pg_temp.id('org_c') in (select private.orgs_with_capability('org.settings.read')), 'the partner''s staff reach that scope');
select ok(pg_temp.id('org_c') not in (select private.orgs_with_capability('org.members.read')), 'and nothing else');
select pg_temp.as_platform();
select ok(exists (select 1 from app.audit_events where org_id = pg_temp.id('org_c') and action = 'record_grants.insert'),
  'the grant lands in the client''s audit ledger');
select pg_temp.as_user('xavier');
select throws_like($$select app.record_standing_grant((select id from world where key = 'org_b'), 'org.settings.read', now() + interval '30 days', 'Clause 1')$$,
  'standing_grant_no_partner:%', 'only a client org records one');
select is((select count(*)::int from app.partner_standing_grants), 0, 'another org reads no standing grant');
select pg_temp.as_user('paul');
select is((select count(*)::int from app.partner_standing_grants), 1, 'the partner reads the grants made to it');
select is(app.end_standing_grant(pg_temp.id('sg1')), pg_temp.id('sg1'), 'the partner may end a grant early');
select pg_temp.claims('paul');
select ok(pg_temp.id('org_c') not in (select private.orgs_with_capability('org.settings.read')), 'access ends with it');
select pg_temp.as_user('cora');
select throws_like($$select app.end_standing_grant((select id from world where key = 'sg1'))$$, 'standing_grant_ended:%',
  'an ended grant cannot end again');

-- Leaving the partner ------------------------------------------------------------------------------------------------
select pg_temp.as_user('paul');
insert into app.partner_default_brands (org_id, accent_hex, radius_scale, allow_client_override)
values (pg_temp.id('org_p'), '#1F6FEB', 'Rounded', false);
select pg_temp.as_user('cora');
insert into world select 'sg2', app.record_standing_grant(pg_temp.id('org_c'), 'org.settings.read', now() + interval '60 days', 'Clause 7.3');
insert into world select 'ss1', app.grant_support_session(pg_temp.id('org_c'), 4, 'Help with the venue import.');
insert into app.teams (org_id, name) values (pg_temp.id('org_c'), 'Tidewater Crew');
select pg_temp.as_platform();
create temporary table brand_before as select * from private.public_brand(pg_temp.id('org_c'));
select pg_temp.as_user('cora');
select throws_like($$select app.leave_partner((select id from world where key = 'org_c'), 'Tidewater')$$,
  'org_name_mismatch:%', 'leaving needs the org''s name typed exactly');
select is(app.leave_partner(pg_temp.id('org_c'), 'Tidewater Events'), pg_temp.id('org_c'), 'the client Owner leaves the partner');
select pg_temp.as_platform();
select is((select parent_org_id from app.organizations where id = pg_temp.id('org_c')), null, 'the org is a direct customer');
select ok((select accent_hex = '#1F6FEB' and radius_scale = 'Rounded' from app.org_brands where org_id = pg_temp.id('org_c') and deleted_at is null),
  'the brand it rendered with is now its own');
select ok((select b.accent_hex = o.accent_hex and b.radius_scale = o.radius_scale and b.name = o.name
  from private.public_brand(pg_temp.id('org_c')) b cross join brand_before o), 'so it renders exactly as before');
select ok((select ended_at is not null from app.support_sessions where id = pg_temp.id('ss1'))
  and (select ended_at is not null from app.partner_standing_grants where id = pg_temp.id('sg2')),
  'the partner''s support session and standing grants end');
select pg_temp.claims('paul');
select ok(pg_temp.id('org_c') not in (select private.orgs_with_capability('org.settings.read'))
  and pg_temp.id('org_c') not in (select private.orgs_with_capability('projects.project.read')),
  'the partner''s staff reach nothing of the org');
select pg_temp.as_platform();
select results_eq($$select plan_code, subscription_state::text from app.subscriptions where org_id = (select id from world where key = 'org_c') and subscription_state <> 'canceled'$$,
  $$values ('core'::text, 'trialing'::text)$$, 'billing moves to the org: its plan continues as a 14-day trial until a card is added');
select is((select count(*)::int from app.subscription_state_transitions t where t.org_id = pg_temp.id('org_c') and t.reason like 'Left the partner%'), 2,
  'the partner-billed subscription ended and the direct one began, in the ledger');
select ok(exists (select 1 from app.teams where org_id = pg_temp.id('org_c') and name = 'Tidewater Crew')
  and exists (select 1 from app.memberships where id = pg_temp.id('cora@org_c') and valid_to is null),
  'its data and members stay intact');
select is((select count(*)::int from app.notifications where kind = 'partner.client_left' and recipient_person_id = pg_temp.id('paul')), 1,
  'the partner is told');
select pg_temp.as_user('paul');
select is((select count(*)::int from app.partner_client_orgs(pg_temp.id('org_p')) where org_id = pg_temp.id('org_c')), 0,
  'the partner no longer lists or bills it');
select pg_temp.as_user('cora');
select throws_like($$select app.leave_partner((select id from world where key = 'org_c'), 'Tidewater Events')$$,
  'leave_partner_no_partner:%', 'a direct customer has no partner to leave');
select pg_temp.as_user('mia');
select throws_ok($$select app.leave_partner((select id from world where key = 'org_a'), 'Northwind Live')$$, '42501', null,
  'only the Owner moves billing');

select * from finish();
rollback;

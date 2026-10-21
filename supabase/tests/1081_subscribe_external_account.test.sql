-- pgTAP: journey 60 (A38, RRR-82). The Account Owner of an external account subscribes it; the same
-- organization row becomes a subscribed org with them as Owner, so its account members and the
-- counterparty rows other orgs hold for it carry over with no duplicate. An Account Member, another
-- org's Owner and anon cannot subscribe it, and an already subscribed org is refused.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0200_identity_world.psql

select plan(17);

create temporary table k (key text primary key, id uuid);
grant select, insert on k to public;

-- nina owns an external account, dave is its Account Member, Northwind holds it as a counterparty.
select pg_temp.as_user('nina');
insert into k select 'acct', app.create_external_account('Nina Lighting Rentals', 'nina-lighting', 'For-Profit');
select app.add_account_member((select id from k where key = 'acct'), pg_temp.id('dave'), 'Account Member');
select pg_temp.as_platform();
insert into app.counterparties (org_id, organization_id) values (pg_temp.id('org_a'), (select id from k where key = 'acct'));
insert into k select 'cp', c.id from app.counterparties c where c.organization_id = (select id from k where key = 'acct');

select pg_temp.as_user('nina');
select is((select array_agg(name) from app.my_subscribable_accounts()), array['Nina Lighting Rentals'],
  'the Account Owner sees the account as one she can start using in Atlas');
select pg_temp.as_user('dave');
select is((select count(*)::integer from app.my_subscribable_accounts()), 0, 'an Account Member sees none');

select throws_ok($$select app.subscribe_external_account((select id from k where key = 'acct'))$$, '42501', null,
  'an Account Member cannot subscribe the account');
select pg_temp.as_user('alice');
select throws_ok($$select app.subscribe_external_account((select id from k where key = 'acct'))$$, '42501', null,
  'another org''s Owner cannot subscribe it');
select throws_ok($$select app.subscribe_external_account(pg_temp.id('org_a'))$$, '42501', null,
  'an org Owner is not an Account Owner of her own org');
select pg_temp.as_anon();
select throws_ok($$select app.subscribe_external_account((select id from k where key = 'acct'))$$, '42501', null,
  'anon cannot subscribe');
select pg_temp.as_platform();
select is((select count(*)::integer from app.subscriptions where org_id = (select id from k where key = 'acct') and deleted_at is null),
  0, 'nothing was subscribed by the refused calls');

select pg_temp.as_user('nina');
select is(app.subscribe_external_account((select id from k where key = 'acct')), (select id from k where key = 'acct'),
  'the Account Owner subscribes the account itself');
select pg_temp.as_platform();
select is((select plan_code from app.subscriptions where org_id = (select id from k where key = 'acct') and deleted_at is null),
  'pro', 'it starts a Pro trial (Section 14.7)');
select is((select count(*)::integer from app.organizations where slug = 'nina-lighting' or name = 'Nina Lighting Rentals'),
  1, 'no second organization is created');
select is((select array_agg(r.code) from app.memberships m join app.membership_roles mr on mr.membership_id = m.id and mr.deleted_at is null
    join app.roles r on r.id = mr.role_id
  where m.org_id = (select id from k where key = 'acct') and m.person_id = pg_temp.id('nina')), array['owner'],
  'the Account Owner becomes the org''s Owner');
select is((select organization_id from app.counterparties where id = (select id from k where key = 'cp')),
  (select id from k where key = 'acct'), 'Northwind''s counterparty row still names the same organization');
select is((select count(*)::integer from app.account_memberships where org_id = (select id from k where key = 'acct')
  and person_id = pg_temp.id('dave') and deleted_at is null), 1, 'the account''s members carry over');

select pg_temp.as_user('nina');
select throws_ok($$select app.subscribe_external_account((select id from k where key = 'acct'))$$, 'XR001', null,
  'a second subscribe is refused: account_already_subscribed');
select is((select count(*)::integer from app.my_subscribable_accounts()), 0, 'a subscribed account is no longer offered');
select is((select count(*)::integer from app.organizations where id = (select id from k where key = 'acct')), 1,
  'the new Owner reads her org');
select pg_temp.as_user('xavier');
select is((select count(*)::integer from app.memberships where org_id = (select id from k where key = 'acct')), 0,
  'another org''s Owner reads none of its memberships');

select * from finish();
rollback;

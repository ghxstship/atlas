-- pgTAP: Partner console (Section 4.6.1, A36). Bluewater Partners (org_p, paul) is the partner of
-- Tidewater Events (org_c, cora). Covers wholesale terms, the inherited brand, client prices, wholesale
-- statements priced in the database, and support sessions: partner staff read nothing of the client until
-- its Owner grants one, the grants land in the client's audit ledger, and ending the session ends access.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0200_identity_world.psql

select plan(48);

-- World: a venue in the client org, and a partner admin who is not an Owner ------------------------------
select pg_temp.new_user('pia', 'pia@bluewater.test', 'Pia Lindgren');
select pg_temp.join_org('paul', 'org_p', 'pia', 'admin');
select pg_temp.new_user('ivan', 'ivan@bluewater.test', 'Ivan Petrov');
select pg_temp.join_org('paul', 'org_p', 'ivan', 'member');
select pg_temp.new_user('cole', 'cole@tidewater.test', 'Cole Avery');
select pg_temp.join_org('cora', 'org_c', 'cole', 'admin');
select pg_temp.as_user('cora');
with x as (insert into app.venues (org_id, name, jurisdiction_id, time_zone)
  values (pg_temp.id('org_c'), 'Tidewater Boathouse', 'US-FL-MIAMI-DADE', 'America/New_York') returning id)
  insert into world select 'venue_c', id from x;
select pg_temp.as_platform();

-- Plan prices mirror plans.yaml ---------------------------------------------------------------------------
select is((select monthly_minor from private.plan_list_prices where plan_code = 'core' and currency_code = 'USD'), 4900::bigint,
  'Core lists at 4,900 cents a month in USD');
select is((select monthly_minor from private.plan_list_prices where plan_code = 'core' and currency_code = 'EUR'), null::bigint,
  'and stays unpriced in EUR, never zero');

-- Wholesale terms are the platform's -----------------------------------------------------------------------
select pg_temp.as_user('paul');
select throws_ok($$insert into app.partner_agreements (org_id, wholesale_discount_bps, currency_code, signed_on)
  values ((select id from world where key = 'org_p'), 9000, 'USD', current_date)$$, '42501', null,
  'a partner cannot write its own wholesale discount');
select pg_temp.as_platform();
insert into app.partner_agreements (org_id, wholesale_discount_bps, currency_code, signed_on)
values (pg_temp.id('org_p'), 2000, 'USD', current_date);
select throws_ok($$insert into app.partner_agreements (org_id, wholesale_discount_bps, currency_code, signed_on)
  values ((select id from world where key = 'org_a'), 9500, 'USD', current_date)$$, '23514', null,
  'a discount above 90 percent is refused');
select pg_temp.as_user('pia');
select is((select wholesale_discount_bps from app.partner_agreements where org_id = pg_temp.id('org_p')), 2000,
  'partner staff with org.partner.manage read their terms');
select pg_temp.as_user('ivan');
select is((select count(*)::int from app.partner_agreements), 0, 'a partner Member does not');
select pg_temp.as_user('cora');
select is((select count(*)::int from app.partner_agreements), 0, 'nor does the client');

-- Default brand and inheritance -----------------------------------------------------------------------------
select pg_temp.as_user('paul');
insert into app.partner_default_brands (org_id, accent_hex, radius_scale, allow_client_override)
values (pg_temp.id('org_p'), '#1F6FEB', 'Rounded', true);
select is((select accent_hex from api_public.org_brand_for_slug('tidewater-events')), '#1F6FEB',
  'the client renders the partner''s accent');
select is((select inherited from app.effective_brand(pg_temp.id('org_c'))), true, 'and the partner sees it is inherited');
select pg_temp.as_user('cora');
select is((select accent_hex || ' ' || inherited::text from app.effective_brand(pg_temp.id('org_c'))), '#1F6FEB true',
  'the client Owner sees the inherited brand too');
insert into app.org_brands (org_id, accent_hex) values (pg_temp.id('org_c'), '#B42318');
select is((select accent_hex from api_public.org_brand_for_slug('tidewater-events')), '#B42318',
  'with overrides allowed, the client''s own accent wins');
select pg_temp.as_user('paul');
update app.partner_default_brands set allow_client_override = false where org_id = pg_temp.id('org_p');
select is((select accent_hex from api_public.org_brand_for_slug('tidewater-events')), '#1F6FEB',
  'without overrides, the partner''s accent wins again');
select is((select accent_hex from api_public.org_brand_for_slug('bluewater-partners')), null::text,
  'the partner''s own brand is untouched by its client default');
select pg_temp.as_user('xavier');
select is((select count(*)::int from app.effective_brand(pg_temp.id('org_c'))), 0, 'another org cannot read the client''s brand resolution');
select throws_ok($$insert into app.partner_default_brands (org_id, accent_hex) values ((select id from world where key = 'org_p'), '#000000')$$,
  '42501', null, 'nor set the partner''s default brand');
select pg_temp.as_user('cora');
select throws_ok($$insert into app.partner_default_brands (org_id, accent_hex) values ((select id from world where key = 'org_c'), '#000000')$$,
  'XR001', 'partner_is_client: A client org cannot have clients of its own, so it sets no default client brand.',
  'a client org sets no default client brand');

-- Client prices ----------------------------------------------------------------------------------------------
select pg_temp.as_user('paul');
insert into app.partner_client_prices (org_id, client_org_id, monthly_minor, currency_code)
values (pg_temp.id('org_p'), pg_temp.id('org_c'), 6500, 'USD');
select throws_ok($$insert into app.partner_client_prices (org_id, client_org_id, monthly_minor, currency_code)
  values ((select id from world where key = 'org_p'), (select id from world where key = 'org_a'), 100, 'USD')$$,
  'XR001', 'partner_client_unknown: The org is not a client of this partner.', 'a partner prices only its own clients');
select pg_temp.as_user('cora');
select is((select count(*)::int from app.partner_client_prices), 0, 'the client never sees the partner''s price list');

-- Client list and usage: billing facts only -------------------------------------------------------------------
select pg_temp.as_user('pia');
select is((select name || ' ' || plan_code || ' ' || owner_joined::text from app.partner_client_orgs(pg_temp.id('org_p'))),
  'Tidewater Events core true', 'the partner lists its client, plan and joined Owner');
select is((select count(*)::int from app.partner_client_usage(pg_temp.id('org_p'), date_trunc('month', now())::date)), 0,
  'and reads usage totals for the month');
select pg_temp.as_user('ivan');
select throws_ok($$select * from app.partner_client_orgs((select id from world where key = 'org_p'))$$, '42501', null,
  'a partner Member cannot open the client list');
select pg_temp.as_anon();
select throws_ok($$select * from app.partner_client_orgs(gen_random_uuid())$$, '42501', null, 'anon cannot either');

-- Wholesale billing ---------------------------------------------------------------------------------------------
select pg_temp.as_user('pia');
select throws_ok($$select app.run_wholesale_billing((select id from world where key = 'org_p'), date_trunc('month', now())::date)$$,
  '42501', null, 'a partner Admin cannot run wholesale billing (Owner only)');
select pg_temp.as_user('paul');
select throws_ok($$select app.run_wholesale_billing((select id from world where key = 'org_p'), (date_trunc('month', now()) + interval '2 days')::date)$$,
  'XR001', 'wholesale_period_month: A wholesale statement covers a calendar month; give its first day.', 'a period starts on the first of the month');
select throws_ok($$select app.run_wholesale_billing((select id from world where key = 'org_p'), (date_trunc('month', now()) + interval '1 month')::date)$$,
  'XR001', 'wholesale_period_future: A month is billed once it has started.', 'a future month is not billed');
select lives_ok($$insert into world select 'stmt', app.run_wholesale_billing((select id from world where key = 'org_p'), date_trunc('month', now())::date)$$,
  'the partner Owner runs wholesale billing for the month');
select is((select client_count || ' ' || list_total_minor || ' ' || wholesale_total_minor || ' ' || unpriced_count
           from app.wholesale_statements where id = pg_temp.id('stmt')), '1 4900 3920 0',
  'the Core client bills 4,900 at list and 3,920 at the 20 percent wholesale discount');
select is((select client_price_minor from app.wholesale_statement_lines where wholesale_statement_id = pg_temp.id('stmt')), 6500::bigint,
  'the line shows what the partner charges the client');
select throws_ok($$select app.run_wholesale_billing((select id from world where key = 'org_p'), date_trunc('month', now())::date)$$,
  'XR001', 'wholesale_statement_exists: This month is already billed.', 'a month is billed once');
select pg_temp.as_platform();
select throws_ok($$update app.wholesale_statements set list_total_minor = 1 where id = (select id from world where key = 'stmt')$$,
  'XR001', null, 'a statement never changes once issued');
select pg_temp.as_user('xavier');
select throws_ok($$select app.run_wholesale_billing((select id from world where key = 'org_b'), date_trunc('month', now())::date)$$,
  'XR001', 'partner_agreement_missing: Wholesale billing starts once the platform records your partner agreement.',
  'an org without an agreement cannot bill');
select is((select count(*)::int from app.wholesale_statements), 0, 'and reads no other partner''s statements');

-- Support sessions -----------------------------------------------------------------------------------------------
select pg_temp.as_user('pia');
select is((select count(*)::int from app.venues where org_id = pg_temp.id('org_c')), 0,
  'partner staff read none of the client''s venues without a support session');
select throws_ok($$select app.grant_support_session((select id from world where key = 'org_c'), 4, 'Help with the import.')$$,
  '42501', null, 'partner staff cannot grant themselves a session');
select pg_temp.as_user('cole');
select throws_ok($$select app.grant_support_session((select id from world where key = 'org_c'), 4, 'Help with the import.')$$,
  '42501', null, 'a client Admin cannot grant one (Owner only)');
select pg_temp.as_user('alice');
select throws_ok($$select app.grant_support_session((select id from world where key = 'org_a'), 4, 'Help.')$$,
  'XR001', 'support_session_no_partner: Only a client org grants its partner a support session.', 'an org with no partner grants none');
select pg_temp.as_user('cora');
select throws_ok($$select app.grant_support_session((select id from world where key = 'org_c'), 25, 'Help with the import.')$$,
  'XR001', 'support_session_hours: A support session lasts from 1 to 24 hours.', 'a session lasts at most 24 hours');
select throws_ok($$select app.grant_support_session((select id from world where key = 'org_c'), 4, '  ')$$,
  'XR001', 'support_session_reason: Say why the partner needs access, in up to 500 characters.', 'a session needs a reason');
select lives_ok($$insert into world select 'sess', app.grant_support_session((select id from world where key = 'org_c'), 4, 'Help with the import.')$$,
  'the client Owner grants a four-hour session');
select throws_ok($$select app.grant_support_session((select id from world where key = 'org_c'), 2, 'Another.')$$,
  'XR001', 'support_session_active: A support session is already open; end it before granting another.', 'one open session at a time');
select pg_temp.as_user('pia');
select is((select name from app.venues where org_id = pg_temp.id('org_c')), 'Tidewater Boathouse',
  'during the session partner staff read the client''s venues');
select throws_ok($$insert into app.venues (org_id, name, jurisdiction_id, time_zone)
  values ((select id from world where key = 'org_c'), 'Support Write', 'US-FL-MIAMI-DADE', 'America/New_York')$$,
  '42501', null, 'but never write');
select is((select support_session_id from app.partner_client_orgs(pg_temp.id('org_p'))), pg_temp.id('sess'),
  'the console shows the open session');
select pg_temp.as_user('xavier');
select is((select count(*)::int from app.venues where org_id = pg_temp.id('org_c')), 0, 'other orgs still read nothing');
select pg_temp.as_platform();
select ok((select count(*) from app.audit_events a where a.org_id = pg_temp.id('org_c') and a.subject_table = 'app.record_grants') > 0,
  'every session grant is in the client''s audit ledger');
select pg_temp.as_user('pia');
select lives_ok($$select app.end_support_session((select id from world where key = 'sess'))$$, 'partner staff may end the session early');
select is((select count(*)::int from app.venues where org_id = pg_temp.id('org_c')), 0, 'and access ends at once');
select throws_ok($$select app.end_support_session((select id from world where key = 'sess'))$$,
  'XR001', 'support_session_ended: This support session has already ended.', 'an ended session stays ended');

select * from finish();
rollback;

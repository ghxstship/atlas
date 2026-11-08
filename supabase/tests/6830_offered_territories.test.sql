-- pgTAP: migration 6830, the offered territories (ADR 0160). Only the United States is offered by default; an organization
-- cannot start outside an offered territory through any of the four creation paths; an invited person outside the US
-- is untouched; an omitted country records nothing and is listed for review; an operator opens or closes a territory and
-- records a one-use exception, each on the console ledger; a partner cannot price in a closed currency.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0200_identity_world.psql

select plan(98);

create function pg_temp.as_op(p_key text) returns void
language plpgsql as $$
begin
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', pg_temp.id(p_key || '_user'), 'role', 'authenticated', 'aal', 'aal2')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;

select pg_temp.new_user('olga', 'olga@platform.test', 'Olga Brandt');
select pg_temp.new_user('omar', 'omar@platform.test', 'Omar Haddad');
select pg_temp.new_user('liesel', 'liesel@example.de', 'Liesel Vogel');
select pg_temp.new_user('tomas', 'tomas@example.de', 'Tomas Weber');
select pg_temp.new_user('rene', 'rene@example.fr', 'Rene Martin');
select pg_temp.new_user('una', 'una@example.us', 'Una Hale');
select pg_temp.as_platform();
select private.grant_platform_operator('olga@platform.test', 'Administrator', 'First platform administrator.');
select private.grant_platform_operator('omar@platform.test', 'Support', 'Support on call.');

-- The default: the United States alone ----------------------------------------------------------------------------------
select pg_temp.as_anon();
select is((select array_agg(code) from api_public.offered_territories()), array['US'], 'by default only the United States is offered, and a signed-out page can read that');
select is((select currency_codes from api_public.offered_territories()), array['USD'], 'with its one currency');
select is((select locale_codes from api_public.offered_territories()), array['en-US', 'es-US'], 'and the two launch languages');
select pg_temp.as_platform();
select is((select count(*)::int from private.territories where not offered), 7, 'closed territories keep their rows, so nothing has to be rebuilt to open them');
select is((select currency_code from private.territory_currencies where territory_code = 'EEA'), 'EUR', 'the euro stays with its territory');
select throws_ok($$insert into private.territory_countries (territory_code, country_code) values ('GB', 'US')$$, '23505', null, 'the database holds a country to one territory');
select ok(not exists (select 1 from unnest(array['USD', 'EUR', 'GBP', 'CAD', 'AUD']) c
  where not exists (select 1 from private.plan_list_prices lp where lp.currency_code = c)), 'and the price book keeps every currency');
select ok(exists (select 1 from private.setting_choices where setting_key = 'locale.language' and choice = 'fr-FR'), 'and the settings registry keeps the Beta languages');

-- Signup -----------------------------------------------------------------------------------------------------------------
create temporary table k (key text primary key, id uuid);
grant select, insert on k to public;

select pg_temp.as_user('una');
select ok(app.create_organization('Una Staging', 'una-staging', 'US') is not null, 'an organization in the United States starts');
select is((select country_code from app.organizations where slug = 'una-staging'), 'US', 'and records the country stated');
select ok(app.create_organization('Una Island', 'una-island', 'PR') is not null, 'Puerto Rico is in the United States territory');
select ok(app.create_organization('Una Default', 'una-default') is not null, 'an API caller who omits the country keeps working, as v1 promises');
select is((select country_code from app.organizations where slug = 'una-default'), null, 'and the row records no statement nobody made');

select pg_temp.as_user('liesel');
select throws_ok($$select app.create_organization('Vogel Licht', 'vogel-licht', 'DE')$$, 'XR001',
  'territory_not_offered: XOS is not offered to organizations in this country.', 'an organization in Germany is refused, and says why');
select is((select count(*)::int from app.organizations where slug = 'vogel-licht'), 0, 'and nothing was created');
select throws_ok($$select app.create_organization('Nowhere', 'nowhere-org', 'germany')$$, 'XR001',
  'organization_country_invalid: Choose the country the organization is established in.', 'a country must be a two-letter code');

-- A Gateway company account: the same gate ------------------------------------------------------------------------------
select throws_ok($$select app.create_external_account('Vogel Licht', 'vogel-konto', 'For-Profit', 'DE')$$, 'XR001',
  'territory_not_offered: XOS is not offered to organizations in this country.', 'a company in Germany cannot create a Gateway company account');
select is((select count(*)::int from app.organizations where slug = 'vogel-konto'), 0, 'and nothing was created');
select throws_ok($$select app.create_external_account('Vogel Licht', 'vogel-konto', 'For-Profit', 'germany')$$, 'XR001',
  'organization_country_invalid: Choose the country the organization is established in.', 'its country must be a two-letter code too');
insert into k select 'acct', app.create_external_account('Vogel Rigging', 'vogel-rigging', 'For-Profit', 'US');
insert into k select 'acct_silent', app.create_external_account('Vogel Silent', 'vogel-silent');
select pg_temp.as_platform();
select is((select country_code from app.organizations where slug = 'vogel-rigging'), 'US', 'a company account in the United States records the country stated');
select is((select country_code from app.organizations where slug = 'vogel-silent'), null, 'one that states nothing records nothing');
select pg_temp.as_user('liesel');
select throws_ok($$select app.subscribe_external_account((select id from k where key = 'acct_silent'), 'DE')$$, 'XR001',
  'territory_not_offered: XOS is not offered to organizations in this country.', 'a company account with no country on record cannot start Atlas from Germany');
select throws_ok($$select app.subscribe_external_account((select id from k where key = 'acct'), 'DE')$$, 'XR001',
  'organization_country_recorded: This company''s country is on record. Ask support to change it.', 'and one with a country on record cannot state another');
select pg_temp.as_platform();
select is((select count(*)::int from app.subscriptions s join app.organizations o on o.id = s.org_id where o.slug = 'vogel-rigging'), 0, 'and has no subscription after the refusal');
select pg_temp.as_user('liesel');
select ok(app.subscribe_external_account((select id from k where key = 'acct')) is not null, 'omitted, the country on its record stands, and it starts Atlas');
select is((select country_code from app.organizations where slug = 'vogel-rigging'), 'US', 'and the record is unchanged');

-- A partner's client ------------------------------------------------------------------------------------------------------
-- A platform operator has allowed org_a to create clients (6870), so the country is what decides here.
select pg_temp.as_platform();
insert into private.partner_client_grants (org_id, reason, granted_by)
values (pg_temp.id('org_a'), 'Test: signed partner agreement.', pg_temp.id('alice'));
select pg_temp.as_user('alice');
select throws_ok(format($$select * from app.create_client_organization(%L, 'Klient', 'klient-de', 'owner@example.de', 'access', 'DE')$$, pg_temp.id('org_a')), 'XR001',
  'territory_not_offered: XOS is not offered to organizations in this country.', 'a partner cannot start a client outside an offered territory');
select is((select (t.r).org_id is not null from (select app.create_client_organization(pg_temp.id('org_a'), 'Client US', 'client-us', 'owner@example.us', 'access', 'US') as r) t), true, 'a partner can start one in the United States');

-- A partner's prices ------------------------------------------------------------------------------------------------------
insert into k select 'client', id from app.organizations where slug = 'client-us';
select throws_ok(format($$insert into app.partner_client_prices (org_id, client_org_id, monthly_minor, currency_code) values (%L, %L, 1000, 'EUR')$$,
  pg_temp.id('org_a'), (select id from k where key = 'client')), 'XR001',
  'partner_price_currency_not_offered: Set this price in a currency XOS is offered in.', 'a partner cannot write a price in a closed territory''s currency, even directly');
select lives_ok(format($$insert into app.partner_client_prices (org_id, client_org_id, monthly_minor, currency_code) values (%L, %L, 1000, 'USD')$$,
  pg_temp.id('org_a'), (select id from k where key = 'client')), 'a price in dollars is set');
select throws_ok(format($$update app.partner_client_prices set currency_code = 'GBP' where client_org_id = %L$$, (select id from k where key = 'client')), 'XR001',
  'partner_price_currency_not_offered: Set this price in a currency XOS is offered in.', 'and cannot move to a closed currency');

-- Being invited is not being offered XOS -----------------------------------------------------------------------------------
select pg_temp.join_org('alice', 'org_a', 'tomas', 'member');
select pg_temp.as_user('tomas');
select is((select count(*)::int from app.memberships m where m.org_id = pg_temp.id('org_a') and m.person_id = pg_temp.id('tomas')), 1, 'a crew member abroad joins a US organization by invitation, with no country asked');
select is((select count(*)::int from app.organizations where id = pg_temp.id('org_a')), 1, 'and reads it like anyone else');

-- Checkout ------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('una');
select is(app.org_checkout_currency((select id from app.organizations where slug = 'una-staging')), 'USD', 'a US organization pays in dollars');
select pg_temp.as_user('tomas');
select throws_ok($$select app.org_checkout_currency((select id from app.organizations where slug = 'una-staging'))$$, '42501', null, 'only a member reads it');

-- Exceptions ----------------------------------------------------------------------------------------------------------------
select pg_temp.as_op('omar');
select throws_ok($$select app.console_grant_territory_exception('liesel@example.de', 'DE', 'MSA-2026-014', current_date, 'Signed MSA.')$$, '42501', null, 'Support cannot record an exception');
select pg_temp.as_op('olga');
select throws_ok($$select app.console_grant_territory_exception('liesel@example.de', 'US', 'MSA-2026-014', current_date, 'Signed MSA.')$$, 'XR001',
  'territory_exception_not_needed: XOS is already offered in that country.', 'no exception where XOS is offered');
select throws_ok($$select app.console_grant_territory_exception('liesel@example.de', 'DE', 'MSA-2026-014', current_date + 30, 'Signed MSA.')$$, 'XR001',
  'territory_exception_signed_on: An exception needs a contract that is already signed: enter its date.', 'the contract must already be signed');
select lives_ok($$select app.console_grant_territory_exception('Liesel@Example.DE', 'DE', 'MSA-2026-014', current_date, 'Signed MSA with Vogel Licht.')$$, 'an Administrator records an exception for a signed contract');
select is((select count(*)::int from app.platform_operator_actions where action = 'territory_exception.granted' and reason = 'Signed MSA with Vogel Licht.'), 1, 'on the console ledger');
select pg_temp.as_user('rene');
select throws_ok($$select app.create_organization('Autre', 'autre-de', 'DE')$$, 'XR001',
  'territory_not_offered: XOS is not offered to organizations in this country.', 'another person gets no use of it');
select pg_temp.as_user('liesel');
select throws_ok($$select app.create_organization('Vogel Licht', 'vogel-licht-fr', 'FR')$$, 'XR001',
  'territory_not_offered: XOS is not offered to organizations in this country.', 'nor does another country');
select ok(app.create_organization('Vogel Licht', 'vogel-licht', 'DE') is not null, 'the person it names starts the one organization');
select is((select country_code from app.organizations where slug = 'vogel-licht'), 'DE', 'in the country it names');
select is(app.org_checkout_currency((select id from app.organizations where slug = 'vogel-licht')), 'USD', 'it opens no other currency: a closed territory pays in dollars');
select throws_ok($$select app.create_organization('Vogel Zwei', 'vogel-zwei', 'DE')$$, 'XR001',
  'territory_not_offered: XOS is not offered to organizations in this country.', 'and it is used once');
select pg_temp.as_platform();
select throws_ok(format($$select private.use_territory_exception(%L, %L)$$,
  (select id from private.territory_exceptions where owner_email = 'liesel@example.de'), (select id from app.organizations where slug = 'vogel-licht')), 'XR001',
  'territory_not_offered: XOS is not offered to organizations in this country.', 'using a spent exception refuses rather than passing quietly');

-- An exception on a company account, and what it does not reach
select pg_temp.as_op('olga');
select lives_ok($$select app.console_grant_territory_exception('tomas@example.de', 'DE', 'US-CUSTOMER-VENDOR-7', current_date, 'A US customer''s signed contract engages this vendor.')$$, 'an exception for a vendor company');
select pg_temp.as_user('tomas');
insert into k select 'acct_de', app.create_external_account('Weber Audio', 'weber-audio', 'For-Profit', 'DE');
select pg_temp.as_platform();
select is((select country_code from app.organizations where slug = 'weber-audio'), 'DE', 'the person it names creates the company account');
select pg_temp.as_user('tomas');
select throws_ok($$select app.subscribe_external_account((select id from k where key = 'acct_de'))$$, 'XR001',
  'territory_not_offered: XOS is not offered to organizations in this country.', 'which cannot then start Atlas on the record of its country and a spent exception');
select throws_ok($$select app.subscribe_external_account((select id from k where key = 'acct_de'), 'US')$$, 'XR001',
  'organization_country_recorded: This company''s country is on record. Ask support to change it.', 'nor by stating the United States instead');
select pg_temp.as_platform();
select is((select country_code from app.organizations where slug = 'weber-audio'), 'DE', 'so its record stands');
select pg_temp.as_op('olga');
select is((select country_code from app.console_orgs_outside_territories() where slug = 'weber-audio'), 'DE', 'and it stays on the operators'' review list');
select lives_ok($$select app.console_grant_territory_exception('tomas@example.de', 'DE', 'MSA-2026-016', current_date, 'Signed MSA for Atlas.')$$, 'a second contract, a second exception');
select pg_temp.as_user('tomas');
select ok(app.subscribe_external_account((select id from k where key = 'acct_de'), 'DE') is not null, 'and with it the company starts Atlas');

-- A partner cannot use up someone else's exception
select pg_temp.as_op('olga');
select lives_ok($$select app.console_grant_territory_exception('owner@example.de', 'DE', 'MSA-2026-017', current_date, 'Signed MSA.')$$, 'an exception naming a client''s owner');
select pg_temp.as_user('alice');
select throws_ok(format($$select * from app.create_client_organization(%L, 'Klient', 'klient-de', 'owner@example.de', 'access', 'DE')$$, pg_temp.id('org_a')), 'XR001',
  'territory_not_offered: XOS is not offered to organizations in this country.', 'a partner who knows the email and the country gets no use of it');
select pg_temp.as_op('olga');
select is((select used_at from app.console_list_territory_exceptions() where owner_email = 'owner@example.de'), null, 'and it stays open for the person it names');

select is((select org_name from app.console_list_territory_exceptions() where owner_email = 'liesel@example.de'), 'Vogel Licht', 'the operator sees what it became');
select is((select exception_contract from app.console_orgs_outside_territories() where slug = 'vogel-licht'), 'MSA-2026-014', 'and finds the org in the list outside the territories, with its contract');
select ok((select uses_atlas from app.console_orgs_outside_territories() where slug = 'vogel-licht'), 'marked as using Atlas');
select is((select country_code from app.console_orgs_outside_territories() where slug = 'una-default'), null, 'an org whose creator stated no country is listed for a person to review');
select ok(exists (select 1 from app.console_orgs_outside_territories() where slug = 'vogel-silent' and not uses_atlas), 'so is a company account with none, marked as not using Atlas');
select ok(not exists (select 1 from app.console_orgs_outside_territories() where slug = 'una-staging'), 'one in an offered territory is not');
select pg_temp.as_platform();
insert into app.organizations (name, slug) values ('Counterparty Only', 'counterparty-only');
select pg_temp.as_op('olga');
select ok(not exists (select 1 from app.console_orgs_outside_territories() where slug = 'counterparty-only'), 'nor is a counterparty row nobody belongs to');
select pg_temp.as_platform();
select private.ensure_accepted_membership((select id from app.organizations where slug = 'counterparty-only'), pg_temp.id('una'), 'Account Member', null);
select pg_temp.as_op('olga');
select ok(not exists (select 1 from app.console_orgs_outside_territories() where slug = 'counterparty-only'), 'nor one holding only an Account Member from a roster invitation, which nobody started');
select throws_ok(format($$select app.console_revoke_territory_exception(%L, 'Too late.')$$,
  (select id from app.console_list_territory_exceptions() where owner_email = 'liesel@example.de')), 'XR001',
  'territory_exception_transition_not_allowed: Only an open exception can be withdrawn.', 'a used exception cannot be withdrawn');
select lives_ok($$select app.console_grant_territory_exception('rene@example.fr', 'FR', 'MSA-2026-015', current_date, 'Signed MSA.')$$, 'a second exception');
select lives_ok(format($$select app.console_revoke_territory_exception(%L, 'Contract fell through.')$$,
  (select id from app.console_list_territory_exceptions() where owner_email = 'rene@example.fr')), 'an open one can be withdrawn');
select pg_temp.as_user('rene');
select throws_ok($$select app.create_organization('Autre', 'autre-fr', 'FR')$$, 'XR001',
  'territory_not_offered: XOS is not offered to organizations in this country.', 'and then allows nothing');

-- Opening and closing --------------------------------------------------------------------------------------------------------
select pg_temp.as_op('omar');
select throws_ok($$select app.console_set_territory_offered('GB', true, 'Representative appointed.')$$, '42501', null, 'Support cannot open a territory');
select pg_temp.as_op('olga');
select throws_ok($$select app.console_set_territory_offered('GB', true, '')$$, 'XR001',
  'territory_reason: Say why, in up to 500 characters.', 'opening needs a reason');
select throws_ok($$select app.console_set_territory_offered('US', true, 'Already.')$$, 'XR001',
  'territory_transition_not_allowed: The territory is already in that state.', 'an open territory cannot open again');
select throws_ok($$select app.console_set_territory_offered('US', false, 'Closing everything.')$$, 'XR001',
  'territory_last_offered: XOS must stay offered somewhere. Open another territory first.', 'the last open territory cannot close');
select lives_ok($$select app.console_set_territory_offered('GB', true, 'UK representative appointed.')$$, 'an Administrator opens a territory');
select is((select count(*)::int from app.platform_operator_actions where action = 'territory.opened' and reason = 'UK representative appointed.' and details->>'code' = 'GB'), 1, 'on the console ledger');
select is((select array_agg(code order by code) from api_public.offered_territories()), array['GB', 'US'], 'it is offered at once, with no code change');
select pg_temp.as_user('rene');
select ok(app.create_organization('Thames Crew', 'thames-crew', 'GB') is not null, 'an organization there can now start');
select is(app.org_checkout_currency((select id from app.organizations where slug = 'thames-crew')), 'GBP', 'and pays in its currency');
select pg_temp.as_user('alice');
select lives_ok(format($$update app.partner_client_prices set currency_code = 'GBP' where client_org_id = %L$$, (select id from k where key = 'client')), 'and a partner can price in its currency');
select pg_temp.as_op('olga');
select throws_ok($$select app.console_save_territory('NZ', 'New Zealand', 'Nueva Zelanda', array['GB'], '{}', '{}', 'Adding.', true)$$, 'XR001',
  'territory_country_taken: A country belongs to one territory. Take it out of the other one first.', 'a country belongs to one territory');
select throws_ok($$select app.console_save_territory('NZ', 'New Zealand', 'Nueva Zelanda', array['NZ'], array['NZD'], '{}', 'Adding.', true)$$, 'XR001',
  'territory_currency_unpriced: Choose currencies the price book has.', 'a currency needs a price book');
select throws_ok($$select app.console_save_territory('EEA', 'Anything', 'Cualquiera', array['IS'], '{}', '{}', 'Adding by mistake.', true)$$, 'XR001',
  'territory_code_taken: A territory already has that code. Edit it from the list.', 'adding cannot land on a territory that exists, so an empty form cannot wipe its lists');
select is((select currency_codes from app.console_list_territories() where code = 'EEA'), array['EUR'], 'which keep their currency');
select throws_ok($$select app.console_save_territory('ZZ', 'Nowhere', 'Ninguna', array['ZZ'], '{}', '{}', 'Editing.', false)$$, 'XR001',
  'territory_unknown: Choose a territory from the list.', 'editing needs a territory that exists');
select lives_ok($$select app.console_save_territory('NZ', 'New Zealand', 'Nueva Zelanda', array['NZ'], array['AUD'], '{}', 'Adding New Zealand.', true)$$, 'an Administrator adds a territory');
select ok(not (select offered from app.console_list_territories() where code = 'NZ'), 'which starts closed');
select lives_ok($$select app.console_save_territory('NZ', 'Aotearoa New Zealand', 'Nueva Zelanda', array['NZ'], array['AUD'], '{}', 'Fixing the name.', false)$$, 'and edits it');
select is((select name_en from app.console_list_territories() where code = 'NZ'), 'Aotearoa New Zealand', 'its name changes');
select is((select currency_codes from app.console_list_territories() where code = 'NZ'), array['AUD'], 'and it keeps the lists the edit named');
select lives_ok($$select app.console_save_territory('NZ', 'Aotearoa New Zealand', 'Nueva Zelanda', array['NZ'], '{}', '{}', 'No currency of its own yet.', false)$$, 'an edit can take a currency off');
select is((select currency_codes from app.console_list_territories() where code = 'NZ'), '{}'::text[], 'and does');
select is((select array_agg(currency_code order by currency_code) from app.console_price_book_currencies()), array['AUD', 'CAD', 'EUR', 'GBP', 'USD'], 'and the price book still offers every currency to choose again');
select pg_temp.as_user('una');
select throws_ok($$select * from app.console_price_book_currencies()$$, '42501', null, 'someone who is not an operator cannot read that list');
select pg_temp.as_op('olga');
select lives_ok($$select app.console_set_territory_offered('GB', false, 'Representative contract ended.')$$, 'closing one');
select pg_temp.as_op('olga');
select is((select slug from app.console_orgs_outside_territories() where slug = 'thames-crew'), 'thames-crew', 'touches no organization, and lists it for review');
select pg_temp.as_user('alice');
select lives_ok(format($$update app.partner_client_prices set monthly_minor = 2000 where client_org_id = %L$$, (select id from k where key = 'client')), 'a price already in that currency keeps working');
select throws_ok(format($$update app.partner_client_prices set currency_code = 'AUD' where client_org_id = %L$$, (select id from k where key = 'client')), 'XR001',
  'partner_price_currency_not_offered: Set this price in a currency XOS is offered in.', 'but it cannot move to another closed one');

select * from finish();
rollback;

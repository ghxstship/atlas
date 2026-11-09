-- 6830_offered_territories.sql
-- Launch offers XOS in the United States only (ADR 0160, issue 3 of the AI legal audit; no attorney has reviewed it). GDPR
-- Recital 23 names currency and language as signs of an intent to offer, so a closed territory's prices and languages
-- stay switched off, and no organization starts outside an offered territory, without deleting anything that opens the
-- territory later.
--   * private.territories is the one source of truth: each territory's countries, price book currencies and languages,
--     and whether it is offered. Only the United States is, by default. An operator opens or closes one in the console;
--     no code changes. Every change lands in app.platform_operator_actions with the operator and the reason.
--   * app.organizations.country_code records the country the organization's creator states, and only that. Nothing asks a
--     person's location and nothing reads an IP address: being invited to work for an organization is not being offered
--     XOS, so invitations and every signed-in surface stay as they are.
--   * private.territory_exceptions lets an operator allow one organization outside an offered territory, on the record
--     of a signed contract. It is for one owner email and one country, and it is used once.
--   * app.create_organization, app.subscribe_external_account, app.create_external_account and
--     app.create_client_organization, the ways a customer's organization starts, gain a country and refuse
--     territory_not_offered. A partner cannot use an exception: an exception is the named person's, and only that person
--     signed in can use it.
--   * API v1 stays additive, so p_country_code stays optional. A caller who omits it stated nothing and the row says so:
--     country_code stays null and console_orgs_outside_territories lists the organization for a person to review.
--   * A partner's price for a client cannot be set in a closed territory's currency (private.guard_partner_price_currency).
-- Recreated from their latest definitions: app.create_organization, app.create_client_organization and
-- app.subscribe_external_account from 1612, and app.create_external_account from 2630.

-- The organization's country -------------------------------------------------------------------------------------------

alter table app.organizations add column country_code text;
alter table app.organizations add constraint organizations_country_code_format
  check (country_code is null or country_code ~ '^[A-Z]{2}$');
comment on column app.organizations.country_code is 'ISO 3166-1 alpha-2 country the organization''s creator stated, which decides whether XOS is offered to it (private.territories). Null when nobody stated one: an organization from before the question, a caller of the API or the database functions who omitted it, a counterparty or a sandbox. Not a person''s location, and never read from an IP address.';

-- Territories ----------------------------------------------------------------------------------------------------------

create table private.territories (
  code text primary key,
  name_en text not null,
  name_es text not null,
  offered boolean not null default false,
  changed_at timestamptz not null default now(),
  changed_by uuid references app.people (id),
  change_reason text not null,
  constraint territories_code_format check (code ~ '^[A-Z][A-Z0-9]{1,7}$'),
  constraint territories_name_en_length check (char_length(btrim(name_en)) between 1 and 100),
  constraint territories_name_es_length check (char_length(btrim(name_es)) between 1 and 100),
  constraint territories_reason_length check (char_length(btrim(change_reason)) between 1 and 500)
);
create index territories_changed_by_idx on private.territories (changed_by);

comment on table private.territories is 'The one source of truth for where XOS is offered (ADR 0160), with private.territory_countries, private.territory_currencies and private.territory_locales: each territory''s countries, the price book currencies and languages that open with it, and whether it is offered. Closed territories keep their rows, so opening one needs no code. Written only by the console RPCs, which log every change to app.platform_operator_actions. Read through api_public.offered_territories.';
comment on column private.territories.code is 'Territory code: an ISO country code for a single country, or a short name such as EEA.';
comment on column private.territories.name_en is 'Name in English, as it reads in "XOS is offered to organizations in ...".';
comment on column private.territories.name_es is 'Name in Spanish, for the same sentence.';
comment on column private.territories.offered is 'Whether XOS is offered there now.';
comment on column private.territories.changed_at is 'When the territory last opened, closed or was edited.';
comment on column private.territories.changed_by is 'Operator who made the last change; null for the launch seed.';
comment on column private.territories.change_reason is 'Why, in the operator''s words.';

create table private.territory_countries (
  country_code text primary key,
  territory_code text not null references private.territories (code),
  constraint territory_countries_format check (country_code ~ '^[A-Z]{2}$')
);
create index territory_countries_territory_idx on private.territory_countries (territory_code);
comment on table private.territory_countries is 'The countries of each territory. The key is the country alone, so a country belongs to one territory.';
comment on column private.territory_countries.country_code is 'ISO 3166-1 alpha-2 country.';
comment on column private.territory_countries.territory_code is 'Its territory.';

create table private.territory_currencies (
  territory_code text not null references private.territories (code),
  currency_code text not null,
  sort_order smallint not null,
  primary key (territory_code, currency_code),
  constraint territory_currencies_format check (currency_code ~ '^[A-Z]{3}$')
);
comment on table private.territory_currencies is 'Price book currencies that open with a territory. The lowest sort_order is what its organizations pay in; a territory with none pays in USD.';
comment on column private.territory_currencies.territory_code is 'The territory.';
comment on column private.territory_currencies.currency_code is 'A currency the price book has (private.plan_list_prices).';
comment on column private.territory_currencies.sort_order is 'Position in the territory''s list, ascending.';

create table private.territory_locales (
  territory_code text not null references private.territories (code),
  locale_code text not null,
  primary key (territory_code, locale_code),
  constraint territory_locales_format check (locale_code ~ '^[a-z]{2}-[A-Z]{2}$')
);
comment on table private.territory_locales is 'Languages (locale.language choices) that open with a territory.';
comment on column private.territory_locales.territory_code is 'The territory.';
comment on column private.territory_locales.locale_code is 'A locale.language choice.';

alter table private.territories enable row level security;
alter table private.territory_countries enable row level security;
alter table private.territory_currencies enable row level security;
alter table private.territory_locales enable row level security;
revoke all on private.territories, private.territory_countries, private.territory_currencies, private.territory_locales from public, anon, authenticated;
grant select on private.territories, private.territory_countries, private.territory_currencies, private.territory_locales to service_role;

insert into private.territories (code, name_en, name_es, offered, change_reason) values
  ('US', 'the United States', 'los Estados Unidos', true, 'Launch offers XOS in the United States only (ADR 0160).'),
  ('EEA', 'the European Economic Area', 'el Espacio Económico Europeo', false, 'Closed at launch: no representative is appointed (ADR 0160).'),
  ('GB', 'the United Kingdom', 'el Reino Unido', false, 'Closed at launch: no representative is appointed (ADR 0160).'),
  ('CH', 'Switzerland', 'Suiza', false, 'Closed at launch (ADR 0160).'),
  ('CA', 'Canada', 'Canadá', false, 'Closed at launch (ADR 0160).'),
  ('AU', 'Australia', 'Australia', false, 'Closed at launch (ADR 0160).'),
  ('BR', 'Brazil', 'Brasil', false, 'Closed at launch (ADR 0160).'),
  ('JP', 'Japan', 'Japón', false, 'Closed at launch (ADR 0160).');

insert into private.territory_countries (territory_code, country_code)
select 'US', unnest(array['US', 'PR', 'VI', 'GU', 'AS', 'MP'])
union all select 'EEA', unnest(array['AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE', 'IS', 'LI', 'NO'])
union all select 'GB', 'GB'
union all select 'CH', 'CH'
union all select 'CA', 'CA'
union all select 'AU', 'AU'
union all select 'BR', 'BR'
union all select 'JP', 'JP';

insert into private.territory_currencies (territory_code, currency_code, sort_order) values
  ('US', 'USD', 10),
  ('EEA', 'EUR', 10),
  ('GB', 'GBP', 10),
  ('CA', 'CAD', 10),
  ('AU', 'AUD', 10);

insert into private.territory_locales (territory_code, locale_code) values
  ('US', 'en-US'),
  ('US', 'es-US'),
  ('EEA', 'fr-FR'),
  ('EEA', 'de-DE'),
  ('EEA', 'it-IT'),
  ('CH', 'fr-FR'),
  ('CH', 'de-DE'),
  ('CH', 'it-IT'),
  ('CA', 'fr-FR'),
  ('BR', 'pt-BR'),
  ('JP', 'ja-JP');

create or replace function private.territory_country_list(p_code text)
returns text[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(array_agg(c.country_code order by c.country_code), '{}') from private.territory_countries c where c.territory_code = p_code;
$$;
comment on function private.territory_country_list(text) is 'A territory''s countries as a list, for the readers below.';
revoke all on function private.territory_country_list(text) from public, anon, authenticated;

create or replace function private.territory_currency_list(p_code text)
returns text[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(array_agg(c.currency_code order by c.sort_order), '{}') from private.territory_currencies c where c.territory_code = p_code;
$$;
comment on function private.territory_currency_list(text) is 'A territory''s currencies in order, for the readers below.';
revoke all on function private.territory_currency_list(text) from public, anon, authenticated;

create or replace function private.territory_locale_list(p_code text)
returns text[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(array_agg(l.locale_code order by l.locale_code), '{}') from private.territory_locales l where l.territory_code = p_code;
$$;
comment on function private.territory_locale_list(text) is 'A territory''s languages as a list, for the readers below.';
revoke all on function private.territory_locale_list(text) from public, anon, authenticated;

create or replace function private.country_offered(p_country text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from private.territory_countries c
    join private.territories t on t.code = c.territory_code
    where c.country_code = p_country and t.offered
  );
$$;
comment on function private.country_offered(text) is 'Whether XOS is offered in a country now.';
revoke all on function private.country_offered(text) from public, anon, authenticated;

create or replace function api_public.offered_territories()
returns table (code text, name_en text, name_es text, country_codes text[], currency_codes text[], locale_codes text[])
language sql
stable
security definer
set search_path = ''
as $$
  select t.code, t.name_en, t.name_es,
    private.territory_country_list(t.code), private.territory_currency_list(t.code), private.territory_locale_list(t.code)
  from private.territories t
  where t.offered
  order by t.code = 'US' desc, t.code;
$$;
comment on function api_public.offered_territories() is 'The territories XOS is offered in now, with their countries, currencies and languages (ADR 0160). Public configuration: signed-out pages choose their languages from it. A reader that cannot reach it falls back to the United States alone (@xos/i18n/offering).';
revoke all on function api_public.offered_territories() from public;
grant execute on function api_public.offered_territories() to anon, authenticated, service_role;

create or replace function app.org_checkout_currency(p_org_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_org_id is null or p_org_id not in (select private.my_org_ids()) then
    raise exception using errcode = '42501', message = 'only a member reads the org''s checkout currency';
  end if;
  return coalesce(
    (select cur.currency_code
     from app.organizations o
     join private.territory_countries c on c.country_code = o.country_code
     join private.territories t on t.code = c.territory_code and t.offered
     join private.territory_currencies cur on cur.territory_code = t.code
     where o.id = p_org_id
     order by cur.sort_order
     limit 1),
    'USD');
end;
$$;
comment on function app.org_checkout_currency(uuid) is 'The currency Stripe Checkout opens in for the org: the first currency of the offered territory holding its stated country, else USD. Checkout always names it, so Stripe never picks a currency from where the buyer seems to be (ADR 0160).';
revoke all on function app.org_checkout_currency(uuid) from public, anon;
grant execute on function app.org_checkout_currency(uuid) to authenticated, service_role;

-- Partner prices ---------------------------------------------------------------------------------------------------------

create or replace function private.currency_offered(p_currency text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_currency = 'USD' or exists (
    select 1 from private.territory_currencies c
    join private.territories t on t.code = c.territory_code
    where c.currency_code = p_currency and t.offered
  );
$$;
comment on function private.currency_offered(text) is 'Whether a price may be set in a currency now: USD always, otherwise a currency of an offered territory.';
revoke all on function private.currency_offered(text) from public, anon, authenticated;

create or replace function private.guard_partner_price_currency()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (tg_op = 'INSERT' or new.currency_code is distinct from old.currency_code)
     and not private.currency_offered(new.currency_code) then
    perform private.refuse('partner_price_currency_not_offered', 'Set this price in a currency XOS is offered in.');
  end if;
  return new;
end;
$$;
comment on function private.guard_partner_price_currency() is 'A partner''s price for a client cannot be set in a closed territory''s currency (ADR 0160). A price already in one stays as it is, and can change its amount, until the partner moves it to an offered currency.';
revoke all on function private.guard_partner_price_currency() from public, anon, authenticated;

create trigger t41_guard_partner_price_currency before insert or update on app.partner_client_prices
  for each row execute function private.guard_partner_price_currency();

-- Exceptions -----------------------------------------------------------------------------------------------------------

create table private.territory_exceptions (
  id uuid primary key default private.uuid_v7(),
  owner_email text not null,
  country_code text not null,
  contract_reference text not null,
  contract_signed_on date not null,
  reason text not null,
  granted_by uuid not null references app.people (id),
  granted_at timestamptz not null default now(),
  org_id uuid references app.organizations (id) on delete set null,
  used_at timestamptz,
  revoked_at timestamptz,
  revoked_by uuid references app.people (id),
  revoke_reason text,
  constraint territory_exceptions_email_lower check (owner_email = lower(btrim(owner_email)) and char_length(owner_email) between 3 and 320),
  constraint territory_exceptions_country_format check (country_code ~ '^[A-Z]{2}$'),
  constraint territory_exceptions_reference_length check (char_length(btrim(contract_reference)) between 1 and 200),
  constraint territory_exceptions_reason_length check (char_length(btrim(reason)) between 1 and 500),
  constraint territory_exceptions_org_when_used check (used_at is not null or org_id is null),
  constraint territory_exceptions_used_or_revoked check (used_at is null or revoked_at is null),
  constraint territory_exceptions_revoked check ((revoked_at is null) = (revoke_reason is null)
    and (revoked_by is null or revoked_at is not null)),
  constraint territory_exceptions_revoke_reason_length check (revoke_reason is null or char_length(btrim(revoke_reason)) between 1 and 500)
);
create unique index territory_exceptions_one_open on private.territory_exceptions (owner_email, country_code)
  where used_at is null and revoked_at is null;
create index territory_exceptions_granted_by_idx on private.territory_exceptions (granted_by);
create index territory_exceptions_revoked_by_idx on private.territory_exceptions (revoked_by);
create index territory_exceptions_org_id_idx on private.territory_exceptions (org_id);

comment on table private.territory_exceptions is 'A recorded exception that allows one organization outside an offered territory, for a signed contract (ADR 0160). An operator names the first Owner''s email, the country and the contract; the org that person starts, signed in with that confirmed email, uses it once. A company account and its later start in Atlas each need one. Revoked once, never edited. Written only by the console RPCs and the org creation RPCs.';
comment on column private.territory_exceptions.id is 'Exception id.';
comment on column private.territory_exceptions.owner_email is 'Email of the person who will be the organization''s first Owner, in lower case.';
comment on column private.territory_exceptions.country_code is 'Country the organization is allowed in.';
comment on column private.territory_exceptions.contract_reference is 'Where the signed contract is filed, or its number.';
comment on column private.territory_exceptions.contract_signed_on is 'The date the contract was signed.';
comment on column private.territory_exceptions.reason is 'Why the exception is right, in the operator''s words.';
comment on column private.territory_exceptions.granted_by is 'Operator who recorded it.';
comment on column private.territory_exceptions.granted_at is 'When it was recorded.';
comment on column private.territory_exceptions.org_id is 'The organization that used it; null until used, or after that organization was purged.';
comment on column private.territory_exceptions.used_at is 'When the organization was created under it.';
comment on column private.territory_exceptions.revoked_at is 'When an operator withdrew it before use.';
comment on column private.territory_exceptions.revoked_by is 'Operator who withdrew it.';
comment on column private.territory_exceptions.revoke_reason is 'Why it was withdrawn.';

alter table private.territory_exceptions enable row level security;
revoke all on private.territory_exceptions from public, anon, authenticated;
grant select on private.territory_exceptions to service_role;

-- The check org creation makes -------------------------------------------------------------------------------------------

create or replace function private.territory_clearance(p_country text, p_owner_email text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_exception uuid;
begin
  if p_country is null then
    return null;
  end if;
  if p_country !~ '^[A-Z]{2}$' then
    perform private.refuse('organization_country_invalid', 'Choose the country the organization is established in.');
  end if;
  if private.country_offered(p_country) then
    return null;
  end if;
  select e.id into v_exception
  from private.territory_exceptions e
  where e.owner_email = p_owner_email and e.country_code = p_country
    and e.used_at is null and e.revoked_at is null
  for update;
  if v_exception is null then
    perform private.refuse('territory_not_offered', 'XOS is not offered to organizations in this country.');
  end if;
  return v_exception;
end;
$$;
comment on function private.territory_clearance(text, text) is 'Whether an organization may start in a country: null when no country was stated or it is in an offered territory, the id of the open exception naming this email and country, locked until the transaction ends so two callers cannot share it, or a refusal (territory_not_offered, organization_country_invalid). The caller passes only a confirmed email of the signed-in person, or null, and marks an exception used once the org exists.';
revoke all on function private.territory_clearance(text, text) from public, anon, authenticated;

create or replace function private.use_territory_exception(p_exception uuid, p_org uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if p_exception is null then
    return;
  end if;
  update private.territory_exceptions e set org_id = p_org, used_at = now()
  where e.id = p_exception and e.used_at is null and e.revoked_at is null;
  if not found then
    perform private.refuse('territory_not_offered', 'XOS is not offered to organizations in this country.');
  end if;
end;
$$;
comment on function private.use_territory_exception(uuid, uuid) is 'Marks an exception used by the org created under it, so it allows one organization, and refuses territory_not_offered if it is already gone. A no-op without an exception.';
revoke all on function private.use_territory_exception(uuid, uuid) from public, anon, authenticated;

-- Org creation, from 1612 ------------------------------------------------------------------------------------------------

drop function app.create_organization(text, text);
create function app.create_organization(p_name text, p_slug text, p_country_code text default null)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
  v_exception uuid := private.territory_clearance(p_country_code, private.my_confirmed_email());
  v_org uuid;
  v_membership uuid;
begin
  perform private.assert_org_slug_available(p_slug);
  insert into app.organizations (name, slug, country_code) values (btrim(p_name), p_slug, p_country_code) returning id into v_org;
  perform private.use_territory_exception(v_exception, v_org);
  perform private.start_trial(v_org, private.trial_plan(), private.org_window_end(v_org, private.trial_days()),
    'Organization created: a 14-day Pro trial with no card.');

  perform private.begin_trusted_operation('membership_write');
  insert into app.memberships (org_id, person_id) values (v_org, v_person) returning id into v_membership;
  insert into app.membership_roles (membership_id, role_id, granted_by)
  values (v_membership, private.system_role_id('owner'), null);
  perform private.end_trusted_operation('membership_write');
  perform private.adopt_standard_library(v_org);
  return v_org;
end;
$$;
comment on function app.create_organization(text, text, text) is 'Creates an organization with the signed-in person as its Owner, in one transaction, in the country they state. A country outside the offered territories is refused territory_not_offered unless an exception names this person''s confirmed email and that country (ADR 0160). A caller who omits the country stated nothing: the org records no country and appears in app.console_orgs_outside_territories. It starts a 14-day Pro trial with no card and moves to the Access plan when the trial ends unless a card is added (Section 14.7), and receives its editable copy of the XOS Standard Library (Section 7.2). Returns the org id.';
revoke all on function app.create_organization(text, text, text) from public, anon;
grant execute on function app.create_organization(text, text, text) to authenticated, service_role;

drop function app.create_client_organization(uuid, text, text, text, text);
create function app.create_client_organization(
  p_partner_org_id uuid,
  p_name text,
  p_slug text,
  p_owner_email text,
  p_plan_code text default 'access',
  p_country_code text default null
)
returns table (org_id uuid, invite_id uuid, invite_token text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
  v_org uuid;
  v_token text := private.issue_invite_token();
  v_invite uuid;
begin
  if not private.has_capability(p_partner_org_id, 'org.partner.manage') then
    raise exception using errcode = '42501', message = 'org.partner.manage is required in the partner org';
  end if;
  -- An exception is the named person's own: a partner naming their email cannot use it.
  perform private.territory_clearance(p_country_code, null);
  perform private.assert_org_slug_available(p_slug);
  insert into app.organizations (name, slug, parent_org_id, country_code)
  values (btrim(p_name), p_slug, p_partner_org_id, p_country_code)
  returning id into v_org;
  perform private.create_subscription(v_org, p_plan_code);
  insert into app.invites (org_id, email, role_id, token_hash, expires_at, invited_by, partner_bootstrap)
  values (v_org, lower(btrim(p_owner_email)), private.system_role_id('owner'), private.invite_token_hash(v_token),
          now() + interval '14 days', v_person, true)
  returning id into v_invite;
  perform private.adopt_standard_library(v_org);
  return query select v_org, v_invite, v_token;
end;
$$;
comment on function app.create_client_organization(uuid, text, text, text, text, text) is 'Partner console (Section 4.6.1): creates a client org under the partner on the given plan, in the country the partner states, with its editable copy of the XOS Standard Library (Section 7.2), and an Owner invite for the client. A country outside the offered territories is refused territory_not_offered, and an exception does not help: only the person it names, signed in, can use it (ADR 0160). A caller who omits the country stated nothing, and the org records none. Partner staff gain no access to the client org. The token is returned once.';
revoke all on function app.create_client_organization(uuid, text, text, text, text, text) from public, anon;
grant execute on function app.create_client_organization(uuid, text, text, text, text, text) to authenticated, service_role;

drop function app.subscribe_external_account(uuid);
create function app.subscribe_external_account(p_account_id uuid, p_country_code text default null)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
  v_recorded text;
  v_exception uuid;
begin
  if p_account_id is null
     or p_account_id not in (select private.my_account_ids(array['Account Owner']::app.account_role[])) then
    raise exception using errcode = '42501', message = 'only the account''s Account Owner subscribes it';
  end if;
  select o.country_code into v_recorded
  from app.organizations o where o.id = p_account_id and o.deleted_at is null for update;
  if exists (select 1 from app.subscriptions s where s.org_id = p_account_id and s.deleted_at is null) then
    perform private.refuse('account_already_subscribed', 'This company already uses Atlas; open it from the organization switcher.');
  end if;
  -- A country on record stays: stating another must not rewrite it, or take the company off the operators' review list.
  if v_recorded is not null and p_country_code is not null and p_country_code <> v_recorded then
    perform private.refuse('organization_country_recorded', 'This company''s country is on record. Ask support to change it.');
  end if;
  v_exception := private.territory_clearance(coalesce(p_country_code, v_recorded), private.my_confirmed_email());
  update app.organizations o set country_code = coalesce(p_country_code, v_recorded) where o.id = p_account_id;
  perform private.use_territory_exception(v_exception, p_account_id);
  perform private.start_trial(p_account_id, private.trial_plan(), private.org_window_end(p_account_id, private.trial_days()),
    'External account started using Atlas: a 14-day Pro trial with no card.');

  perform private.begin_trusted_operation('membership_write');
  with m as (
    insert into app.memberships (org_id, person_id) values (p_account_id, v_person) returning id
  )
  insert into app.membership_roles (membership_id, role_id, granted_by)
  select m.id, private.system_role_id('owner'), null from m;
  perform private.end_trusted_operation('membership_write');
  perform private.adopt_standard_library(p_account_id);
  return p_account_id;
end;
$$;
comment on function app.subscribe_external_account(uuid, text) is 'Journey 60: the Account Owner of an external account starts using Atlas with it, in the country on its record, or the one they state when it has none. Stating a different country from the one on record is refused organization_country_recorded, so the record cannot be rewritten here. A country outside the offered territories is refused territory_not_offered unless an exception names this person''s confirmed email and that country (ADR 0160), and the exception that created a company account is already used. Starts a 14-day Pro trial with no card (Section 14.7), makes the caller the Owner of the same organization row, so its profile, ratings, engagements and counterparty history carry over with no duplicate, and gives it its editable copy of the XOS Standard Library (Section 7.2). Refuses account_already_subscribed (XR001) for an org that already subscribes; anyone but an Account Owner gets 42501.';
revoke all on function app.subscribe_external_account(uuid, text) from public, anon;
grant execute on function app.subscribe_external_account(uuid, text) to authenticated, service_role;

-- A Gateway company account, from 2630 ---------------------------------------------------------------------------------
-- A company account carries no plan or billing, but it is an organization with a public page, started by whoever signs in,
-- so the same gate applies. Working for an organization is untouched: people need no company account to accept an invitation.

drop function app.create_external_account(text, text, text);
create function app.create_external_account(
  p_name text,
  p_slug text,
  p_organization_type text default 'For-Profit',
  p_country_code text default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
  v_exception uuid := private.territory_clearance(p_country_code, private.my_confirmed_email());
  v_account uuid;
  v_membership uuid;
begin
  perform private.assert_org_slug_available(p_slug);
  insert into app.organizations (name, slug, organization_type, country_code)
  values (btrim(p_name), p_slug, p_organization_type, p_country_code)
  returning id into v_account;
  perform private.use_territory_exception(v_exception, v_account);
  insert into app.account_memberships (org_id, person_id, accepted_at) values (v_account, v_person, now()) returning id into v_membership;
  insert into app.account_membership_roles (account_membership_id, account_role, granted_by)
  values (v_membership, 'Account Owner', null);
  return v_account;
end;
$$;
comment on function app.create_external_account(text, text, text, text) is 'Creates an external account (Section 4.4.1): an organization without a subscription, with the signed-in person as its Account Owner, their membership accepted at once (R4), in the country they state. A country outside the offered territories is refused territory_not_offered unless an exception names this person''s confirmed email and that country (ADR 0160). A caller who omits the country stated nothing: the account records none and appears in app.console_orgs_outside_territories. Returns the organization id.';
revoke all on function app.create_external_account(text, text, text, text) from public, anon;
grant execute on function app.create_external_account(text, text, text, text) to authenticated, service_role;

-- The console ------------------------------------------------------------------------------------------------------------

insert into private.platform_operator_permissions (operator_role, permission) values
  ('Administrator', 'territories.write');

create or replace function private.require_territory_reason(p_reason text)
returns void
language plpgsql
stable
set search_path = ''
as $$
begin
  if p_reason is null or char_length(btrim(p_reason)) not between 1 and 500 then
    perform private.refuse('territory_reason', 'Say why, in up to 500 characters.');
  end if;
end;
$$;
comment on function private.require_territory_reason(text) is 'Every territory change and exception carries a reason of 1 to 500 characters (territory_reason).';
revoke all on function private.require_territory_reason(text) from public, anon, authenticated;

create or replace function app.console_list_territories()
returns table (
  code text,
  name_en text,
  name_es text,
  country_codes text[],
  currency_codes text[],
  locale_codes text[],
  offered boolean,
  changed_at timestamptz,
  changed_by_name text,
  change_reason text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_platform_operator('tenants.read');
  return query
  select t.code, t.name_en, t.name_es,
    private.territory_country_list(t.code), private.territory_currency_list(t.code), private.territory_locale_list(t.code),
    t.offered, t.changed_at, p.full_name, t.change_reason
  from private.territories t
  left join app.people p on p.id = t.changed_by
  order by t.offered desc, t.code = 'US' desc, t.code;
end;
$$;
comment on function app.console_list_territories() is 'Every territory, open first, with its countries, currencies, languages and last change (tenants.read).';
revoke all on function app.console_list_territories() from public, anon;
grant execute on function app.console_list_territories() to authenticated;

create or replace function app.console_save_territory(
  p_code text,
  p_name_en text,
  p_name_es text,
  p_country_codes text[],
  p_currency_codes text[],
  p_locale_codes text[],
  p_reason text,
  p_is_new boolean
)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_operator uuid := private.require_platform_operator('territories.write');
  v_code text := upper(btrim(p_code));
  v_before jsonb;
begin
  perform private.require_territory_reason(p_reason);
  if v_code is null or v_code !~ '^[A-Z][A-Z0-9]{1,7}$' then
    perform private.refuse('territory_code', 'Use 2 to 8 capital letters or digits, starting with a letter.');
  end if;
  select to_jsonb(t) || jsonb_build_object('countries', private.territory_country_list(t.code),
           'currencies', private.territory_currency_list(t.code), 'locales', private.territory_locale_list(t.code))
    into v_before
  from private.territories t where t.code = v_code for update;
  -- Saving replaces the lists, so a form that started empty must not reach a territory that holds them: adding names a
  -- free code, and editing names one that exists.
  if v_before is not null and p_is_new is distinct from false then
    perform private.refuse('territory_code_taken', 'A territory already has that code. Edit it from the list.');
  end if;
  if v_before is null and p_is_new is not true then
    perform private.refuse('territory_unknown', 'Choose a territory from the list.');
  end if;
  if p_name_en is null or p_name_es is null
     or char_length(btrim(p_name_en)) not between 1 and 100 or char_length(btrim(p_name_es)) not between 1 and 100 then
    perform private.refuse('territory_name', 'Give the name in English and Spanish, in up to 100 characters each.');
  end if;
  if coalesce(cardinality(p_country_codes), 0) = 0
     or exists (select 1 from unnest(p_country_codes) c where c !~ '^[A-Z]{2}$') then
    perform private.refuse('territory_countries', 'Name at least one country by its two-letter code.');
  end if;
  if exists (select 1 from private.territory_countries c where c.territory_code <> v_code and c.country_code = any (p_country_codes)) then
    perform private.refuse('territory_country_taken', 'A country belongs to one territory. Take it out of the other one first.');
  end if;
  if exists (select 1 from unnest(coalesce(p_currency_codes, '{}')) c
             where not exists (select 1 from private.plan_list_prices lp where lp.currency_code = c)) then
    perform private.refuse('territory_currency_unpriced', 'Choose currencies the price book has.');
  end if;
  if exists (select 1 from unnest(coalesce(p_locale_codes, '{}')) l
             where not exists (select 1 from private.setting_choices sc where sc.setting_key = 'locale.language' and sc.choice = l)) then
    perform private.refuse('territory_locale_unknown', 'Choose languages XOS has.');
  end if;

  if v_before is null then
    insert into private.territories (code, name_en, name_es, changed_at, changed_by, change_reason)
    values (v_code, btrim(p_name_en), btrim(p_name_es), now(), v_operator, btrim(p_reason));
  else
    update private.territories t
    set name_en = btrim(p_name_en), name_es = btrim(p_name_es),
      changed_at = now(), changed_by = v_operator, change_reason = btrim(p_reason)
    where t.code = v_code;
  end if;
  delete from private.territory_countries c where c.territory_code = v_code;
  insert into private.territory_countries (territory_code, country_code)
  select distinct v_code, c from unnest(p_country_codes) c;
  delete from private.territory_currencies c where c.territory_code = v_code;
  insert into private.territory_currencies (territory_code, currency_code, sort_order)
  select v_code, c.code, (c.position * 10)::smallint from unnest(coalesce(p_currency_codes, '{}')) with ordinality as c (code, position);
  delete from private.territory_locales l where l.territory_code = v_code;
  insert into private.territory_locales (territory_code, locale_code)
  select distinct v_code, l from unnest(coalesce(p_locale_codes, '{}')) l;
  perform private.log_operator_action('territory.saved', null, null, null, p_reason,
    jsonb_build_object('code', v_code, 'before', v_before,
      'countries', p_country_codes, 'currencies', coalesce(p_currency_codes, '{}'), 'locales', coalesce(p_locale_codes, '{}')));
  return v_code;
end;
$$;
comment on function app.console_save_territory(text, text, text, text[], text[], text[], text, boolean) is 'An Administrator (territories.write) adds a territory, closed (p_is_new true), or edits one (p_is_new false): its names, countries, currencies and languages, whose lists the save replaces. Adding an existing code is refused territory_code_taken and editing an unknown one territory_unknown, so a form that did not start from the territory cannot wipe its lists. Logged with the row as it was. Opening is a separate step (app.console_set_territory_offered).';
revoke all on function app.console_save_territory(text, text, text, text[], text[], text[], text, boolean) from public, anon;
grant execute on function app.console_save_territory(text, text, text, text[], text[], text[], text, boolean) to authenticated;

create or replace function app.console_price_book_currencies()
returns table (currency_code text)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_platform_operator('tenants.read');
  return query select distinct lp.currency_code::text from private.plan_list_prices lp order by 1;
end;
$$;
comment on function app.console_price_book_currencies() is 'Every currency the price book has, for choosing a territory''s currencies: the same list app.console_save_territory checks, so a currency a territory gave up can still be chosen again (tenants.read).';
revoke all on function app.console_price_book_currencies() from public, anon;
grant execute on function app.console_price_book_currencies() to authenticated;

create or replace function app.console_set_territory_offered(p_code text, p_offered boolean, p_reason text)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_operator uuid := private.require_platform_operator('territories.write');
  v_territory private.territories;
begin
  perform private.require_territory_reason(p_reason);
  select * into v_territory from private.territories t where t.code = p_code for update;
  if v_territory.code is null then
    perform private.refuse('territory_unknown', 'Choose a territory from the list.');
  end if;
  if p_offered is null or v_territory.offered = p_offered then
    perform private.refuse('territory_transition_not_allowed', 'The territory is already in that state.');
  end if;
  if not p_offered and not exists (select 1 from private.territories t where t.offered and t.code <> p_code) then
    perform private.refuse('territory_last_offered', 'XOS must stay offered somewhere. Open another territory first.');
  end if;
  update private.territories t
  set offered = p_offered, changed_at = now(), changed_by = v_operator, change_reason = btrim(p_reason)
  where t.code = p_code;
  perform private.log_operator_action(case when p_offered then 'territory.opened' else 'territory.closed' end,
    null, null, null, p_reason, jsonb_build_object('code', p_code));
  return p_code;
end;
$$;
comment on function app.console_set_territory_offered(text, boolean, text) is 'An Administrator (territories.write) opens or closes a territory, with a reason, on the console ledger. Signup follows at once, and prices and languages usually within a minute and at most about 11 minutes, as each server''s read of the offering catches up (ADR 0160), with no code change. Refuses territory_transition_not_allowed when it is already in that state and territory_last_offered for the last open territory. Closing touches no existing organization.';
revoke all on function app.console_set_territory_offered(text, boolean, text) from public, anon;
grant execute on function app.console_set_territory_offered(text, boolean, text) to authenticated;

create or replace function app.console_list_territory_exceptions()
returns table (
  id uuid,
  owner_email text,
  country_code text,
  contract_reference text,
  contract_signed_on date,
  reason text,
  granted_by_name text,
  granted_at timestamptz,
  org_id uuid,
  org_name text,
  used_at timestamptz,
  revoked_at timestamptz,
  revoke_reason text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_platform_operator('tenants.read');
  return query
  select e.id, e.owner_email, e.country_code, e.contract_reference, e.contract_signed_on, e.reason, p.full_name, e.granted_at,
         e.org_id, o.name, e.used_at, e.revoked_at, e.revoke_reason
  from private.territory_exceptions e
  left join app.people p on p.id = e.granted_by
  left join app.organizations o on o.id = e.org_id
  order by e.granted_at desc;
end;
$$;
comment on function app.console_list_territory_exceptions() is 'Every recorded territory exception, newest first, with the contract and what became of it (tenants.read).';
revoke all on function app.console_list_territory_exceptions() from public, anon;
grant execute on function app.console_list_territory_exceptions() to authenticated;

create or replace function app.console_grant_territory_exception(
  p_owner_email text,
  p_country_code text,
  p_contract_reference text,
  p_contract_signed_on date,
  p_reason text
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_operator uuid := private.require_platform_operator('territories.write');
  v_email text := lower(btrim(p_owner_email));
  v_id uuid;
begin
  perform private.require_territory_reason(p_reason);
  if v_email is null or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+$' or char_length(v_email) > 320 then
    perform private.refuse('territory_exception_email', 'Enter the email of the organization''s first Owner.');
  end if;
  if p_country_code is null or p_country_code !~ '^[A-Z]{2}$' then
    perform private.refuse('organization_country_invalid', 'Choose the country the organization is established in.');
  end if;
  if private.country_offered(p_country_code) then
    perform private.refuse('territory_exception_not_needed', 'XOS is already offered in that country.');
  end if;
  if p_contract_reference is null or char_length(btrim(p_contract_reference)) not between 1 and 200 then
    perform private.refuse('territory_exception_contract', 'Name the signed contract, in up to 200 characters.');
  end if;
  if p_contract_signed_on is null or p_contract_signed_on > (now() at time zone 'utc')::date + 1 then
    perform private.refuse('territory_exception_signed_on', 'An exception needs a contract that is already signed: enter its date.');
  end if;
  if exists (select 1 from private.territory_exceptions e
             where e.owner_email = v_email and e.country_code = p_country_code and e.used_at is null and e.revoked_at is null) then
    perform private.refuse('territory_exception_open', 'An open exception already names this person and country.');
  end if;
  insert into private.territory_exceptions (owner_email, country_code, contract_reference, contract_signed_on, reason, granted_by)
  values (v_email, p_country_code, btrim(p_contract_reference), p_contract_signed_on, btrim(p_reason), v_operator)
  returning id into v_id;
  perform private.log_operator_action('territory_exception.granted', null, 'private.territory_exceptions', v_id, p_reason,
    jsonb_build_object('country_code', p_country_code, 'contract_reference', btrim(p_contract_reference), 'contract_signed_on', p_contract_signed_on));
  return v_id;
end;
$$;
comment on function app.console_grant_territory_exception(text, text, text, date, text) is 'An Administrator (territories.write) records an exception for a signed contract: one organization, started by this email, in this country, used once. The contract date may not be in the future (the day after today in UTC is allowed, for a contract signed where it is already tomorrow). It does not open the territory and appoints no representative.';
revoke all on function app.console_grant_territory_exception(text, text, text, date, text) from public, anon;
grant execute on function app.console_grant_territory_exception(text, text, text, date, text) to authenticated;

create or replace function app.console_revoke_territory_exception(p_id uuid, p_reason text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_operator uuid := private.require_platform_operator('territories.write');
  v_exception private.territory_exceptions;
begin
  perform private.require_territory_reason(p_reason);
  select * into v_exception from private.territory_exceptions e where e.id = p_id for update;
  if v_exception.id is null then
    perform private.refuse('territory_exception_unknown', 'Choose an exception from the list.');
  end if;
  if v_exception.used_at is not null or v_exception.revoked_at is not null then
    perform private.refuse('territory_exception_transition_not_allowed', 'Only an open exception can be withdrawn.');
  end if;
  update private.territory_exceptions e
  set revoked_at = now(), revoked_by = v_operator, revoke_reason = btrim(p_reason)
  where e.id = p_id;
  perform private.log_operator_action('territory_exception.revoked', null, 'private.territory_exceptions', p_id, p_reason, '{}'::jsonb);
  return p_id;
end;
$$;
comment on function app.console_revoke_territory_exception(uuid, text) is 'An Administrator (territories.write) withdraws an open exception, with a reason. Refuses territory_exception_transition_not_allowed once it is used or withdrawn.';
revoke all on function app.console_revoke_territory_exception(uuid, text) from public, anon;
grant execute on function app.console_revoke_territory_exception(uuid, text) to authenticated;

create or replace function app.console_orgs_outside_territories()
returns table (id uuid, name text, slug text, country_code text, uses_atlas boolean, exception_contract text)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_platform_operator('tenants.read');
  return query
  select o.id, o.name, o.slug, o.country_code,
    exists (select 1 from app.subscriptions s where s.org_id = o.id and s.deleted_at is null),
    (select e.contract_reference from private.territory_exceptions e where e.org_id = o.id order by e.used_at desc limit 1)
  from app.organizations o
  where o.deleted_at is null
    and (exists (select 1 from app.subscriptions s where s.org_id = o.id and s.deleted_at is null)
      or exists (select 1 from app.account_memberships m
        join app.account_membership_roles r on r.account_membership_id = m.id and r.deleted_at is null
        where m.org_id = o.id and m.deleted_at is null and r.account_role = 'Account Owner'))
    and not exists (select 1 from app.sandbox_orgs sb where sb.org_id = o.id)
    and not private.country_offered(o.country_code)
  order by o.name;
end;
$$;
comment on function app.console_orgs_outside_territories() is 'Organizations using Atlas and Gateway company accounts whose stated country is outside the offered territories, or who stated none, with the contract of an exception when one let them in (tenants.read). A company account is one with an Account Owner: a customer''s counterparty is not one of them, whether nobody belongs to it or only the Account Members its roster invitations added (private.ensure_accepted_membership). The list a person reviews; nothing acts on it.';
revoke all on function app.console_orgs_outside_territories() from public, anon;
grant execute on function app.console_orgs_outside_territories() to authenticated;

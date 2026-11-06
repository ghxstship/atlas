-- 6150_offered_territories.sql
-- Launch offers XOS in the United States only (ADR 0160, legal review issue 3). GDPR Recital 23 names currency and
-- language as signs of an intent to offer, so a closed territory's prices and languages stay switched off, and no
-- organization starts outside an offered territory, without deleting anything that opens the territory later.
--   * private.territories is the one source of truth: each territory's countries, price book currencies and languages,
--     and whether it is offered. Only the United States is, by default. An operator opens or closes one in the console;
--     no code changes. Every change lands in app.platform_operator_actions with the operator and the reason.
--   * app.organizations.country_code records the country the organization's creator states. Nothing asks a person's
--     location and nothing reads an IP address: being invited to work for an organization is not being offered XOS, so
--     invitations and every signed-in surface stay as they are.
--   * private.territory_exceptions lets an operator allow one organization outside an offered territory, on the record
--     of a signed contract. It is for one owner email and one country, and it is used once.
--   * app.create_organization, app.create_client_organization and app.subscribe_external_account, the three ways an
--     organization starts using Atlas, gain a country and refuse territory_not_offered. Gateway's company accounts carry
--     no plan and are not gated here; one that starts Atlas is, through app.subscribe_external_account.
--   * API v1 stays additive: p_country_code is optional and defaults to US, documented as the caller's statement.
--     Existing organizations keep working with no recorded country; console_orgs_outside_territories lists them.
-- Recreated from their latest definitions in 1612: app.create_organization, app.create_client_organization,
-- app.subscribe_external_account.

-- The organization's country -------------------------------------------------------------------------------------------

alter table app.organizations add column country_code text;
alter table app.organizations add constraint organizations_country_code_format
  check (country_code is null or country_code ~ '^[A-Z]{2}$');
comment on column app.organizations.country_code is 'ISO 3166-1 alpha-2 country the organization''s creator stated at signup, which decides whether XOS is offered to it (private.territories). Null for an organization from before the question, a Gateway company account that does not use Atlas, a counterparty or a sandbox. Not a person''s location, and never read from an IP address.';

-- Territories ----------------------------------------------------------------------------------------------------------

create table private.territories (
  code text primary key,
  name_en text not null,
  name_es text not null,
  country_codes text[] not null,
  currency_codes text[] not null default '{}',
  locale_codes text[] not null default '{}',
  offered boolean not null default false,
  changed_at timestamptz not null default now(),
  changed_by uuid references app.people (id),
  change_reason text not null,
  constraint territories_code_format check (code ~ '^[A-Z][A-Z0-9]{1,7}$'),
  constraint territories_name_en_length check (char_length(btrim(name_en)) between 1 and 100),
  constraint territories_name_es_length check (char_length(btrim(name_es)) between 1 and 100),
  constraint territories_has_countries check (cardinality(country_codes) > 0),
  constraint territories_reason_length check (char_length(btrim(change_reason)) between 1 and 500)
);
create index territories_changed_by_idx on private.territories (changed_by);

comment on table private.territories is 'The one source of truth for where XOS is offered (ADR 0160): each territory''s countries, the price book currencies and languages that open with it, and whether it is offered. Closed territories keep their row, so opening one needs no code. Written only by the console RPCs, which log every change to app.platform_operator_actions. Read through api_public.offered_territories.';
comment on column private.territories.code is 'Territory code: an ISO country code for a single country, or a short name such as EEA.';
comment on column private.territories.name_en is 'Name in English, as it reads in "XOS is offered to organizations in ...".';
comment on column private.territories.name_es is 'Name in Spanish, for the same sentence.';
comment on column private.territories.country_codes is 'ISO 3166-1 alpha-2 countries in the territory. A country belongs to one territory.';
comment on column private.territories.currency_codes is 'Price book currencies that open with the territory; the first is what its organizations pay in. Empty means USD.';
comment on column private.territories.locale_codes is 'Languages (locale.language choices) that open with the territory.';
comment on column private.territories.offered is 'Whether XOS is offered there now.';
comment on column private.territories.changed_at is 'When the territory last opened, closed or was edited.';
comment on column private.territories.changed_by is 'Operator who made the last change; null for the launch seed.';
comment on column private.territories.change_reason is 'Why, in the operator''s words.';

alter table private.territories enable row level security;
revoke all on private.territories from public, anon, authenticated;
grant select on private.territories to service_role;

insert into private.territories (code, name_en, name_es, country_codes, currency_codes, locale_codes, offered, change_reason) values
  ('US', 'the United States', 'los Estados Unidos', array['US', 'PR', 'VI', 'GU', 'AS', 'MP'], array['USD'], array['en-US', 'es-US'], true,
    'Launch offers XOS in the United States only (ADR 0160).'),
  ('EEA', 'the European Economic Area', 'el Espacio Económico Europeo',
    array['AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE', 'IS', 'LI', 'NO'],
    array['EUR'], array['fr-FR', 'de-DE', 'it-IT'], false, 'Closed at launch: no representative is appointed (ADR 0160).'),
  ('GB', 'the United Kingdom', 'el Reino Unido', array['GB'], array['GBP'], '{}', false, 'Closed at launch: no representative is appointed (ADR 0160).'),
  ('CH', 'Switzerland', 'Suiza', array['CH'], '{}', array['fr-FR', 'de-DE', 'it-IT'], false, 'Closed at launch (ADR 0160).'),
  ('CA', 'Canada', 'Canadá', array['CA'], array['CAD'], array['fr-FR'], false, 'Closed at launch (ADR 0160).'),
  ('AU', 'Australia', 'Australia', array['AU'], array['AUD'], '{}', false, 'Closed at launch (ADR 0160).'),
  ('BR', 'Brazil', 'Brasil', array['BR'], '{}', array['pt-BR'], false, 'Closed at launch (ADR 0160).'),
  ('JP', 'Japan', 'Japón', array['JP'], '{}', array['ja-JP'], false, 'Closed at launch (ADR 0160).');

create or replace function api_public.offered_territories()
returns table (code text, name_en text, name_es text, country_codes text[], currency_codes text[], locale_codes text[])
language sql
stable
security definer
set search_path = ''
as $$
  select t.code, t.name_en, t.name_es, t.country_codes, t.currency_codes, t.locale_codes
  from private.territories t
  where t.offered
  order by t.code = 'US' desc, t.code;
$$;
comment on function api_public.offered_territories() is 'The territories XOS is offered in now, with their countries, currencies and languages (ADR 0160). Public configuration: signed-out pages choose their languages from it. A reader that cannot reach it falls back to the United States alone (@xos/data/territories).';
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
    (select t.currency_codes[1]
     from app.organizations o
     join private.territories t on t.offered and o.country_code = any (t.country_codes)
     where o.id = p_org_id),
    'USD');
end;
$$;
comment on function app.org_checkout_currency(uuid) is 'The currency Stripe Checkout opens in for the org: the first currency of the offered territory holding its stated country, else USD. Checkout always names it, so Stripe never picks a currency from where the buyer seems to be (ADR 0160).';
revoke all on function app.org_checkout_currency(uuid) from public, anon;
grant execute on function app.org_checkout_currency(uuid) to authenticated, service_role;

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

comment on table private.territory_exceptions is 'A recorded exception that allows one organization outside an offered territory, for a signed contract (ADR 0160). An operator names the first Owner''s email, the country and the contract; the org that person starts uses it once. Revoked once, never edited. Written only by the console RPCs and the org creation RPCs.';
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

-- The check the three org creation paths make ----------------------------------------------------------------------------

create or replace function private.territory_clearance(p_country text, p_owner_email text)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_exception uuid;
begin
  if p_country is null or p_country !~ '^[A-Z]{2}$' then
    perform private.refuse('organization_country_invalid', 'Choose the country the organization is established in.');
  end if;
  if exists (select 1 from private.territories t where t.offered and p_country = any (t.country_codes)) then
    return null;
  end if;
  select e.id into v_exception
  from private.territory_exceptions e
  where e.owner_email = lower(btrim(p_owner_email)) and e.country_code = p_country
    and e.used_at is null and e.revoked_at is null;
  if v_exception is null then
    perform private.refuse('territory_not_offered', 'XOS is not offered to organizations in this country.');
  end if;
  return v_exception;
end;
$$;
comment on function private.territory_clearance(text, text) is 'Whether an organization may start in a country: null when the country is in an offered territory, the id of the open exception naming this owner and country, or a refusal (territory_not_offered, organization_country_invalid). The caller marks an exception used once the org exists.';
revoke all on function private.territory_clearance(text, text) from public, anon, authenticated;

create or replace function private.use_territory_exception(p_exception uuid, p_org uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if p_exception is not null then
    update private.territory_exceptions e set org_id = p_org, used_at = now()
    where e.id = p_exception and e.used_at is null and e.revoked_at is null;
  end if;
end;
$$;
comment on function private.use_territory_exception(uuid, uuid) is 'Marks an exception used by the org created under it, so it allows one organization. A no-op without an exception.';
revoke all on function private.use_territory_exception(uuid, uuid) from public, anon, authenticated;

create or replace function private.my_confirmed_email()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select lower(u.email) from auth.users u where u.id = (select auth.uid()) and u.email_confirmed_at is not null;
$$;
comment on function private.my_confirmed_email() is 'The signed-in person''s email once confirmed, in lower case; an exception only ever matches an address the person proved they hold.';
revoke all on function private.my_confirmed_email() from public, anon, authenticated;

-- Org creation, from 1612 ------------------------------------------------------------------------------------------------

drop function app.create_organization(text, text);
create function app.create_organization(p_name text, p_slug text, p_country_code text default 'US')
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
comment on function app.create_organization(text, text, text) is 'Creates an organization with the signed-in person as its Owner, in one transaction, in the country they state; omitted, the caller states the United States. A country outside the offered territories is refused territory_not_offered unless an exception names this person and country (ADR 0160). It starts a 14-day Pro trial with no card and moves to the Access plan when the trial ends unless a card is added (Section 14.7), and receives its editable copy of the XOS Standard Library (Section 7.2). Returns the org id.';
revoke all on function app.create_organization(text, text, text) from public, anon;
grant execute on function app.create_organization(text, text, text) to authenticated, service_role;

drop function app.create_client_organization(uuid, text, text, text, text);
create function app.create_client_organization(
  p_partner_org_id uuid,
  p_name text,
  p_slug text,
  p_owner_email text,
  p_plan_code text default 'access',
  p_country_code text default 'US'
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
  v_exception uuid;
begin
  if not private.has_capability(p_partner_org_id, 'org.partner.manage') then
    raise exception using errcode = '42501', message = 'org.partner.manage is required in the partner org';
  end if;
  v_exception := private.territory_clearance(p_country_code, p_owner_email);
  perform private.assert_org_slug_available(p_slug);
  insert into app.organizations (name, slug, parent_org_id, country_code)
  values (btrim(p_name), p_slug, p_partner_org_id, p_country_code)
  returning id into v_org;
  perform private.use_territory_exception(v_exception, v_org);
  perform private.create_subscription(v_org, p_plan_code);
  insert into app.invites (org_id, email, role_id, token_hash, expires_at, invited_by, partner_bootstrap)
  values (v_org, lower(btrim(p_owner_email)), private.system_role_id('owner'), private.invite_token_hash(v_token),
          now() + interval '14 days', v_person, true)
  returning id into v_invite;
  perform private.adopt_standard_library(v_org);
  return query select v_org, v_invite, v_token;
end;
$$;
comment on function app.create_client_organization(uuid, text, text, text, text, text) is 'Partner console (Section 4.6.1): creates a client org under the partner on the given plan, in the country the partner states (omitted, the United States), with its editable copy of the XOS Standard Library (Section 7.2), and an Owner invite for the client. A country outside the offered territories is refused territory_not_offered unless an exception names the client''s Owner and country (ADR 0160). Partner staff gain no access to the client org. The token is returned once.';
revoke all on function app.create_client_organization(uuid, text, text, text, text, text) from public, anon;
grant execute on function app.create_client_organization(uuid, text, text, text, text, text) to authenticated, service_role;

drop function app.subscribe_external_account(uuid);
create function app.subscribe_external_account(p_account_id uuid, p_country_code text default 'US')
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
  v_exception uuid;
begin
  if p_account_id is null
     or p_account_id not in (select private.my_account_ids(array['Account Owner']::app.account_role[])) then
    raise exception using errcode = '42501', message = 'only the account''s Account Owner subscribes it';
  end if;
  perform 1 from app.organizations o where o.id = p_account_id and o.deleted_at is null for update;
  if exists (select 1 from app.subscriptions s where s.org_id = p_account_id and s.deleted_at is null) then
    perform private.refuse('account_already_subscribed', 'This company already uses Atlas; open it from the organization switcher.');
  end if;
  v_exception := private.territory_clearance(p_country_code, private.my_confirmed_email());
  update app.organizations o set country_code = p_country_code where o.id = p_account_id;
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
comment on function app.subscribe_external_account(uuid, text) is 'Journey 60: the Account Owner of an external account starts using Atlas with it, in the country they state (omitted, the United States); a country outside the offered territories is refused territory_not_offered unless an exception names this person and country (ADR 0160). Starts a 14-day Pro trial with no card (Section 14.7), makes the caller the Owner of the same organization row, so its profile, ratings, engagements and counterparty history carry over with no duplicate, and gives it its editable copy of the XOS Standard Library (Section 7.2). Refuses account_already_subscribed (XR001) for an org that already subscribes; anyone but an Account Owner gets 42501.';
revoke all on function app.subscribe_external_account(uuid, text) from public, anon;
grant execute on function app.subscribe_external_account(uuid, text) to authenticated, service_role;

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
  select t.code, t.name_en, t.name_es, t.country_codes, t.currency_codes, t.locale_codes, t.offered, t.changed_at, p.full_name, t.change_reason
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
  p_reason text
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
  v_before private.territories;
begin
  perform private.require_territory_reason(p_reason);
  if v_code is null or v_code !~ '^[A-Z][A-Z0-9]{1,7}$' then
    perform private.refuse('territory_code', 'Use 2 to 8 capital letters or digits, starting with a letter.');
  end if;
  if p_name_en is null or p_name_es is null
     or char_length(btrim(p_name_en)) not between 1 and 100 or char_length(btrim(p_name_es)) not between 1 and 100 then
    perform private.refuse('territory_name', 'Give the name in English and Spanish, in up to 100 characters each.');
  end if;
  if coalesce(cardinality(p_country_codes), 0) = 0
     or exists (select 1 from unnest(p_country_codes) c where c !~ '^[A-Z]{2}$') then
    perform private.refuse('territory_countries', 'Name at least one country by its two-letter code.');
  end if;
  if exists (select 1 from private.territories t where t.code <> v_code and t.country_codes && p_country_codes) then
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

  select * into v_before from private.territories t where t.code = v_code for update;
  insert into private.territories as t (code, name_en, name_es, country_codes, currency_codes, locale_codes, changed_at, changed_by, change_reason)
  values (v_code, btrim(p_name_en), btrim(p_name_es), p_country_codes, coalesce(p_currency_codes, '{}'), coalesce(p_locale_codes, '{}'),
          now(), v_operator, btrim(p_reason))
  on conflict (code) do update set
    name_en = excluded.name_en, name_es = excluded.name_es, country_codes = excluded.country_codes,
    currency_codes = excluded.currency_codes, locale_codes = excluded.locale_codes,
    changed_at = excluded.changed_at, changed_by = excluded.changed_by, change_reason = excluded.change_reason;
  perform private.log_operator_action('territory.saved', null, null, null, p_reason,
    jsonb_build_object('code', v_code, 'before', case when v_before.code is null then null else to_jsonb(v_before) end,
      'countries', p_country_codes, 'currencies', coalesce(p_currency_codes, '{}'), 'locales', coalesce(p_locale_codes, '{}')));
  return v_code;
end;
$$;
comment on function app.console_save_territory(text, text, text, text[], text[], text[], text) is 'An Administrator (territories.write) adds a territory, closed, or edits one: its names, countries, currencies and languages. Logged with the row as it was. Opening is a separate step (app.console_set_territory_offered).';
revoke all on function app.console_save_territory(text, text, text, text[], text[], text[], text) from public, anon;
grant execute on function app.console_save_territory(text, text, text, text[], text[], text[], text) to authenticated;

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
comment on function app.console_set_territory_offered(text, boolean, text) is 'An Administrator (territories.write) opens or closes a territory, with a reason, on the console ledger. Its prices, languages and signup follow within a minute, with no code change. Refuses territory_transition_not_allowed when it is already in that state and territory_last_offered for the last open territory. Closing touches no existing organization.';
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
  if exists (select 1 from private.territories t where t.offered and p_country_code = any (t.country_codes)) then
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
returns table (id uuid, name text, slug text, country_code text, exception_contract text)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_platform_operator('tenants.read');
  return query
  select o.id, o.name, o.slug, o.country_code,
    (select e.contract_reference from private.territory_exceptions e where e.org_id = o.id order by e.used_at desc limit 1)
  from app.organizations o
  where o.deleted_at is null
    and exists (select 1 from app.subscriptions s where s.org_id = o.id and s.deleted_at is null)
    and not exists (select 1 from app.sandbox_orgs sb where sb.org_id = o.id)
    and not exists (select 1 from private.territories t where t.offered and o.country_code = any (t.country_codes))
  order by o.name;
end;
$$;
comment on function app.console_orgs_outside_territories() is 'Organizations using Atlas whose stated country is outside the offered territories or was never recorded, with the contract of an exception when one let them in (tenants.read). The list a person reviews; nothing acts on it.';
revoke all on function app.console_orgs_outside_territories() from public, anon;
grant execute on function app.console_orgs_outside_territories() to authenticated;

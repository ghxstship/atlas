-- 1060_partner_console.sql
-- A36 Partner console (Section 4.6.1, Section 8 support sessions, Section 12 white label, Section 16):
--   * partner_agreements: the wholesale terms the platform records for a partner (service role only)
--   * plan_list_prices: monthly list prices per plan and currency, mirrored from packages/schemas/plans.yaml
--     (a test in apps/atlas keeps the two identical, the ADR 0026 mirrored-source pattern)
--   * partner_default_brands: the brand client orgs inherit, and whether a client may override it;
--     private.public_brand resolves the inherited brand
--   * partner_client_prices: what the partner charges each client (the partner bills through Stripe Connect)
--   * wholesale_statements and their lines: one statement per partner and month, priced in the database
--   * support_sessions: a client Owner lets the partner's staff read the client org for at most 24 hours,
--     through org-level record grants of the read capabilities, linked in support_session_grants; every
--     grant and its end land in the client's audit ledger
--   * partner_client_orgs and partner_client_usage: billing facts and usage totals only, never client data

-- Wholesale terms -----------------------------------------------------------------------------------------

create table app.partner_agreements (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  wholesale_discount_bps integer not null,
  currency_code char(3) not null references private.currencies (currency_code),
  signed_on date not null,
  constraint partner_agreements_discount_range check (wholesale_discount_bps between 0 and 9000)
);

create index partner_agreements_currency_code_idx on app.partner_agreements (currency_code);

call private.install_domain_table('app.partner_agreements');
create unique index partner_agreements_one_per_org on app.partner_agreements (org_id) where deleted_at is null;
call private.describe('app.partner_agreements', 'Wholesale terms of a partner org (Section 4.6.1): the platform bills the partner at list price less the discount. Recorded by the platform with the service role; partners read their own.', array[
  'wholesale_discount_bps', 'Discount off list price in basis points (2000 is 20 percent).',
  'currency_code', 'Currency the partner is billed in.',
  'signed_on', 'Date the partner agreement was signed.'
]);

call private.install_policies('app.partner_agreements',
  $$org_id in (select private.orgs_with_capability('org.partner.manage'))$$);
call private.install_audit_trail('app.partner_agreements');

create table private.plan_list_prices (
  plan_code text not null references app.plans (code),
  currency_code char(3) not null references private.currencies (currency_code),
  monthly_minor bigint,
  primary key (plan_code, currency_code),
  constraint plan_list_prices_nonnegative check (monthly_minor is null or monthly_minor >= 0)
);

create index plan_list_prices_currency_code_idx on private.plan_list_prices (currency_code);

comment on table private.plan_list_prices is 'Monthly list price of each plan per currency, mirrored from packages/schemas/plans.yaml (its single source); apps/atlas/test/a36-plan-prices.test.ts fails when they differ. Null is unpriced, never zero.';
comment on column private.plan_list_prices.plan_code is 'Plan.';
comment on column private.plan_list_prices.currency_code is 'Price book currency.';
comment on column private.plan_list_prices.monthly_minor is 'Monthly list price in minor units, or null while the currency is unpriced.';

alter table private.plan_list_prices enable row level security;
revoke all on private.plan_list_prices from public, anon, authenticated;
grant select on private.plan_list_prices to service_role;

insert into private.plan_list_prices (plan_code, currency_code, monthly_minor) values
  ('access', 'USD', 0), ('access', 'EUR', 0), ('access', 'GBP', 0), ('access', 'CAD', 0), ('access', 'AUD', 0),
  ('core', 'USD', 4900), ('core', 'EUR', null), ('core', 'GBP', null), ('core', 'CAD', null), ('core', 'AUD', null),
  ('pro', 'USD', 7900), ('pro', 'EUR', null), ('pro', 'GBP', null), ('pro', 'CAD', null), ('pro', 'AUD', null),
  ('team', 'USD', 34900), ('team', 'EUR', null), ('team', 'GBP', null), ('team', 'CAD', null), ('team', 'AUD', null),
  ('enterprise', 'USD', 89900), ('enterprise', 'EUR', null), ('enterprise', 'GBP', null), ('enterprise', 'CAD', null), ('enterprise', 'AUD', null);

-- Partner orgs ------------------------------------------------------------------------------------------

create or replace function private.is_partner_capable(p_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from app.organizations o where o.id = p_org_id and o.parent_org_id is null and o.deleted_at is null);
$$;

comment on function private.is_partner_capable(uuid) is 'True when the org may act as a partner: it exists and is not itself a client org (three levels at most, Section 4.6.1).';
revoke all on function private.is_partner_capable(uuid) from public, anon, authenticated;

create or replace function private.is_client_of(p_client_org_id uuid, p_partner_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from app.organizations o
                 where o.id = p_client_org_id and o.parent_org_id = p_partner_org_id and o.deleted_at is null);
$$;

comment on function private.is_client_of(uuid, uuid) is 'True when the first org is a live client org of the second. Takes both ids as arguments (ADR 0016 rule 14).';
revoke all on function private.is_client_of(uuid, uuid) from public, anon, authenticated;

-- Default brand ------------------------------------------------------------------------------------------

create table app.partner_default_brands (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  accent_hex text,
  neutral_tint_hex text,
  font_family text references private.brand_fonts (font_family),
  radius_scale app.brand_radius_scale not null default 'Default',
  email_sender_name text,
  support_email text,
  allow_client_override boolean not null default true,
  constraint partner_default_brands_accent check (accent_hex is null or accent_hex ~ '^#[0-9A-F]{6}$'),
  constraint partner_default_brands_neutral_tint check (neutral_tint_hex is null or neutral_tint_hex ~ '^#[0-9A-F]{6}$'),
  constraint partner_default_brands_sender check (email_sender_name is null or char_length(btrim(email_sender_name)) between 1 and 100),
  constraint partner_default_brands_support_email check (support_email is null or (support_email = lower(support_email) and support_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'))
);

create index partner_default_brands_font_family_idx on app.partner_default_brands (font_family);

call private.install_domain_table('app.partner_default_brands');
create unique index partner_default_brands_one_per_org on app.partner_default_brands (org_id) where deleted_at is null;
call private.describe('app.partner_default_brands', 'The brand a partner''s client orgs inherit (Section 4.6.1, Section 12). Token-based like every brand: the editor blocks accents that fail WCAG 2.2 AA before saving.', array[
  'accent_hex', 'Accent color as uppercase #RRGGBB, inherited by clients; NULL keeps the platform accent.',
  'neutral_tint_hex', 'Optional neutral tint as uppercase #RRGGBB.',
  'font_family', 'Optional font family from the approved list.',
  'radius_scale', 'Corner radius scale.',
  'email_sender_name', 'Sender name on emails sent for client orgs that do not set their own.',
  'support_email', 'Support address shown on client surfaces that do not set their own.',
  'allow_client_override', 'True lets a client''s own brand values win over these; false keeps the partner''s values wherever the partner sets one.'
]);

create or replace function private.guard_partner_default_brand()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.is_partner_capable(new.org_id) then
    perform private.refuse('partner_is_client', 'A client org cannot have clients of its own, so it sets no default client brand.');
  end if;
  return new;
end;
$$;

comment on function private.guard_partner_default_brand() is 'Only an org that is not itself a client org sets a default client brand (Section 4.6.1).';
revoke all on function private.guard_partner_default_brand() from public, anon, authenticated;

create trigger t40_guard_partner_default_brand before insert or update on app.partner_default_brands
  for each row execute function private.guard_partner_default_brand();

call private.install_policies('app.partner_default_brands',
  $$org_id in (select private.orgs_with_capability('org.partner.manage'))$$,
  $$org_id in (select private.orgs_with_capability('org.partner.manage'))$$);
call private.install_audit_trail('app.partner_default_brands');

-- The public brand now resolves the partner's default brand for client orgs.
create or replace function private.public_brand(p_org_id uuid)
returns table (
  org_slug text,
  name text,
  logo_light_path text,
  logo_dark_path text,
  favicon_path text,
  app_icon_path text,
  accent_hex text,
  neutral_tint_hex text,
  font_family text,
  radius_scale app.brand_radius_scale,
  suppress_powered_by boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select o.slug,
    coalesce(b.display_name, o.name),
    b.logo_light_path, b.logo_dark_path, b.favicon_path, b.app_icon_path,
    case when d.id is null then b.accent_hex
         when d.allow_client_override then coalesce(b.accent_hex, d.accent_hex)
         else coalesce(d.accent_hex, b.accent_hex) end,
    case when d.id is null then b.neutral_tint_hex
         when d.allow_client_override then coalesce(b.neutral_tint_hex, d.neutral_tint_hex)
         else coalesce(d.neutral_tint_hex, b.neutral_tint_hex) end,
    case when d.id is null then b.font_family
         when d.allow_client_override then coalesce(b.font_family, d.font_family)
         else coalesce(d.font_family, b.font_family) end,
    case when d.id is null or (d.allow_client_override and b.id is not null) then coalesce(b.radius_scale, 'Default')
         else d.radius_scale end,
    coalesce(b.suppress_powered_by, false) and private.org_has_feature(o.id, 'white_label')
  from app.organizations o
  left join app.org_brands b on b.org_id = o.id and b.deleted_at is null
  left join app.partner_default_brands d on d.org_id = o.parent_org_id and d.deleted_at is null
  where o.id = p_org_id and o.deleted_at is null;
$$;

comment on function private.public_brand(uuid) is 'The public half of an org''s brand. A client org inherits its partner''s default brand: its own values win where the partner allows overrides, the partner''s win otherwise (Section 4.6.1). "Powered by XOS" stays shown unless the plan includes white label now, so a downgrade reverts it.';
revoke all on function private.public_brand(uuid) from public, anon, authenticated;

create or replace function app.effective_brand(p_org_id uuid)
returns table (
  accent_hex text,
  neutral_tint_hex text,
  font_family text,
  radius_scale app.brand_radius_scale,
  inherited boolean,
  override_allowed boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select b.accent_hex, b.neutral_tint_hex, b.font_family, b.radius_scale,
    d.id is not null, coalesce(d.allow_client_override, true)
  from app.organizations o
  cross join lateral private.public_brand(o.id) b
  left join app.partner_default_brands d on d.org_id = o.parent_org_id and d.deleted_at is null
  where o.id = p_org_id
    and (o.id in (select private.my_org_ids())
         or o.parent_org_id in (select private.orgs_with_capability('org.partner.manage')));
$$;

comment on function app.effective_brand(uuid) is 'The brand an org renders with after partner inheritance, and whether it is inherited: for members of the org and for the partner''s staff with org.partner.manage.';
revoke all on function app.effective_brand(uuid) from public, anon;
grant execute on function app.effective_brand(uuid) to authenticated, service_role;

-- Client prices ------------------------------------------------------------------------------------------

create table app.partner_client_prices (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  client_org_id uuid not null references app.organizations (id),
  monthly_minor bigint not null,
  currency_code char(3) not null references private.currencies (currency_code),
  constraint partner_client_prices_nonnegative check (monthly_minor >= 0),
  constraint partner_client_prices_not_self check (client_org_id <> org_id)
);

create index partner_client_prices_client_org_id_idx on app.partner_client_prices (client_org_id);
create index partner_client_prices_currency_code_idx on app.partner_client_prices (currency_code);

call private.install_domain_table('app.partner_client_prices');
create unique index partner_client_prices_one_per_client on app.partner_client_prices (org_id, client_org_id) where deleted_at is null;
call private.describe('app.partner_client_prices', 'What a partner charges a client org each month (Section 4.6.1: the partner bills its clients through Stripe Connect at prices it sets). Read and written by the partner only; the client never sees the partner''s margin.', array[
  'client_org_id', 'Client org the price is for; a client of org_id.',
  'monthly_minor', 'Monthly price in minor units of currency_code.',
  'currency_code', 'ISO 4217 currency of the price.'
]);

create or replace function private.guard_partner_client_price()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and new.client_org_id <> old.client_org_id then
    perform private.refuse('partner_price_client_immutable', 'A price stays with its client; set a price for the other client instead.');
  end if;
  if not private.is_client_of(new.client_org_id, new.org_id) then
    perform private.refuse('partner_client_unknown', 'The org is not a client of this partner.');
  end if;
  return new;
end;
$$;

comment on function private.guard_partner_client_price() is 'A partner prices only its own client orgs, and a price never moves to another client.';
revoke all on function private.guard_partner_client_price() from public, anon, authenticated;

create trigger t40_guard_partner_client_price before insert or update on app.partner_client_prices
  for each row execute function private.guard_partner_client_price();

call private.install_policies('app.partner_client_prices',
  $$org_id in (select private.orgs_with_capability('org.partner.manage'))$$,
  $$org_id in (select private.orgs_with_capability('org.partner.manage'))$$);
call private.install_audit_trail('app.partner_client_prices');

-- Wholesale statements ------------------------------------------------------------------------------------

create table app.wholesale_statements (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  period_start date not null,
  currency_code char(3) not null references private.currencies (currency_code),
  wholesale_discount_bps integer not null,
  client_count integer not null,
  list_total_minor bigint not null,
  wholesale_total_minor bigint not null,
  unpriced_count integer not null,
  constraint wholesale_statements_month_start check (period_start = date_trunc('month', period_start)::date),
  constraint wholesale_statements_discount_range check (wholesale_discount_bps between 0 and 9000),
  constraint wholesale_statements_counts check (client_count >= 0 and unpriced_count between 0 and client_count),
  constraint wholesale_statements_totals check (list_total_minor >= 0 and wholesale_total_minor between 0 and list_total_minor)
);

create index wholesale_statements_currency_code_idx on app.wholesale_statements (currency_code);

call private.install_domain_table('app.wholesale_statements', null, null, '{}', true);
create unique index wholesale_statements_one_per_month on app.wholesale_statements (org_id, period_start) where deleted_at is null;
call private.describe('app.wholesale_statements', 'What the platform bills a partner for one month (Section 4.6.1): every client org at its plan''s list price less the partner''s wholesale discount. Written only by app.run_wholesale_billing; append-only. Totals cover priced lines; unpriced lines are counted, never treated as zero.', array[
  'period_start', 'First day of the month billed.',
  'currency_code', 'Currency of the partner agreement.',
  'wholesale_discount_bps', 'Discount in force when the statement ran.',
  'client_count', 'Client orgs on the statement.',
  'list_total_minor', 'Sum of priced list prices in minor units.',
  'wholesale_total_minor', 'Sum of priced wholesale amounts in minor units: what the partner owes.',
  'unpriced_count', 'Lines whose plan has no price in the currency.'
]);

call private.install_policies('app.wholesale_statements',
  $$org_id in (select private.orgs_with_capability('org.billing.manage'))$$);

create table app.wholesale_statement_lines (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  wholesale_statement_id uuid not null references app.wholesale_statements (id),
  client_org_id uuid not null references app.organizations (id),
  plan_code text not null references app.plans (code),
  list_minor bigint,
  wholesale_minor bigint,
  client_price_minor bigint,
  constraint wholesale_statement_lines_priced check ((list_minor is null) = (wholesale_minor is null)),
  constraint wholesale_statement_lines_amounts check (list_minor is null or (list_minor >= 0 and wholesale_minor between 0 and list_minor)),
  constraint wholesale_statement_lines_client_price check (client_price_minor is null or client_price_minor >= 0)
);

create index wholesale_statement_lines_statement_idx on app.wholesale_statement_lines (wholesale_statement_id);
create index wholesale_statement_lines_client_org_id_idx on app.wholesale_statement_lines (client_org_id);
create index wholesale_statement_lines_plan_code_idx on app.wholesale_statement_lines (plan_code);

call private.install_domain_table('app.wholesale_statement_lines', 'app.wholesale_statements', 'wholesale_statement_id', '{}', true);
call private.describe('app.wholesale_statement_lines', 'One client org on a wholesale statement: its plan, list price, wholesale amount and the price the partner charges it. Append-only.', array[
  'wholesale_statement_id', 'Statement.',
  'client_org_id', 'Client org billed.',
  'plan_code', 'Client''s plan when the statement ran.',
  'list_minor', 'Monthly list price in minor units; null when the plan is unpriced in the currency.',
  'wholesale_minor', 'List price less the discount, rounded down to the minor unit; null when unpriced.',
  'client_price_minor', 'What the partner charges the client, when it set a price in the same currency.'
]);

call private.install_policies('app.wholesale_statement_lines',
  $$org_id in (select private.orgs_with_capability('org.billing.manage'))$$);

create or replace function app.run_wholesale_billing(p_partner_org_id uuid, p_period_start date)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_agreement app.partner_agreements;
  v_statement uuid;
begin
  perform private.require_person();
  if not private.has_capability(p_partner_org_id, 'org.billing.manage') then
    raise exception using errcode = '42501', message = 'org.billing.manage is required in the partner org';
  end if;
  if p_period_start is null or p_period_start <> date_trunc('month', p_period_start)::date then
    perform private.refuse('wholesale_period_month', 'A wholesale statement covers a calendar month; give its first day.');
  end if;
  if p_period_start > date_trunc('month', now() at time zone 'UTC')::date then
    perform private.refuse('wholesale_period_future', 'A month is billed once it has started.');
  end if;
  select * into v_agreement from app.partner_agreements a where a.org_id = p_partner_org_id and a.deleted_at is null;
  if v_agreement.id is null then
    perform private.refuse('partner_agreement_missing', 'Wholesale billing starts once the platform records your partner agreement.');
  end if;
  if not exists (select 1 from app.organizations o where o.parent_org_id = p_partner_org_id and o.deleted_at is null) then
    perform private.refuse('partner_no_clients', 'Create a client org before running wholesale billing.');
  end if;
  if exists (select 1 from app.wholesale_statements s where s.org_id = p_partner_org_id and s.period_start = p_period_start and s.deleted_at is null) then
    perform private.refuse('wholesale_statement_exists', 'This month is already billed.');
  end if;

  insert into app.wholesale_statements (org_id, period_start, currency_code, wholesale_discount_bps, client_count,
    list_total_minor, wholesale_total_minor, unpriced_count)
  values (p_partner_org_id, p_period_start, v_agreement.currency_code, v_agreement.wholesale_discount_bps, 0, 0, 0, 0)
  returning id into v_statement;

  insert into app.wholesale_statement_lines (wholesale_statement_id, client_org_id, plan_code, list_minor, wholesale_minor, client_price_minor)
  select v_statement, o.id, coalesce(s.plan_code, 'access'), lp.monthly_minor,
    lp.monthly_minor * (10000 - v_agreement.wholesale_discount_bps) / 10000,
    cp.monthly_minor
  from app.organizations o
  left join app.subscriptions s on s.org_id = o.id and s.subscription_state <> 'canceled' and s.deleted_at is null
  left join private.plan_list_prices lp on lp.plan_code = coalesce(s.plan_code, 'access') and lp.currency_code = v_agreement.currency_code
  left join app.partner_client_prices cp on cp.org_id = p_partner_org_id and cp.client_org_id = o.id
    and cp.currency_code = v_agreement.currency_code and cp.deleted_at is null
  where o.parent_org_id = p_partner_org_id and o.deleted_at is null;

  perform private.begin_trusted_operation('wholesale_statement');
  update app.wholesale_statements s set
    client_count = t.n, list_total_minor = t.list_total, wholesale_total_minor = t.wholesale_total, unpriced_count = t.unpriced
  from (select count(*)::integer as n, coalesce(sum(l.list_minor), 0) as list_total,
          coalesce(sum(l.wholesale_minor), 0) as wholesale_total, count(*) filter (where l.list_minor is null)::integer as unpriced
        from app.wholesale_statement_lines l where l.wholesale_statement_id = v_statement) t
  where s.id = v_statement;
  perform private.end_trusted_operation('wholesale_statement');
  return v_statement;
end;
$$;

comment on function app.run_wholesale_billing(uuid, date) is 'Bills a partner for one month (Section 4.6.1): one line per client org at its plan''s list price in the agreement currency less the wholesale discount, with the partner''s own client price beside it. Needs org.billing.manage (the partner Owner). Refuses a month already billed, a future month, a partner without an agreement or without clients. Charging runs through the billing service, never from here. Returns the statement id.';
revoke all on function app.run_wholesale_billing(uuid, date) from public, anon;
grant execute on function app.run_wholesale_billing(uuid, date) to authenticated, service_role;

-- The statement totals are filled once inside the RPC; the append-only trigger allows that one update.
create or replace function private.guard_wholesale_statement_totals()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if private.in_trusted_operation('wholesale_statement') and old.client_count = 0 and old.list_total_minor = 0 then
    return new;
  end if;
  perform private.refuse('ledger_append_only', 'A wholesale statement never changes once issued.');
  return null;
end;
$$;

comment on function private.guard_wholesale_statement_totals() is 'Wholesale statements are append-only, except the one update of the totals inside app.run_wholesale_billing.';
revoke all on function private.guard_wholesale_statement_totals() from public, anon, authenticated;

drop trigger if exists t95_append_only on app.wholesale_statements;
create trigger t95_append_only before update or delete on app.wholesale_statements
  for each row execute function private.guard_wholesale_statement_totals();

-- Support sessions ---------------------------------------------------------------------------------------

create table app.support_sessions (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  grantee_org_id uuid not null references app.organizations (id),
  reason text not null,
  starts_at timestamptz not null default now(),
  ends_at timestamptz not null,
  ended_at timestamptz,
  ended_by uuid references app.people (id),
  constraint support_sessions_not_self check (grantee_org_id <> org_id),
  constraint support_sessions_reason_length check (char_length(btrim(reason)) between 1 and 500),
  constraint support_sessions_window check (ends_at > starts_at and ends_at <= starts_at + interval '24 hours'),
  constraint support_sessions_ended check ((ended_at is null) = (ended_by is null))
);

create index support_sessions_grantee_org_id_idx on app.support_sessions (grantee_org_id);
create index support_sessions_ended_by_idx on app.support_sessions (ended_by);

call private.install_domain_table('app.support_sessions');
call private.describe('app.support_sessions', 'A support session (Section 4.6.1, Section 8): the client org''s Owner lets its partner''s staff read the client org for at most 24 hours. Partner staff read nothing of a client without one. Created and ended only through the RPCs; every grant lands in the client''s audit ledger.', array[
  'org_id', 'Client org that granted the session.',
  'grantee_org_id', 'Partner org whose staff may read while the session lasts.',
  'reason', 'Why the session was granted, in the Owner''s words.',
  'starts_at', 'When access began.',
  'ends_at', 'When access ends on its own, at most 24 hours after it began.',
  'ended_at', 'When someone ended the session early.',
  'ended_by', 'Person who ended it early.'
]);

call private.install_policies('app.support_sessions',
  $$org_id in (select private.my_org_ids()) or grantee_org_id in (select private.orgs_with_capability('org.partner.manage'))$$);
call private.install_audit_trail('app.support_sessions');

create table app.support_session_grants (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  support_session_id uuid not null references app.support_sessions (id),
  record_grant_id uuid not null references app.record_grants (id)
);

create index support_session_grants_session_idx on app.support_session_grants (support_session_id);
create unique index support_session_grants_grant_key on app.support_session_grants (record_grant_id);

call private.install_domain_table('app.support_session_grants', 'app.support_sessions', 'support_session_id', '{}', true);
call private.describe('app.support_session_grants', 'The record grants a support session issued, one per read capability, so ending the session ends each of them.', array[
  'support_session_id', 'Support session.',
  'record_grant_id', 'Org-level record grant the session issued.'
]);

call private.install_policies('app.support_session_grants',
  $$support_session_id in (select s.id from app.support_sessions s
    where s.org_id in (select private.my_org_ids()) or s.grantee_org_id in (select private.orgs_with_capability('org.partner.manage')))$$);

create or replace function private.support_read_capabilities()
returns setof text
language sql
stable
security definer
set search_path = ''
as $$
  select c.code from app.capabilities c
  where c.capability_class = 'read'
    and c.code not like 'data.restricted.%'
    and c.code not in ('org.billing.read', 'audit.log.read')
  order by c.code;
$$;

comment on function private.support_read_capabilities() is 'Capabilities a support session grants: every read capability except Restricted data, billing and the audit ledger. Support never writes.';
revoke all on function private.support_read_capabilities() from public, anon, authenticated;

create or replace function app.grant_support_session(p_org_id uuid, p_hours integer, p_reason text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
  v_partner uuid;
  v_session app.support_sessions;
  v_capability text;
  v_grant uuid;
begin
  if not private.has_capability(p_org_id, 'org.support_session.grant') then
    raise exception using errcode = '42501', message = 'org.support_session.grant is required';
  end if;
  select o.parent_org_id into v_partner from app.organizations o where o.id = p_org_id and o.deleted_at is null;
  if v_partner is null then
    perform private.refuse('support_session_no_partner', 'Only a client org grants its partner a support session.');
  end if;
  if p_hours is null or p_hours not between 1 and 24 then
    perform private.refuse('support_session_hours', 'A support session lasts from 1 to 24 hours.');
  end if;
  if p_reason is null or char_length(btrim(p_reason)) not between 1 and 500 then
    perform private.refuse('support_session_reason', 'Say why the partner needs access, in up to 500 characters.');
  end if;
  perform 1 from app.organizations o where o.id = p_org_id for update;
  if exists (select 1 from app.support_sessions s where s.org_id = p_org_id and s.ended_at is null
             and s.ends_at > now() and s.deleted_at is null) then
    perform private.refuse('support_session_active', 'A support session is already open; end it before granting another.');
  end if;

  insert into app.support_sessions (org_id, grantee_org_id, reason, ends_at)
  values (p_org_id, v_partner, btrim(p_reason), now() + make_interval(hours => p_hours))
  returning * into v_session;

  for v_capability in select private.support_read_capabilities() loop
    insert into app.record_grants (target_kind, target_id, capability_code, grantee_org_id, valid_from, valid_to, reason)
    values ('organization', p_org_id, v_capability, v_partner, v_session.starts_at, v_session.ends_at,
            left('Support session: ' || btrim(p_reason), 500))
    returning id into v_grant;
    insert into app.support_session_grants (support_session_id, record_grant_id) values (v_session.id, v_grant);
  end loop;
  return v_session.id;
end;
$$;

comment on function app.grant_support_session(uuid, integer, text) is 'The client Owner (org.support_session.grant) lets its partner''s staff read the client org for 1 to 24 hours with a reason: one org-level record grant per read capability, each written to the client''s audit ledger. One open session at a time. Returns the session id.';
revoke all on function app.grant_support_session(uuid, integer, text) from public, anon;
grant execute on function app.grant_support_session(uuid, integer, text) to authenticated, service_role;

create or replace function app.end_support_session(p_support_session_id uuid)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
  v_session app.support_sessions;
begin
  select * into v_session from app.support_sessions s where s.id = p_support_session_id and s.deleted_at is null for update;
  if v_session.id is null
     or not (private.has_capability(v_session.org_id, 'org.support_session.grant')
             or private.has_capability(v_session.grantee_org_id, 'org.partner.manage')) then
    raise exception using errcode = '42501', message = 'support session not found';
  end if;
  if v_session.ended_at is not null or v_session.ends_at <= now() then
    perform private.refuse('support_session_ended', 'This support session has already ended.');
  end if;
  update app.record_grants g set valid_to = greatest(now(), g.valid_from)
  where g.id in (select sg.record_grant_id from app.support_session_grants sg where sg.support_session_id = v_session.id);
  update app.support_sessions set ended_at = now(), ended_by = v_person where id = v_session.id;
  return v_session.id;
end;
$$;

comment on function app.end_support_session(uuid) is 'Ends a support session early: the client''s Owner or the partner''s staff with org.partner.manage. Every grant of the session ends at once.';
revoke all on function app.end_support_session(uuid) from public, anon;
grant execute on function app.end_support_session(uuid) to authenticated, service_role;

create or replace function private.guard_support_session()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and (new.org_id <> old.org_id or new.grantee_org_id <> old.grantee_org_id
      or new.starts_at <> old.starts_at or new.ends_at <> old.ends_at or new.reason <> old.reason
      or (old.ended_at is not null and new.ended_at is distinct from old.ended_at)) then
    perform private.refuse('support_session_immutable', 'A support session keeps its parties, window and reason; it can only be ended early, once.');
  end if;
  return new;
end;
$$;

comment on function private.guard_support_session() is 'Support sessions keep their parties, window and reason; ending early happens once.';
revoke all on function private.guard_support_session() from public, anon, authenticated;

create trigger t40_guard_support_session before update on app.support_sessions
  for each row execute function private.guard_support_session();

-- Partner reads: billing facts and usage, never client data ----------------------------------------------

create or replace function app.partner_client_orgs(p_partner_org_id uuid)
returns table (
  org_id uuid,
  name text,
  slug text,
  plan_code text,
  subscription_state app.subscription_state,
  seats bigint,
  field_members bigint,
  created_at timestamptz,
  owner_joined boolean,
  support_session_id uuid,
  support_session_ends_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.has_capability(p_partner_org_id, 'org.partner.manage') then
    raise exception using errcode = '42501', message = 'org.partner.manage is required in the partner org';
  end if;
  return query
  select o.id, o.name, o.slug, coalesce(s.plan_code, 'access'), s.subscription_state, c.seats, c.field_members, o.created_at,
    exists (select 1 from app.memberships m join app.membership_roles mr on mr.membership_id = m.id and mr.deleted_at is null
            join app.roles r on r.id = mr.role_id and r.org_id is null and r.code = 'owner'
            where m.org_id = o.id and m.deleted_at is null and (m.valid_to is null or m.valid_to > now())),
    ss.id, ss.ends_at
  from app.organizations o
  left join app.subscriptions s on s.org_id = o.id and s.subscription_state <> 'canceled' and s.deleted_at is null
  cross join lateral private.membership_band_counts(o.id) c
  left join lateral (
    select x.id, x.ends_at from app.support_sessions x
    where x.org_id = o.id and x.grantee_org_id = p_partner_org_id and x.ended_at is null and x.ends_at > now() and x.deleted_at is null
    order by x.starts_at desc limit 1) ss on true
  where o.parent_org_id = p_partner_org_id and o.deleted_at is null
  order by o.name;
end;
$$;

comment on function app.partner_client_orgs(uuid) is 'The partner console''s client list (Section 4.6.1): each client org''s name, plan, subscription state, seat counts, whether its Owner has joined, and any open support session. Billing facts only; client records stay unreadable without a support session.';
revoke all on function app.partner_client_orgs(uuid) from public, anon;
grant execute on function app.partner_client_orgs(uuid) to authenticated, service_role;

create or replace function app.partner_client_usage(p_partner_org_id uuid, p_period_start date)
returns table (org_id uuid, meter_code text, quantity bigint)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.has_capability(p_partner_org_id, 'org.partner.manage') then
    raise exception using errcode = '42501', message = 'org.partner.manage is required in the partner org';
  end if;
  if p_period_start is null or p_period_start <> date_trunc('month', p_period_start)::date then
    perform private.refuse('usage_period_month', 'Usage is totaled per calendar month; give its first day.');
  end if;
  return query
  select o.id, u.meter_code, sum(u.quantity)::bigint
  from app.organizations o
  join app.usage_events u on u.org_id = o.id
    and u.created_at >= p_period_start::timestamptz and u.created_at < (p_period_start + interval '1 month')::timestamptz
  where o.parent_org_id = p_partner_org_id and o.deleted_at is null
  group by o.id, u.meter_code
  order by o.id, u.meter_code;
end;
$$;

comment on function app.partner_client_usage(uuid, date) is 'Usage rollup of every client org for one month, per meter (Section 4.6.1). Totals only.';
revoke all on function app.partner_client_usage(uuid, date) from public, anon;
grant execute on function app.partner_client_usage(uuid, date) to authenticated, service_role;

-- Retention ---------------------------------------------------------------------------------------------

insert into private.retention_policies (table_name, basis, time_column, retention, purge_method, rationale) values
  ('app.partner_agreements', 'Soft Deleted', 'deleted_at', interval '7 years', 'Delete', 'Commercial terms are kept for the financial record.'),
  ('app.partner_default_brands', 'Soft Deleted', 'deleted_at', interval '90 days', 'Delete', 'A removed default brand carries no history value.'),
  ('app.partner_client_prices', 'Soft Deleted', 'deleted_at', interval '7 years', 'Delete', 'Prices charged are part of the financial record.'),
  ('app.wholesale_statements', 'Age', 'created_at', interval '7 years', 'Delete', 'Billing statements are kept for the financial record.'),
  ('app.wholesale_statement_lines', 'Age', 'created_at', interval '7 years', 'Delete', 'Kept as long as their statement.'),
  ('app.support_sessions', 'Age', 'created_at', interval '7 years', 'Delete', 'Access to tenant data is a compliance record (Section 8).'),
  ('app.support_session_grants', 'Age', 'created_at', interval '7 years', 'Delete', 'Kept as long as their session.');

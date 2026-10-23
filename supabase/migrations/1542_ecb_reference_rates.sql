-- 1542_ecb_reference_rates.sql
--
-- A97 (RRR-142, A65-028, WP21; ADR 0053). Section 15: "Conversions use European Central Bank daily reference
-- rates stored with their date." Until now every rate in app.fx_rates was typed by hand.
--   * private.fx_reference_rates: what the ECB published, once per publication date and currency, against the euro.
--   * private.fx_feed_runs: every run of the feed, succeeded or failed, so no failure is silent.
--   * app.record_fx_reference_rates(source, rate date, rates): called by the fx-rates-ecb Edge Function with the
--     service key. Writes the day's rates idempotently per date: into the reference table, then into every live
--     org's app.fx_rates as EUR to each currency with source ECB and effective_on the ECB publication date (a
--     CET business day, never a date derived from UTC). A rerun for the same date changes nothing; an org's own
--     rate for the same pair and day is never overwritten. Currencies XOS does not know are skipped and counted.
--   * app.record_fx_feed_failure(source, error): the worker records any failure here.
--   * app.fx_feed_status(source): what finance pages read to say when rates last arrived and whether the feed is
--     failing.
--   * private.request_fx_feed(): what pg_cron runs on ECB business days after publication (about 16:00 CET):
--     it calls the Edge Function with the service key from Vault (xos_worker_key, as the other workers) at the
--     functions URL in Vault (xos_functions_url, an owner step in infra/runbooks/production.md). Without either
--     secret it records a failed run saying so, which finance pages show.

create table private.fx_reference_rates (
  source text not null check (source ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
  rate_date date not null,
  base_currency char(3) not null references private.currencies (currency_code),
  quote_currency char(3) not null references private.currencies (currency_code),
  rate numeric not null check (rate > 0),
  recorded_at timestamptz not null default now(),
  primary key (source, rate_date, quote_currency),
  check (base_currency <> quote_currency)
);
comment on table private.fx_reference_rates is 'Reference rates as their publisher released them (ECB: one euro''s worth of each currency per publication date), kept once for the platform. app.record_fx_reference_rates copies each day into every org''s app.fx_rates.';
comment on column private.fx_reference_rates.source is 'Publisher, for example ECB; the same text as app.fx_rates.source.';
comment on column private.fx_reference_rates.rate_date is 'The publication date the publisher states (an ECB TARGET business day in CET), never a date derived from UTC.';
comment on column private.fx_reference_rates.base_currency is 'The currency rates are quoted against (EUR for the ECB).';
comment on column private.fx_reference_rates.quote_currency is 'The currency one unit of base_currency buys rate units of.';
comment on column private.fx_reference_rates.rate is 'Units of quote_currency per unit of base_currency.';
comment on column private.fx_reference_rates.recorded_at is 'When the rate was last written.';
create index fx_reference_rates_base_currency_idx on private.fx_reference_rates (base_currency);
create index fx_reference_rates_quote_currency_idx on private.fx_reference_rates (quote_currency);
alter table private.fx_reference_rates enable row level security;
revoke all on private.fx_reference_rates from public, anon, authenticated;
grant select on private.fx_reference_rates to service_role;

create table private.fx_feed_runs (
  id uuid primary key default private.uuid_v7(),
  source text not null check (source ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
  ran_at timestamptz not null default clock_timestamp(),
  outcome text not null check (outcome in ('Succeeded', 'Failed')),
  rate_date date,
  currencies integer check (currencies >= 0),
  skipped_currencies integer check (skipped_currencies >= 0),
  orgs integer check (orgs >= 0),
  rows_written integer check (rows_written >= 0),
  error text check (char_length(error) <= 500),
  check ((outcome = 'Failed') = (error is not null)),
  check (outcome = 'Failed' or rate_date is not null)
);
comment on table private.fx_feed_runs is 'Every run of a reference rate feed (Section 15, ADR 0053): what it wrote, or why it failed, so no failure is silent. app.fx_feed_status summarizes it for finance pages.';
comment on column private.fx_feed_runs.id is 'Run id.';
comment on column private.fx_feed_runs.source is 'Publisher, for example ECB.';
comment on column private.fx_feed_runs.ran_at is 'When the run ended.';
comment on column private.fx_feed_runs.outcome is 'Succeeded or Failed.';
comment on column private.fx_feed_runs.rate_date is 'The publication date of the rates a successful run wrote.';
comment on column private.fx_feed_runs.currencies is 'Currencies written.';
comment on column private.fx_feed_runs.skipped_currencies is 'Currencies the publisher listed that XOS does not know, skipped.';
comment on column private.fx_feed_runs.orgs is 'Orgs whose rates were written.';
comment on column private.fx_feed_runs.rows_written is 'app.fx_rates rows inserted or changed; 0 on a rerun for the same date.';
comment on column private.fx_feed_runs.error is 'Why a failed run failed (at most 500 characters).';
create index fx_feed_runs_source_ran_idx on private.fx_feed_runs (source, ran_at desc);
alter table private.fx_feed_runs enable row level security;
revoke all on private.fx_feed_runs from public, anon, authenticated;
grant select on private.fx_feed_runs to service_role;

create function app.record_fx_reference_rates(p_source text, p_rate_date date, p_rates jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_known integer;
  v_skipped integer;
  v_orgs integer;
  v_written integer;
begin
  if p_source is null or p_source !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$' then
    raise exception using errcode = '22023', message = 'record_fx_reference_rates: the source must be a short code such as ECB';
  end if;
  if p_rate_date is null then
    raise exception using errcode = '22023', message = 'record_fx_reference_rates: the rate date is required';
  end if;
  if p_rates is null or jsonb_typeof(p_rates) <> 'object' then
    raise exception using errcode = '22023', message = 'record_fx_reference_rates: rates must be an object of currency to rate';
  end if;

  create temporary table fx_incoming (quote_currency char(3) primary key, rate numeric not null) on commit drop;
  insert into fx_incoming (quote_currency, rate)
  select e.key, (e.value #>> '{}')::numeric
  from jsonb_each(p_rates) e
  join private.currencies c on c.currency_code = e.key
  where e.key <> 'EUR' and jsonb_typeof(e.value) = 'number' and (e.value #>> '{}')::numeric > 0;
  select count(*)::integer into v_known from fx_incoming;
  select count(*)::integer - v_known into v_skipped from jsonb_object_keys(p_rates);
  if v_known = 0 then
    raise exception using errcode = '22023', message = 'record_fx_reference_rates: no rate is for a currency XOS knows';
  end if;

  insert into private.fx_reference_rates (source, rate_date, base_currency, quote_currency, rate)
  select p_source, p_rate_date, 'EUR', i.quote_currency, i.rate from fx_incoming i
  on conflict (source, rate_date, quote_currency) do update
    set rate = excluded.rate, recorded_at = now()
    where private.fx_reference_rates.rate <> excluded.rate;

  select count(*)::integer into v_orgs from app.organizations o where o.deleted_at is null;
  with written as (
    insert into app.fx_rates (org_id, base_currency, quote_currency, rate, effective_on, source)
    select o.id, 'EUR', i.quote_currency, i.rate, p_rate_date, p_source
    from app.organizations o cross join fx_incoming i
    where o.deleted_at is null
    on conflict (org_id, base_currency, quote_currency, effective_on) where deleted_at is null do update
      set rate = excluded.rate
      where app.fx_rates.source = excluded.source and app.fx_rates.rate <> excluded.rate
    returning 1
  )
  select count(*)::integer into v_written from written;

  insert into private.fx_feed_runs (source, outcome, rate_date, currencies, skipped_currencies, orgs, rows_written)
  values (p_source, 'Succeeded', p_rate_date, v_known, v_skipped, v_orgs, v_written);
  drop table fx_incoming;
  return jsonb_build_object('rate_date', p_rate_date, 'currencies', v_known, 'skipped', v_skipped,
    'orgs', v_orgs, 'rows_written', v_written);
end;
$$;
comment on function app.record_fx_reference_rates(text, date, jsonb) is 'Records one publication date of reference rates (Section 15, ADR 0053): an object of currency to units per euro, written idempotently per date into private.fx_reference_rates and every live org''s app.fx_rates (EUR to each currency, source and effective_on as published). A rerun for the same date writes nothing new, and an org''s own rate for the same pair and day is kept. Unknown currencies are skipped and counted. Records the run in private.fx_feed_runs. Service role only (the fx-rates-ecb Edge Function).';

create function app.record_fx_feed_failure(p_source text, p_error text)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into private.fx_feed_runs (source, outcome, error)
  values (p_source, 'Failed', left(coalesce(nullif(btrim(p_error), ''), 'The feed failed without a message.'), 500));
$$;
comment on function app.record_fx_feed_failure(text, text) is 'Records a failed reference rate feed run with its reason (at most 500 characters), so finance pages can say the rates may be stale. Service role only.';

create function app.fx_feed_status(p_source text default 'ECB')
returns table (
  last_success_at timestamptz,
  last_rate_date date,
  last_failure_at timestamptz,
  last_error text,
  failures_since_success integer
)
language sql
stable
security definer
set search_path = ''
as $$
  with ok as (
    select r.ran_at, r.rate_date from private.fx_feed_runs r
    where r.source = p_source and r.outcome = 'Succeeded'
    order by r.ran_at desc limit 1
  ), bad as (
    select r.ran_at, r.error from private.fx_feed_runs r
    where r.source = p_source and r.outcome = 'Failed'
    order by r.ran_at desc limit 1
  )
  select (select ran_at from ok), (select rate_date from ok), (select ran_at from bad), (select error from bad),
    (select count(*)::integer from private.fx_feed_runs r
      where r.source = p_source and r.outcome = 'Failed'
        and r.ran_at > coalesce((select ran_at from ok), '-infinity'::timestamptz));
$$;
comment on function app.fx_feed_status(text) is 'A reference rate feed''s state for finance pages (Section 15, ADR 0053): when it last succeeded and the publication date it wrote, its last failure and reason, and how many runs failed since the last success. Holds no org data.';

create function private.request_fx_feed()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_url text;
  v_key text;
begin
  select s.decrypted_secret into v_url from vault.decrypted_secrets s where s.name = 'xos_functions_url';
  select s.decrypted_secret into v_key from vault.decrypted_secrets s where s.name = 'xos_worker_key';
  if v_url is null or v_key is null then
    perform app.record_fx_feed_failure('ECB',
      'The ECB feed is not configured: Vault needs xos_functions_url and xos_worker_key (infra/runbooks/production.md, Exchange rates).');
    return;
  end if;
  perform net.http_post(
    url := rtrim(v_url, '/') || '/fx-rates-ecb',
    headers := jsonb_build_object('Authorization', 'Bearer ' || v_key, 'Content-Type', 'application/json'),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000
  );
end;
$$;
comment on function private.request_fx_feed() is 'pg_cron''s ECB feed step: calls the fx-rates-ecb Edge Function with the service key from Vault (xos_worker_key) at the functions URL in Vault (xos_functions_url). Without either it records a failed run saying the feed is not configured.';

revoke all on function app.record_fx_reference_rates(text, date, jsonb) from public, anon, authenticated;
revoke all on function app.record_fx_feed_failure(text, text) from public, anon, authenticated;
revoke all on function app.fx_feed_status(text) from public, anon;
revoke all on function private.request_fx_feed() from public, anon, authenticated;
grant execute on function app.record_fx_reference_rates(text, date, jsonb) to service_role;
grant execute on function app.record_fx_feed_failure(text, text) to service_role;
grant execute on function app.fx_feed_status(text) to authenticated, service_role;

-- ECB business days, after the 16:00 CET publication in winter (15:00 UTC) and summer (14:00 UTC), with a
-- second run in the evening in case the first failed or the file was late. Reruns for the same date are no-ops.
select cron.schedule('xos_fx_rates_ecb', '30 15,21 * * 1-5', 'select private.request_fx_feed()');

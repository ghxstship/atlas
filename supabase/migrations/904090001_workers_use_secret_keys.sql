-- The worker schedules call the Edge Functions with a secret API key on the apikey header (ADR 0168). Supabase's
-- secret keys (sb_secret_...) are not JWTs: sent as Authorization: Bearer the platform parses them as a JWT and refuses
-- them. So the key from Vault (xos_worker_key, now a secret key, never the legacy service_role JWT) goes on the apikey
-- header, and every worker compares it itself (supabase/functions/_shared/api-keys.ts) with verify_jwt off.
--
-- private.worker_request is the one place a schedule builds that request. The four schedules this repository makes
-- (exchange rates, exports, guest emails, weather) call it; the workers an operator schedules by hand call it too
-- (infra/runbooks/integrations.md). Their decisions about whether to call are unchanged.

create function private.worker_request(p_function text, p_timeout_ms integer default 60000)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_url text;
  v_key text;
begin
  if p_function is null or p_function !~ '^[a-z][a-z0-9-]*$' then
    raise exception 'worker_request: % is not an Edge Function name', p_function using errcode = '22023';
  end if;
  select s.decrypted_secret into v_url from vault.decrypted_secrets s where s.name = 'xos_functions_url';
  select s.decrypted_secret into v_key from vault.decrypted_secrets s where s.name = 'xos_worker_key';
  if v_url is null or v_key is null then
    return null;
  end if;
  return net.http_post(
    url := rtrim(v_url, '/') || '/' || p_function,
    headers := jsonb_build_object('apikey', v_key, 'Content-Type', 'application/json'),
    body := '{}'::jsonb,
    timeout_milliseconds := p_timeout_ms
  );
end;
$$;
comment on function private.worker_request(text, integer) is 'Calls one worker Edge Function for pg_cron (ADR 0168): POSTs {} to the function at the functions URL in Vault (xos_functions_url) with the secret API key in Vault (xos_worker_key) on the apikey header, never as a bearer JWT. Returns the pg_net request id, or null when either Vault secret is missing, so an unconfigured project sends nothing.';
revoke all on function private.worker_request(text, integer) from public, anon, authenticated;

create or replace function private.request_fx_feed()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if private.worker_request('fx-rates-ecb', 30000) is null then
    perform app.record_fx_feed_failure('ECB',
      'The ECB feed is not configured: Vault needs xos_functions_url and xos_worker_key (infra/runbooks/production.md, Exchange rates).');
  end if;
end;
$$;
comment on function private.request_fx_feed() is 'pg_cron''s ECB feed step: calls the fx-rates-ecb Edge Function through private.worker_request (the secret key in Vault, xos_worker_key, on the apikey header). Without the Vault secrets it records a failed run saying the feed is not configured.';
revoke all on function private.request_fx_feed() from public, anon, authenticated;

create or replace function private.request_export_render()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (select 1 from app.job_queue q
                 where q.job_kind = 'export.render' and q.job_status = 'Queued' and q.run_after <= now() and q.deleted_at is null)
     and not exists (select 1 from app.export_jobs e
                     where e.export_status = 'Ready' and e.expires_at <= now() and e.deleted_at is null) then
    return;
  end if;
  perform private.worker_request('export-render', 60000);
end;
$$;
comment on function private.request_export_render() is 'pg_cron''s export step: when an export.render job is ready or an export file has expired, calls the export-render Edge Function through private.worker_request. Without the Vault secrets it does nothing and exports wait (infra/runbooks/production.md, Exports).';
revoke all on function private.request_export_render() from public, anon, authenticated;

create or replace function private.request_guest_email_send()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (select 1 from app.guest_emails e where e.send_state = 'Queued'
                 or (e.send_state = 'Sending' and e.claimed_at < now() - interval '10 minutes')) then
    return;
  end if;
  perform private.worker_request('guest-email', 60000);
end;
$$;
comment on function private.request_guest_email_send() is 'pg_cron''s guest email step: while guest emails are Queued, calls the guest-email Edge Function through private.worker_request. Without the Vault secrets it does nothing and the emails wait (infra/runbooks/production.md, Edge Functions).';
revoke all on function private.request_guest_email_send() from public, anon, authenticated;

create or replace function private.request_weather_feed()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Every feed's old runs go, including a feed turned off or outside its window, whose runs nothing else would touch.
  delete from private.weather_feed_runs r where r.ran_at < now() - interval '90 days';
  if not exists (select 1 from app.weather_feeds f where f.deleted_at is null) then
    return;
  end if;
  perform private.worker_request('weather-feed', 60000);
end;
$$;
comment on function private.request_weather_feed() is 'pg_cron''s weather step: removes feed runs older than 90 days, whichever feed they belong to, then, while any weather feed is on, calls the weather-feed Edge Function through private.worker_request. Without the Vault secrets it does nothing (infra/runbooks/production.md, Edge Functions).';
revoke all on function private.request_weather_feed() from public, anon, authenticated;

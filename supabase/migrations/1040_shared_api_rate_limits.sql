-- 1040_shared_api_rate_limits.sql
-- A34 security fixes (RRR-78), finding A22-012: the public API counted its rate limit windows in each
-- server instance's memory, so the effective limit grew with the number of warm instances. The windows
-- now live in Postgres, shared by every instance:
--   * private.api_rate_windows: one fixed window per caller, counted with an atomic upsert
--   * app.take_api_rate_limit: counts one request for the signed-in caller and answers the decision.
--     The caller is always auth.uid(), never an argument, so nobody spends or reads another caller's
--     budget. An API key acts as its own service account user, so each key has its own window.
--   * a cron job prunes windows older than a day
-- The in-process limiter in packages/api stays as the fallback when the database cannot answer.

create table private.api_rate_windows (
  caller_hash bytea not null,
  window_seconds integer not null,
  window_start timestamptz not null,
  request_count integer not null default 0,
  primary key (caller_hash, window_seconds, window_start),
  constraint api_rate_windows_seconds_range check (window_seconds between 1 and 3600),
  constraint api_rate_windows_count_nonnegative check (request_count >= 0)
);

create index api_rate_windows_start_idx on private.api_rate_windows (window_start);

comment on table private.api_rate_windows is 'Public API rate limit windows (A22-012, Section 9): requests counted per caller and fixed window, shared by every API server instance. Pruned after a day.';
comment on column private.api_rate_windows.caller_hash is 'SHA-256 of the caller''s auth user id; the raw id is never stored.';
comment on column private.api_rate_windows.window_seconds is 'Window length in seconds.';
comment on column private.api_rate_windows.window_start is 'Start of the fixed window, aligned to the Unix epoch.';
comment on column private.api_rate_windows.request_count is 'Requests counted in the window so far.';

alter table private.api_rate_windows enable row level security;
revoke all on private.api_rate_windows from public, anon, authenticated;
grant select on private.api_rate_windows to service_role;

create or replace function app.take_api_rate_limit(p_limit integer, p_window_seconds integer)
returns table (allowed boolean, remaining integer, reset_seconds integer)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_start timestamptz;
  v_count integer;
begin
  if v_user is null then
    raise exception using errcode = '42501', message = 'sign in to use the API';
  end if;
  if p_limit is null or p_limit not between 1 and 100000 or p_window_seconds is null or p_window_seconds not between 1 and 3600 then
    perform private.refuse('api_rate_limit_range', 'The limit is 1 to 100000 requests in a window of 1 to 3600 seconds.');
  end if;
  v_start := date_bin(make_interval(secs => p_window_seconds), now(), timestamptz '1970-01-01 00:00:00+00');
  insert into private.api_rate_windows as w (caller_hash, window_seconds, window_start, request_count)
  values (extensions.digest(v_user::text, 'sha256'), p_window_seconds, v_start, 1)
  on conflict (caller_hash, window_seconds, window_start)
  do update set request_count = w.request_count + 1
  returning w.request_count into v_count;
  return query select
    v_count <= p_limit,
    greatest(0, p_limit - v_count),
    greatest(1, ceil(extract(epoch from (v_start + make_interval(secs => p_window_seconds) - now())))::integer);
end;
$$;

comment on function app.take_api_rate_limit(integer, integer) is 'Public API rate limit (A22-012): counts one request for the signed-in caller in the current fixed window, atomically, and answers whether it is allowed, the requests left and the seconds until the window resets. The caller is auth.uid(); the limit and window come from the API runtime.';

revoke all on function app.take_api_rate_limit(integer, integer) from public, anon;
grant execute on function app.take_api_rate_limit(integer, integer) to authenticated, service_role;

select cron.schedule('xos_prune_api_rate_windows', '17 * * * *',
  $$delete from private.api_rate_windows where window_start < now() - interval '1 day'$$);

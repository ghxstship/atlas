-- 1296_request_ip_trusted_hop.sql
-- A69 security review (RRR-114), finding A69-002. private.request_ip() took the first X-Forwarded-For entry. Proxies
-- append the address they saw to whatever X-Forwarded-For the client sent, so the first entry is the client's own text:
-- behind the local and self-hosted Kong gateway a caller who sends `X-Forwarded-For: 203.0.113.77` is recorded as
-- 203.0.113.77. That let anyone reset the per-address failure limits of verify_certification, calendar_feed_events and
-- record_cookie_consent by changing the header on each call, and write any address into the audit ledger, file access
-- log and consent records.
-- Fix: the client address is the entry the trusted proxies added, counted from the right of X-Forwarded-For:
--   * xos.trusted_proxy_hops (a database setting, default 0) is how many trusted proxies sit between the gateway that
--     appends the client address and PostgREST. 0 takes the last entry, which is what the gateway saw (local Kong and
--     the self-hosted stack). A deployment with another trusted proxy behind the gateway sets it once:
--       alter database postgres set xos.trusted_proxy_hops = '1';
--     infra/runbooks/hosted-security-settings.md says how to check the value on staging.
--   * a chain shorter than the trusted hops means the request skipped a proxy, and the address is unknown (NULL);
--   * X-Real-IP, which the gateway sets itself, is used only when there is no X-Forwarded-For at all.
-- 1296_request_ip_trusted_hop.test.sql covers the spoofed first entry, the hop setting and malformed values.

create or replace function private.trusted_proxy_hops()
returns integer
language plpgsql
stable
set search_path = ''
as $$
declare
  v_raw text := btrim(coalesce(pg_catalog.current_setting('xos.trusted_proxy_hops', true), ''));
begin
  if v_raw ~ '^[0-9]{1,2}$' then
    return v_raw::integer;
  end if;
  return 0;
end;
$$;

comment on function private.trusted_proxy_hops() is 'How many trusted proxies sit between the gateway that appends the client address to X-Forwarded-For and PostgREST: the xos.trusted_proxy_hops database setting, 0 when unset or not a small whole number (A69-002).';
revoke all on function private.trusted_proxy_hops() from public, anon, authenticated;

create or replace function private.request_ip()
returns inet
language plpgsql
stable
set search_path = ''
as $$
declare
  v_chain text[] := array(
    select btrim(h) from unnest(string_to_array(coalesce(private.request_header('x-forwarded-for'), ''), ',')) as h
    where btrim(h) <> '');
  v_index integer;
  v_raw text;
begin
  if cardinality(v_chain) = 0 then
    v_raw := btrim(coalesce(private.request_header('x-real-ip'), ''));
  else
    v_index := cardinality(v_chain) - private.trusted_proxy_hops();
    if v_index < 1 then
      return null;
    end if;
    v_raw := v_chain[v_index];
  end if;
  if v_raw = '' then
    return null;
  end if;
  return v_raw::inet;
exception when invalid_text_representation then
  return null;
end;
$$;

comment on function private.request_ip() is 'Client IP address of the current API request: the X-Forwarded-For entry the trusted gateway appended, counted from the right past private.trusted_proxy_hops() (never the first entry, which the client writes), else X-Real-IP when no chain was sent; NULL when absent, malformed or when the chain is shorter than the trusted hops (A69-002).';
revoke all on function private.request_ip() from public, anon, authenticated;

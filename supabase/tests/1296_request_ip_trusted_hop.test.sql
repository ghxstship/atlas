-- pgTAP: migration 1296, finding A69-002 (RRR-114). private.request_ip() reads the X-Forwarded-For entry the trusted
-- gateway appended, counted from the right, never the first entry the client writes. A spoofed first entry therefore
-- neither resets a per-address failure limit nor reaches the audit ledger.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;

select plan(12);

create function pg_temp.headers(p_headers jsonb) returns void
language sql as $$ select set_config('request.headers', p_headers::text, true) $$;

select pg_temp.headers('{"x-forwarded-for": "203.0.113.77, 192.168.65.1", "x-real-ip": "192.168.65.1"}');
select is(private.request_ip(), '192.168.65.1'::inet, 'a spoofed first entry is ignored: the address the gateway appended counts');

select pg_temp.headers('{"x-forwarded-for": "198.51.100.20"}');
select is(private.request_ip(), '198.51.100.20'::inet, 'a single entry is the client address');

select pg_temp.headers('{"x-real-ip": "198.51.100.21"}');
select is(private.request_ip(), '198.51.100.21'::inet, 'X-Real-IP is used when no chain was sent');

select pg_temp.headers('{"x-forwarded-for": "203.0.113.77, nonsense"}');
select is(private.request_ip(), null, 'a malformed appended entry is unknown, never the spoofed one');

select pg_temp.headers('{}');
select is(private.request_ip(), null, 'no headers, no address');

-- One more trusted proxy behind the gateway (for example a load balancer that appends its own address).
select set_config('xos.trusted_proxy_hops', '1', true);
select pg_temp.headers('{"x-forwarded-for": "203.0.113.77, 198.51.100.30, 10.0.0.5"}');
select is(private.request_ip(), '198.51.100.30'::inet, 'with one trusted hop, the entry before the trusted proxy counts');
select pg_temp.headers('{"x-forwarded-for": "198.51.100.31"}');
select is(private.request_ip(), null, 'a chain shorter than the trusted hops skipped a proxy: the address is unknown');
select set_config('xos.trusted_proxy_hops', 'many', true);
select is(private.trusted_proxy_hops(), 0, 'a setting that is not a small whole number means no extra hops');
select set_config('xos.trusted_proxy_hops', '', true);

-- The per-address failure limit of verify_certification counts the gateway's address, whatever the client sends.
select pg_temp.headers('{"x-forwarded-for": "203.0.113.1, 192.0.2.44"}');
set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
do $$
begin
  for i in 1 .. 10 loop
    perform set_config('request.headers', jsonb_build_object('x-forwarded-for', format('203.0.113.%s, 192.0.2.44', i))::text, true);
    perform * from api_public.verify_certification('not-a-code-' || i);
  end loop;
end $$;
reset role;
select is((select count(*)::int from private.rate_limit_events
  where bucket = 'verify_certification.failure' and subject_hash = extensions.digest('192.0.2.44', 'sha256')), 10,
  'ten misses with ten different spoofed first entries count against one address');
select is((select count(*)::int from private.rate_limit_events
  where bucket = 'verify_certification.failure' and subject_hash = extensions.digest('203.0.113.1', 'sha256')), 0,
  'nothing is counted against the spoofed address');
select ok(private.rate_limit_exceeded('verify_certification.failure', '192.0.2.44', 10, interval '15 minutes'),
  'the eleventh try from that address is over the limit');

-- Catalog: only private.request_ip reads the forwarding chain, so no new function takes the client's first entry.
select set_eq($$
  select p.oid::regprocedure::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('app', 'private', 'api_public', 'api_external', 'xpms')
    and (p.prosrc ilike '%x-forwarded-for%' or p.prosrc ilike '%x-real-ip%')
$$, $$values ('private.request_ip()')$$, 'only private.request_ip reads the proxy headers');

select * from finish();
rollback;

-- pgTAP: 1450, the tables behind live lists and records are in the Realtime publication (A88, RRR-133, ADR 0044).
-- Realtime authorizes each change with the subscriber's JWT through row level security, so every published table
-- must keep RLS on and its read policy; a published table without RLS would stream every row to every subscriber.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;

select plan(4);

select is(
  (select count(*)::int from pg_catalog.pg_publication_tables p
   where p.pubname = 'supabase_realtime' and p.schemaname = 'app'
     and p.tablename in ('records', 'shifts', 'invoices', 'asset_units', 'sops')),
  5, 'records, shifts, invoices, asset units and SOPs stream their changes to live pages');

select is(
  (select count(*)::int from pg_catalog.pg_publication_tables p
   where p.pubname = 'supabase_realtime' and p.schemaname = 'app' and p.tablename in ('cues', 'run_of_show')),
  2, 'show mode still follows cues and running orders (0412)');

select is_empty($$
  select p.schemaname || '.' || p.tablename from pg_catalog.pg_publication_tables p
  join pg_catalog.pg_class c on c.relname = p.tablename
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace and n.nspname = p.schemaname
  where p.pubname = 'supabase_realtime' and not c.relrowsecurity
$$, 'every published table has row level security on, so Realtime filters each change per subscriber');

select is_empty($$
  select p.schemaname || '.' || p.tablename from pg_catalog.pg_publication_tables p
  join pg_catalog.pg_class c on c.relname = p.tablename
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace and n.nspname = p.schemaname
  where p.pubname = 'supabase_realtime' and p.schemaname = 'app'
    and not exists (select 1 from pg_catalog.pg_policy pol where pol.polrelid = c.oid and pol.polcmd in ('r', '*'))
$$, 'every published app table has a read policy');

select * from finish();
rollback;

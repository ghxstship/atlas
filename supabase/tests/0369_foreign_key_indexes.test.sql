-- pgTAP: every foreign key in app and private has an index whose leading columns are the key's columns
-- (ADR 0002, RRR-71), including the 26 record kind extension keys the Supabase advisor flagged.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;

select plan(2);

select is((
  select string_agg(format('%s.%s', c.conrelid::regclass, c.conname), ', ' order by 1)
  from pg_catalog.pg_constraint c
  join pg_catalog.pg_class t on t.oid = c.conrelid
  join pg_catalog.pg_namespace n on n.oid = t.relnamespace
  where c.contype = 'f' and n.nspname in ('app', 'private')
    and not exists (
      select 1 from pg_catalog.pg_index i
      where i.indrelid = c.conrelid
        and (i.indkey::int2[])[0:array_length(c.conkey, 1) - 1] @> c.conkey
        and (i.indkey::int2[])[0:array_length(c.conkey, 1) - 1] <@ c.conkey)
), null, 'every foreign key in app and private is backed by an index');

select is((select count(*)::int from pg_catalog.pg_indexes where schemaname = 'app' and indexname like 'record\_%\_record_kind_idx'), 26,
  'each of the 26 record kind extension tables indexes (record_id, record_kind)');

select * from finish();
rollback;

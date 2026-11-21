-- ADR 0169, work package 0: the direct-endpoint probe. Teardown.
--
-- Removes everything 0169-direct-endpoint-probe.sql created: the two policies, the empty bucket row, the function
-- in api_public, the publication membership, and the schema probe_0169 with its table and functions.
-- It can be run any number of times, also on a database where the setup never ran. Every lock is taken under
-- lock_timeout; if one is not free within three seconds the file rolls back and changes nothing, so run it again.
--
-- The last statement lists what is left. It must return zero rows.

begin;

set local lock_timeout = '3s';
set local statement_timeout = '30s';

do $$
begin
  if pg_catalog.to_regclass('storage.objects') is not null then
    drop policy if exists probe_0169_storage on storage.objects;
  end if;
  if pg_catalog.to_regclass('realtime.messages') is not null then
    drop policy if exists probe_0169_realtime on realtime.messages;
  end if;
  -- The bucket row. Supabase Storage refuses a DELETE on its tables unless storage.allow_delete_query is set, to
  -- keep stored files from losing their rows. This bucket never held a file, and the row is deleted only when it
  -- holds no object. The setting is switched on for that one statement and off again.
  -- The existence test and the query are separate IF statements on purpose: PL/pgSQL plans a whole IF expression
  -- at once, so one that named storage.buckets beside the test would fail on a database without Storage's tables.
  if pg_catalog.to_regclass('storage.buckets') is not null and pg_catalog.to_regclass('storage.objects') is not null then
    if exists (select 1 from storage.buckets where id = 'probe-0169') then
      if exists (select 1 from storage.objects where bucket_id = 'probe-0169') then
        raise warning 'probe_0169: bucket "probe-0169" holds objects, which the probe never creates. It is left in place; delete it in the dashboard (Storage, the bucket, Delete bucket), then run this file again.';
      else
        perform pg_catalog.set_config('storage.allow_delete_query', 'true', true);
        delete from storage.buckets where id = 'probe-0169';
        perform pg_catalog.set_config('storage.allow_delete_query', 'false', true);
      end if;
    end if;
  end if;
  if pg_catalog.to_regnamespace('api_public') is not null then
    drop function if exists api_public.probe_0169(text, text);
  end if;
  if pg_catalog.to_regclass('probe_0169.changes') is not null
     and exists (
       select 1 from pg_catalog.pg_publication_tables
        where pubname = 'supabase_realtime' and schemaname = 'probe_0169' and tablename = 'changes'
     ) then
    alter publication supabase_realtime drop table probe_0169.changes;
  end if;
end;
$$;

-- By now nothing outside the schema refers to it. RESTRICT makes that a fact the database checks: if anything
-- outside probe_0169 still depended on it, this statement would fail and the whole teardown would roll back.
do $$
begin
  if pg_catalog.to_regnamespace('probe_0169') is not null then
    drop table if exists probe_0169.changes;
    drop function if exists probe_0169.emit(text);
    drop function if exists probe_0169.storage_answer(text);
    drop function if exists probe_0169.answer(text, text);
    drop function if exists probe_0169.context(text);
    drop function if exists probe_0169.session_row_exists(text);
    drop schema probe_0169 restrict;
  end if;
end;
$$;

commit;

notify pgrst, 'reload schema';

-- What is left. Zero rows means the teardown is complete.
select kind, name
  from (
    select 'schema' as kind, n.nspname::text as name
      from pg_catalog.pg_namespace as n
     where n.nspname = 'probe_0169'
    union all
    select 'function', p.oid::regprocedure::text
      from pg_catalog.pg_proc as p
     where p.proname like 'probe\_0169%'
    union all
    select 'policy', pol.schemaname || '.' || pol.tablename || ': ' || pol.policyname
      from pg_catalog.pg_policies as pol
     where pol.policyname like 'probe\_0169%'
    union all
    select 'publication table', pt.pubname || ': ' || pt.schemaname || '.' || pt.tablename
      from pg_catalog.pg_publication_tables as pt
     where pt.schemaname = 'probe_0169'
    union all
    -- The bucket row, read only where Storage's table exists (it does on every hosted project).
    select 'bucket', 'storage.buckets: probe-0169'
     where case when pg_catalog.to_regclass('storage.buckets') is null then false else
             (pg_catalog.xpath('/row/n/text()', pg_catalog.query_to_xml(
                'select count(*) as n from storage.buckets where id = ''probe-0169''', false, true, '')))[1]::text::integer > 0
           end
    union all
    select 'relation', c.oid::regclass::text
      from pg_catalog.pg_class as c
      join pg_catalog.pg_namespace as n on n.oid = c.relnamespace
     where n.nspname = 'probe_0169'
  ) as leftover
 order by kind, name;

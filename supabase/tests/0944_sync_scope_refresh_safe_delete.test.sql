-- pgTAP: the sync scope refresh never issues an unqualified DELETE (0944), so pg_safeupdate under
-- PostgREST cannot refuse membership changes.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;

select plan(2);

select ok(
  pg_get_functiondef('private.refresh_sync_scope_grants(uuid)'::regprocedure) !~* 'delete\s+from\s+sync_scope_fresh\s*;',
  'the temp table is emptied with a qualified delete'
);

select lives_ok(
  $$select private.refresh_sync_scope_grants('01920000-0000-7000-8000-000000000101')$$,
  'a refresh runs'
);

select * from finish();
rollback;

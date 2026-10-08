-- pgTAP: identity core structure (Section 7.1 conventions, ADR 0002) and the generated
-- capability seed (0203).
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;

select plan(17);

select tables_are(
  'app',
  array[
    'capabilities', 'capability_modules', 'delegations', 'invites', 'membership_roles', 'memberships',
    'organizations', 'people', 'plans', 'record_grants', 'role_capabilities', 'roles',
    'subscription_state_transition_rules', 'subscription_state_transitions', 'subscriptions',
    'team_members', 'teams', 'user_capability_grants', 'workspace_members', 'workspaces'
  ],
  'app holds exactly the platform identity tables'
);

-- Every table and column in app carries a comment (Section 7.1).
select is(
  (select coalesce(string_agg(c.relname, ', '), '') from pg_class c
   join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'app' and c.relkind = 'r' and obj_description(c.oid, 'pg_class') is null),
  '',
  'every app table has a comment'
);
select is(
  (select coalesce(string_agg(c.relname || '.' || a.attname, ', '), '') from pg_attribute a
   join pg_class c on c.oid = a.attrelid
   join pg_namespace n on n.oid = c.relnamespace
   where n.nspname in ('app', 'private') and c.relkind = 'r' and a.attnum > 0 and not a.attisdropped
     and col_description(c.oid, a.attnum) is null),
  '',
  'every app and private column has a comment'
);

-- Every tenant table carries the ADR 0002 columns.
select is(
  (select coalesce(string_agg(t.table_name, ', '), '') from information_schema.tables t
   where t.table_schema = 'app' and t.table_type = 'BASE TABLE'
     and t.table_name not in ('capabilities', 'capability_modules', 'plans', 'subscription_state_transition_rules',
       'organizations', 'people')
     and (select count(*) from information_schema.columns c
          where c.table_schema = 'app' and c.table_name = t.table_name
            and c.column_name in ('org_id', 'created_at', 'created_by', 'updated_at', 'updated_by', 'deleted_at')) <> 6),
  '',
  'every tenant table has org_id and the audit columns'
);

-- Every foreign key has a supporting index whose leading column is the key column.
select is(
  (select coalesce(string_agg(c.conrelid::regclass::text || '(' || a.attname || ')', ', '), '')
   from pg_constraint c
   join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
   join pg_namespace n on n.oid = (select relnamespace from pg_class where oid = c.conrelid)
   where c.contype = 'f' and n.nspname in ('app', 'private')
     and not exists (
       select 1 from pg_index i where i.indrelid = c.conrelid and i.indkey[0] = c.conkey[1]
     )),
  '',
  'every foreign key has an index led by its column'
);

-- Row level security is on for every table in app and private.
select is(
  (select coalesce(string_agg(n.nspname || '.' || c.relname, ', '), '') from pg_class c
   join pg_namespace n on n.oid = c.relnamespace
   where n.nspname in ('app', 'private') and c.relkind = 'r' and not c.relrowsecurity),
  '',
  'row level security is enabled on every table'
);

-- Generated seed --------------------------------------------------------------------------
select is((select count(*)::integer from app.capability_modules), 28, '28 capability modules');
select is((select count(*)::integer from app.capabilities), 257, '257 capabilities');
select results_eq(
  'select code, band from app.roles where org_id is null order by band',
  $$values ('owner', 1::smallint), ('admin', 2::smallint), ('manager', 3::smallint), ('member', 4::smallint),
    ('collaborator', 5::smallint), ('field', 6::smallint), ('viewer', 7::smallint)$$,
  'seven system roles in band order'
);
select is((select count(*)::integer from app.role_capabilities), 987, '987 system role grants');
select is(
  (select count(*)::integer from app.role_capabilities rc join app.roles r on r.id = rc.role_id where r.code = 'owner'),
  (select count(*)::integer from app.capabilities),
  'the owner role holds every capability'
);
select ok(
  not exists (select 1 from app.role_capabilities rc join app.roles r on r.id = rc.role_id
              where r.code = 'admin' and rc.capability_code like 'org.billing.%'),
  'the admin role holds no billing capability'
);
select is(
  (select rc.reach from app.role_capabilities rc join app.roles r on r.id = rc.role_id
   where r.code = 'field' and rc.capability_code = 'crew.time_entry.write'),
  'own'::app.capability_reach,
  'field reaches only own time entries'
);
select ok(
  (select bool_and(rc.org_id is null) from app.role_capabilities rc join app.roles r on r.id = rc.role_id where r.org_id is null),
  'system role grants carry a null org_id'
);
select throws_ok(
  $$insert into app.capabilities (code, module_code, capability_class, description, sort_order)
    values ('finance.po', 'finance', 'read', 'Bad code.', 9999)$$,
  '23514', null,
  'capability codes need at least three segments'
);
select throws_ok(
  $$insert into app.capabilities (code, module_code, capability_class, description, sort_order)
    values ('crew.po.read', 'finance', 'read', 'Wrong module.', 9999)$$,
  '23514', null,
  'a capability code starts with its module'
);
select has_trigger('app', 'subscription_state_transitions', 't95_append_only', 'the subscription transition ledger is append-only');

select * from finish();
rollback;

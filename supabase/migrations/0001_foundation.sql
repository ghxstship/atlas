-- 0001_foundation.sql
-- Orchestrator-owned foundation (ADR 0002, ADR 0004): schemas, extensions and the UUID v7 generator.
-- Every later range (0100 canon, 0200 platform, 0300 domain, ...) builds on these objects.

-- Schemas ------------------------------------------------------------------

create schema if not exists xpms;
comment on schema xpms is 'XOS canon (XPMS 3.0 with the 4.0 grammar). Populated only by the canon importer; read-only to tenants.';

create schema if not exists app;
comment on schema app is 'Tenant operational data. Every table carries org_id and is protected by row level security.';

create schema if not exists api_public;
comment on schema api_public is 'Column-scoped read projections reachable by anon. No select * projection lives here.';

create schema if not exists api_external;
comment on schema api_external is 'Column-allowlisted projections for external users (Gateway and external Compass). Internal columns never appear here.';

create schema if not exists private;
comment on schema private is 'Internal helpers for RLS, plan limits and invariants. Never exposed through the API.';

-- Extensions (Section 5) -----------------------------------------------------
-- Relocatable extensions live in the extensions schema. pg_cron and supabase_vault
-- are not relocatable; their control files fix their schemas (ADR 0002).

create extension if not exists pgcrypto with schema extensions;
create extension if not exists pg_trgm with schema extensions;
create extension if not exists vector with schema extensions;
create extension if not exists ltree with schema extensions;
create extension if not exists postgis with schema extensions;
create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron;
create extension if not exists supabase_vault;

-- Privileges -----------------------------------------------------------------

revoke all on schema private from public, anon, authenticated;
revoke all on schema xpms, app, api_external from public, anon;

grant usage on schema xpms, app, api_external to authenticated, service_role;
grant usage on schema api_public to anon, authenticated, service_role;
grant usage on schema private to service_role;

-- UUID v7 (Section 7.1) --------------------------------------------------------
-- Postgres 17 has no native uuidv7(). This builds one from a random v4 UUID by
-- overwriting the first 48 bits with Unix epoch milliseconds and setting the
-- version nibble to 7. The variant bits from gen_random_uuid() are already RFC 9562.

create or replace function private.uuid_v7()
returns uuid
language sql
volatile
parallel safe
set search_path = ''
as $$
  select encode(
    set_bit(
      set_bit(
        overlay(
          uuid_send(gen_random_uuid())
          placing substring(int8send((extract(epoch from clock_timestamp()) * 1000)::bigint) from 3)
          from 1 for 6
        ),
        52, 1
      ),
      53, 1
    ),
    'hex'
  )::uuid;
$$;

comment on function private.uuid_v7() is 'Time-ordered UUID v7 (RFC 9562). Default primary key generator for every non-canon table.';

revoke all on function private.uuid_v7() from public, anon;
grant execute on function private.uuid_v7() to authenticated, service_role;

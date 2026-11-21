-- ADR 0169, work package 0: the direct-endpoint probe. Setup.
--
-- A person runs this file once on the STAGING database, runs 0169-direct-endpoint-probe.sh, and then runs
-- 0169-direct-endpoint-probe.teardown.sql. infra/db/probes/README.md has the steps. It is not a migration and it
-- never runs on production.
--
-- What it creates
--   In its own schema, probe_0169: five functions and one four-column table.
--   Outside that schema, because PostgREST, Storage and Realtime cannot be asked any other way:
--     1. api_public.probe_0169(text, text)   one function in an exposed schema, executable by authenticated only;
--     2. bucket "probe-0169"                 one row in storage.buckets, private, one-byte size limit. The Storage
--                                            API looks the bucket up before it evaluates a policy. It never
--                                            holds an object;
--     3. policy probe_0169_storage           on storage.objects, INSERT, to authenticated. It never admits a row;
--     4. policy probe_0169_realtime          on realtime.messages, SELECT, to authenticated. It admits only topics
--                                            that start with "probe-0169:", which carry no messages;
--     5. probe_0169.changes                  added to the supabase_realtime publication.
--   The teardown file removes all of it and counts what is left.
--
-- Why it is safe beside real data
--   * It reads no table of the application. The only rows it reads outside its own table are one auth.sessions
--     row by primary key (the caller's own session), its own storage.buckets row by primary key, and catalog rows.
--   * Both policies are permissive and guarded by CASE, so for every real bucket and every real topic they
--     evaluate to false without calling anything, and a permissive policy that is false changes no decision.
--   * Every lock is taken under lock_timeout. If a lock is not free within three seconds the whole file rolls
--     back and nothing is created; run it again.
--   * Nothing here returns or logs a token, an API key, a person's id or an email. Functions return header names,
--     the values of forwarding headers, claim names, and a 12-character fingerprint of the session id.
--
-- It can be run twice: every statement replaces or skips what exists.

begin;

set local lock_timeout = '3s';
set local statement_timeout = '30s';

create schema if not exists probe_0169;
comment on schema probe_0169 is 'ADR 0169 work package 0: throwaway probe objects. Remove with infra/db/probes/0169-direct-endpoint-probe.teardown.sql.';

revoke all on schema probe_0169 from public;
grant usage on schema probe_0169 to authenticated;

-- ------------------------------------------------------------------------------------------------------------
-- The request context a caller of this function can see, with secrets left out.
-- ------------------------------------------------------------------------------------------------------------
create or replace function probe_0169.context(p_surface text)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  -- Headers whose values say where a request came from. Only these values leave the database.
  c_address_headers constant text[] := array[
    'x-forwarded-for', 'x-real-ip', 'forwarded', 'cf-connecting-ip', 'true-client-ip', 'x-client-ip',
    'x-envoy-external-address', 'fly-client-ip', 'x-forwarded-host', 'x-forwarded-proto', 'x-forwarded-port',
    'via', 'x-xos-probe'
  ];
  v_headers jsonb;
  v_claims jsonb;
  v_session text;
  v_session_row boolean;
  v_lifetime numeric;
begin
  begin
    v_headers := nullif(pg_catalog.current_setting('request.headers', true), '')::jsonb;
  exception when others then
    v_headers := null;
  end;
  if pg_catalog.jsonb_typeof(v_headers) is distinct from 'object' then
    v_headers := null;
  end if;

  begin
    v_claims := nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb;
  exception when others then
    v_claims := null;
  end;
  if pg_catalog.jsonb_typeof(v_claims) is distinct from 'object' then
    v_claims := null;
  end if;

  v_session := v_claims ->> 'session_id';
  if v_session is not null then
    v_session_row := probe_0169.session_row_exists(v_session);
  end if;

  begin
    v_lifetime := (v_claims ->> 'exp')::numeric - (v_claims ->> 'iat')::numeric;
  exception when others then
    v_lifetime := null;
  end;

  return pg_catalog.jsonb_build_object(
    'surface', p_surface,
    'database_role', current_user,
    'request_method', nullif(pg_catalog.current_setting('request.method', true), ''),
    'request_path', nullif(pg_catalog.current_setting('request.path', true), ''),
    'headers_present', v_headers is not null,
    'header_names', coalesce(
      (select pg_catalog.jsonb_agg(k order by k) from pg_catalog.jsonb_object_keys(v_headers) as k),
      '[]'::jsonb),
    'address_headers', coalesce(
      (select pg_catalog.jsonb_object_agg(h, pg_catalog.left(v_headers ->> h, 600))
         from pg_catalog.unnest(c_address_headers) as h
        where v_headers ? h),
      '{}'::jsonb),
    'claims_present', v_claims is not null,
    'claim_names', coalesce(
      (select pg_catalog.jsonb_agg(k order by k) from pg_catalog.jsonb_object_keys(v_claims) as k),
      '[]'::jsonb),
    'claims', pg_catalog.jsonb_build_object(
      'role', v_claims ->> 'role',
      'aal', v_claims ->> 'aal',
      'iss', v_claims ->> 'iss',
      'aud', v_claims -> 'aud',
      'is_anonymous', v_claims -> 'is_anonymous',
      'lifetime_seconds', v_lifetime,
      'amr_methods', coalesce(
        (select pg_catalog.jsonb_agg(coalesce(a ->> 'method', a #>> '{}'))
           from pg_catalog.jsonb_array_elements(
                  case when pg_catalog.jsonb_typeof(v_claims -> 'amr') = 'array' then v_claims -> 'amr' else '[]'::jsonb end
                ) as a),
        '[]'::jsonb),
      'amr_has_timestamps', coalesce(
        (select pg_catalog.bool_and(pg_catalog.jsonb_typeof(a) = 'object' and a ? 'timestamp')
           from pg_catalog.jsonb_array_elements(
                  case when pg_catalog.jsonb_typeof(v_claims -> 'amr') = 'array' then v_claims -> 'amr' else '[]'::jsonb end
                ) as a),
        false),
      'sub_present', v_claims ? 'sub',
      'session_id_present', v_session is not null,
      'session_id_fingerprint', case when v_session is null then null else
        pg_catalog.left(pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(v_session, 'UTF8')), 'hex'), 12) end,
      'session_row_exists', v_session_row,
      'client_id_present', v_claims ? 'client_id',
      'client_id_fingerprint', case when v_claims ? 'client_id' then
        pg_catalog.left(pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(v_claims ->> 'client_id', 'UTF8')), 'hex'), 12) end,
      'app_metadata_names', coalesce(
        (select pg_catalog.jsonb_agg(k order by k)
           from pg_catalog.jsonb_object_keys(
                  case when pg_catalog.jsonb_typeof(v_claims -> 'app_metadata') = 'object' then v_claims -> 'app_metadata' else '{}'::jsonb end
                ) as k),
        '[]'::jsonb)
    )
  );
end;
$$;

comment on function probe_0169.context(text) is 'ADR 0169 probe: header names, forwarding header values and claim names of the current request. No token, key, person id or email.';

-- Whether the caller's own session row exists. One primary-key lookup; null when the id is not a uuid or the
-- owner of this function cannot read auth.sessions.
create or replace function probe_0169.session_row_exists(p_session_id text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if p_session_id is distinct from (nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb ->> 'session_id') then
    return null;
  end if;
  v_id := p_session_id::uuid;
  return exists (select 1 from auth.sessions as s where s.id = v_id);
exception when others then
  return null;
end;
$$;

comment on function probe_0169.session_row_exists(text) is 'ADR 0169 probe: whether the session the current token names has a row in auth.sessions. Answers only for the caller''s own session.';

-- ------------------------------------------------------------------------------------------------------------
-- The yes or no questions a policy can be asked. A policy has no way to return a value, so the script asks one
-- question per object name, topic or row, and reads the answer from whether the policy admitted it.
--
--   open                    always yes (the policy is installed and was evaluated)
--   closed                  always no
--   headers                 request.headers is set to a JSON object
--   header:<name>           that header is present
--   is:<name>:<value>       that address header has exactly that value
--   xff:<n>:<address>       the entry n places from the right of X-Forwarded-For is that address
--   claims                  request.jwt.claims is set to a JSON object
--   claim:<name>            that claim is present
--
-- Each evaluation writes one Postgres log line that starts with "probe_0169", with the context() of the request.
-- ------------------------------------------------------------------------------------------------------------
create or replace function probe_0169.answer(p_surface text, p_question text)
returns boolean
language plpgsql
stable
set search_path = ''
as $$
declare
  v_headers jsonb;
  v_claims jsonb;
  v_parts text[];
  v_chain text[];
  v_place integer;
  v_answer boolean := false;
begin
  if p_question is null or p_question !~ '^[a-z0-9:._-]{1,120}$' then
    return false;
  end if;

  begin
    v_headers := nullif(pg_catalog.current_setting('request.headers', true), '')::jsonb;
  exception when others then
    v_headers := null;
  end;
  if pg_catalog.jsonb_typeof(v_headers) is distinct from 'object' then
    v_headers := null;
  end if;
  begin
    v_claims := nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb;
  exception when others then
    v_claims := null;
  end;
  if pg_catalog.jsonb_typeof(v_claims) is distinct from 'object' then
    v_claims := null;
  end if;

  if p_question = 'open' then
    v_answer := true;
  elsif p_question = 'closed' then
    v_answer := false;
  elsif p_question = 'headers' then
    v_answer := v_headers is not null;
  elsif p_question = 'claims' then
    v_answer := v_claims is not null;
  elsif p_question ~ '^header:[a-z0-9-]+$' then
    v_answer := coalesce(v_headers ? pg_catalog.substr(p_question, 8), false);
  elsif p_question ~ '^claim:[a-z0-9_]+$' then
    v_answer := coalesce(v_claims ? pg_catalog.substr(p_question, 7), false);
  elsif p_question ~ '^is:(x-forwarded-for|x-real-ip|cf-connecting-ip|true-client-ip|x-client-ip|fly-client-ip|x-envoy-external-address):[0-9a-f:.]+$' then
    v_parts := pg_catalog.regexp_match(p_question, '^is:([a-z-]+):([0-9a-f:.]+)$');
    v_answer := coalesce(pg_catalog.btrim(v_headers ->> v_parts[1]) = v_parts[2], false);
  elsif p_question ~ '^xff:[0-9]:[0-9a-f:.]+$' then
    v_parts := pg_catalog.regexp_match(p_question, '^xff:([0-9]):([0-9a-f:.]+)$');
    v_chain := pg_catalog.string_to_array(coalesce(v_headers ->> 'x-forwarded-for', ''), ',');
    v_place := coalesce(pg_catalog.array_length(v_chain, 1), 0) - v_parts[1]::integer;
    if v_place >= 1 then
      v_answer := pg_catalog.btrim(v_chain[v_place]) = v_parts[2];
    end if;
  else
    return false;
  end if;

  raise log 'probe_0169 surface=% question=% answer=% context=%', p_surface, p_question, v_answer, probe_0169.context(p_surface);
  return v_answer;
end;
$$;

comment on function probe_0169.answer(text, text) is 'ADR 0169 probe: one yes or no fact about the request context a policy is evaluated in.';

-- Storage. A yes must not store an object, so a yes is raised as a duplicate (SQLSTATE 23505, which the Storage
-- API answers with HTTP 409) and a no returns false (a row-level security refusal). No path returns true.
create or replace function probe_0169.storage_answer(p_name text)
returns boolean
language plpgsql
stable
set search_path = ''
as $$
begin
  if probe_0169.answer('storage', p_name) then
    raise exception using errcode = '23505', message = 'probe_0169: yes';
  end if;
  return false;
end;
$$;

comment on function probe_0169.storage_answer(text) is 'ADR 0169 probe: answers a question inside a storage.objects policy without ever admitting the object.';

-- ------------------------------------------------------------------------------------------------------------
-- Realtime Postgres Changes: rows that each carry one question. Realtime delivers a row to a subscriber only
-- when the select policy admits it, in whatever request context Realtime gives that evaluation.
-- ------------------------------------------------------------------------------------------------------------
create table if not exists probe_0169.changes (
  id bigint generated always as identity primary key,
  run text not null check (run ~ '^[a-z0-9]{8,40}$'),
  question text not null,
  created_at timestamptz not null default pg_catalog.now()
);

comment on table probe_0169.changes is 'ADR 0169 probe: one row per question, written by api_public.probe_0169 and read only through Realtime.';

alter table probe_0169.changes enable row level security;
revoke all on table probe_0169.changes from public, anon, authenticated;
grant select on table probe_0169.changes to authenticated;

drop policy if exists probe_0169_changes on probe_0169.changes;
create policy probe_0169_changes on probe_0169.changes
  for select to authenticated
  using (probe_0169.answer('changes', question));

create or replace function probe_0169.emit(p_run text)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_rows integer;
begin
  if p_run is null or p_run !~ '^[a-z0-9]{8,40}$' then
    raise exception 'probe_0169: the run id is 8 to 40 lowercase letters and digits';
  end if;
  -- A ceiling, so a signed-in person on staging cannot grow the table. The table holds a few dozen rows.
  if (select pg_catalog.count(*) from probe_0169.changes) >= 400 then
    raise exception 'probe_0169: the probe table is full; run the teardown and the setup again';
  end if;
  insert into probe_0169.changes (run, question)
  select p_run, q
    from pg_catalog.unnest(array[
      'open', 'closed', 'headers', 'header:x-forwarded-for', 'header:x-real-ip',
      'claims', 'claim:session_id', 'claim:aal', 'claim:amr'
    ]) as q;
  get diagnostics v_rows = row_count;
  return v_rows;
end;
$$;

comment on function probe_0169.emit(text) is 'ADR 0169 probe: writes one row per question for Realtime Postgres Changes to deliver or withhold.';

revoke all on function probe_0169.context(text) from public;
revoke all on function probe_0169.session_row_exists(text) from public;
revoke all on function probe_0169.answer(text, text) from public;
revoke all on function probe_0169.storage_answer(text) from public;
revoke all on function probe_0169.emit(text) from public;
grant execute on function probe_0169.context(text) to authenticated;
grant execute on function probe_0169.session_row_exists(text) to authenticated;
grant execute on function probe_0169.answer(text, text) to authenticated;
grant execute on function probe_0169.storage_answer(text) to authenticated;
grant execute on function probe_0169.emit(text) to authenticated;

-- ------------------------------------------------------------------------------------------------------------
-- Outside the schema, 1 of 5: the one function PostgREST can reach.
--   mode "echo"    returns context('rest');
--   mode "refuse"  raises SQLSTATE PGRST the way gate.pre_request will: HTTP 401, code XS401, a reason as hint;
--   mode "emit"    writes the Postgres Changes rows for one run.
-- ------------------------------------------------------------------------------------------------------------
do $$
begin
  if pg_catalog.to_regnamespace('api_public') is null then
    raise exception 'probe_0169: schema api_public does not exist. This file is for the XOS staging database.';
  end if;
end;
$$;

create or replace function api_public.probe_0169(mode text default 'echo', run text default null)
returns jsonb
language plpgsql
volatile
set search_path = ''
as $$
begin
  if mode = 'echo' then
    return probe_0169.context('rest');
  elsif mode = 'refuse' then
    raise sqlstate 'PGRST' using
      message = '{"code":"XS401","message":"The session is refused.","details":"ADR 0169 probe","hint":"session_ended"}',
      detail = '{"status":401,"headers":{"X-Xos-Probe-Refusal":"XS401"}}';
  elsif mode = 'emit' then
    return pg_catalog.jsonb_build_object('rows', probe_0169.emit(run));
  end if;
  raise exception 'probe_0169: mode is echo, refuse or emit';
end;
$$;

comment on function api_public.probe_0169(text, text) is 'ADR 0169 work package 0: throwaway probe. Remove with infra/db/probes/0169-direct-endpoint-probe.teardown.sql.';

revoke all on function api_public.probe_0169(text, text) from public, anon, service_role;
grant execute on function api_public.probe_0169(text, text) to authenticated;

-- ------------------------------------------------------------------------------------------------------------
-- Outside the schema, 2 and 3 of 5: Storage. The Storage API looks the bucket up, then tests an upload by
-- inserting the object row as the caller. For bucket "probe-0169" the check asks the question in the object name
-- and never admits the row, so the bucket stays empty. For every other bucket the CASE is false and nothing is
-- called.
-- ------------------------------------------------------------------------------------------------------------
do $$
begin
  if pg_catalog.to_regclass('storage.objects') is null or pg_catalog.to_regclass('storage.buckets') is null then
    raise notice 'probe_0169: storage.objects does not exist here; the Storage questions stay unanswered.';
    return;
  end if;
  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('probe-0169', 'probe-0169', false, 1, array['text/plain'])
  on conflict do nothing;
  drop policy if exists probe_0169_storage on storage.objects;
  create policy probe_0169_storage on storage.objects
    for insert to authenticated
    with check (case when bucket_id = 'probe-0169' then probe_0169.storage_answer(name) else false end);
end;
$$;

-- ------------------------------------------------------------------------------------------------------------
-- Outside the schema, 4 of 5: Realtime channel joins. Realtime tests a private channel join by reading one
-- message row for the topic as the caller. Topics "probe-0169:<question>" are admitted when the answer is yes.
-- For every other topic the CASE is false and nothing is called.
-- ------------------------------------------------------------------------------------------------------------
do $$
begin
  if pg_catalog.to_regclass('realtime.messages') is null then
    raise notice 'probe_0169: realtime.messages does not exist here; the channel-join questions stay unanswered.';
    return;
  end if;
  drop policy if exists probe_0169_realtime on realtime.messages;
  create policy probe_0169_realtime on realtime.messages
    for select to authenticated
    using (case when topic like 'probe-0169:%' then probe_0169.answer('realtime', pg_catalog.substr(topic, 12)) else false end);
end;
$$;

-- ------------------------------------------------------------------------------------------------------------
-- Outside the schema, 5 of 5: publication membership, so Realtime Postgres Changes sees the probe table.
-- ------------------------------------------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_catalog.pg_publication where pubname = 'supabase_realtime') then
    raise notice 'probe_0169: publication supabase_realtime does not exist here; the Postgres Changes questions stay unanswered.';
    return;
  end if;
  if not exists (
    select 1 from pg_catalog.pg_publication_tables
     where pubname = 'supabase_realtime' and schemaname = 'probe_0169' and tablename = 'changes'
  ) then
    alter publication supabase_realtime add table probe_0169.changes;
  end if;
end;
$$;

commit;

-- PostgREST learns about the new function from this. Hosted Supabase also sends it on its own after DDL.
notify pgrst, 'reload schema';

-- What was installed. Seven rows, each "present".
select item, case when present then 'present' else 'MISSING' end as state
  from (values
    ('schema probe_0169', pg_catalog.to_regnamespace('probe_0169') is not null),
    ('function api_public.probe_0169(text, text)', pg_catalog.to_regprocedure('api_public.probe_0169(text, text)') is not null),
    ('table probe_0169.changes', pg_catalog.to_regclass('probe_0169.changes') is not null),
    ('bucket probe-0169 in storage.buckets',
        case when pg_catalog.to_regclass('storage.buckets') is null then false else
          (pg_catalog.xpath('/row/n/text()', pg_catalog.query_to_xml(
             'select count(*) as n from storage.buckets where id = ''probe-0169''', false, true, '')))[1]::text::integer > 0
        end),
    ('policy probe_0169_storage on storage.objects', exists (
        select 1 from pg_catalog.pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'probe_0169_storage')),
    ('policy probe_0169_realtime on realtime.messages', exists (
        select 1 from pg_catalog.pg_policies where schemaname = 'realtime' and tablename = 'messages' and policyname = 'probe_0169_realtime')),
    ('probe_0169.changes in publication supabase_realtime', exists (
        select 1 from pg_catalog.pg_publication_tables
         where pubname = 'supabase_realtime' and schemaname = 'probe_0169' and tablename = 'changes'))
  ) as t (item, present)
 order by item;

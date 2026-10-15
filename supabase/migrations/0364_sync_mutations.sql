-- 0364_sync_mutations.sql
-- A03 Domain Data (requested by A17 Compass). The sync replay ledger for offline-first clients
-- (Section 13): every mutation a Compass device uploads carries a client-generated id, and replaying the
-- same id returns the stored result instead of running the RPC again.
--   * app.sync_mutations: one row per applied client mutation id, readable only by the person who sent it
--   * private.sync_rpcs: the RPCs a device may call through the wrapper; each module adds its own rows
--   * app.apply_sync_mutation: the wrapper. It serializes on the mutation id, returns the stored result
--     of a known id, or calls the allowlisted RPC with named arguments from a JSON object, stores the
--     result and returns it. A refusal (XR001) is stored and returned as a result too, so a replay of a
--     refused mutation answers the same refusal without re-running; any other error rolls back and is
--     raised, leaving the id free for a retry.
-- External people (engagements, 0700) are added to the org check from the late slot (0940 to 0949).

create table private.sync_rpcs (
  rpc text primary key,
  description text not null,
  constraint sync_rpcs_rpc_format check (rpc ~ '^app\.[a-z][a-z0-9_]*$'),
  constraint sync_rpcs_description_length check (char_length(btrim(description)) between 1 and 300)
);

comment on table private.sync_rpcs is 'RPCs an offline device may replay through app.apply_sync_mutation. Each module inserts the RPCs its Compass screens queue offline.';
comment on column private.sync_rpcs.rpc is 'Schema-qualified RPC name in app; it has exactly one signature.';
comment on column private.sync_rpcs.description is 'What the device does with it.';

alter table private.sync_rpcs enable row level security;
revoke all on private.sync_rpcs from public, anon, authenticated;
grant select on private.sync_rpcs to service_role;

insert into private.sync_rpcs (rpc, description) values
  ('app.record_medical_encounter', 'A field medic records a medical encounter at an incident.'),
  ('app.update_medical_encounter', 'A field medic updates a medical encounter.'),
  ('app.sign_agreement', 'A crew member signs an agreement while signed in.');

create view app.sync_rpcs as
select r.rpc, r.description from private.sync_rpcs r;
call private.describe('app.sync_rpcs', 'RPCs an offline device may replay through app.apply_sync_mutation.', array[
  'rpc', 'RPC name.', 'description', 'What the device does with it.']);
revoke all on app.sync_rpcs from public, anon;
grant select on app.sync_rpcs to authenticated, service_role;

create table app.sync_mutations (
  id uuid primary key,
  org_id uuid not null references app.organizations (id),
  person_id uuid not null references app.people (id),
  device_id text not null,
  rpc text not null references private.sync_rpcs (rpc),
  applied_at timestamptz not null default now(),
  result jsonb not null,
  constraint sync_mutations_device_id_length check (char_length(btrim(device_id)) between 1 and 200)
);

create index sync_mutations_person_id_idx on app.sync_mutations (person_id, applied_at);
create index sync_mutations_rpc_idx on app.sync_mutations (rpc);

call private.install_domain_table('app.sync_mutations', null, null, '{}', true);
call private.describe('app.sync_mutations', 'Append-only replay ledger of mutations applied for offline devices (Section 13). The id is the client mutation id: a replay returns the stored result and never runs the RPC twice. Each person reads only their own rows; rows are written only by app.apply_sync_mutation.', array[
  'id', 'Client-generated mutation id, unique across every device and person.',
  'org_id', 'Org the mutation acted in.',
  'person_id', 'Person whose device sent the mutation.',
  'device_id', 'Device identifier the client reports.',
  'rpc', 'RPC that was called.',
  'applied_at', 'When the mutation was first applied.',
  'result', 'Stored result returned to every replay: {"data": ...} on success or {"refusal": {"rule", "message"}} when refused. A provider payload for the client, an allowed JSON column.'
]);

call private.install_policies('app.sync_mutations',
  $$person_id = (select private.current_person_id())$$);

create or replace function private.sync_call(p_rpc text, p_args jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_proc oid;
  v_call text;
  v_result jsonb;
  v_retset boolean;
begin
  select p.oid, p.proretset into v_proc, v_retset
  from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  where n.nspname = split_part(p_rpc, '.', 1) and p.proname = split_part(p_rpc, '.', 2);
  if v_proc is null or (select count(*) from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
                        where n.nspname = split_part(p_rpc, '.', 1) and p.proname = split_part(p_rpc, '.', 2)) <> 1 then
    perform private.refuse('sync_rpc_unknown', format('%s is not a single-signature RPC.', p_rpc));
  end if;
  if exists (select 1 from jsonb_object_keys(coalesce(p_args, '{}'::jsonb)) k
             where k not in (select a.name from unnest((select p.proargnames from pg_catalog.pg_proc p where p.oid = v_proc)) a(name))) then
    perform private.refuse('sync_argument_unknown', format('The arguments name a parameter %s does not take.', p_rpc));
  end if;
  select string_agg(format('%I => ($1 ->> %L)::%s', a.name, a.name, pg_catalog.format_type(a.type, null)), ', ' order by a.ord)
  into v_call
  from unnest((select p.proargnames from pg_catalog.pg_proc p where p.oid = v_proc),
              (select p.proargtypes::oid[] from pg_catalog.pg_proc p where p.oid = v_proc)) with ordinality a(name, type, ord)
  where coalesce(p_args, '{}'::jsonb) ? a.name;
  if v_retset then
    execute format('select coalesce(jsonb_agg(to_jsonb(r)), ''[]''::jsonb) from %s(%s) r', p_rpc, coalesce(v_call, '')) into v_result using p_args;
  else
    execute format('select to_jsonb(%s(%s))', p_rpc, coalesce(v_call, '')) into v_result using p_args;
  end if;
  return v_result;
end;
$$;

comment on function private.sync_call(text, jsonb) is 'Calls an app RPC with named arguments taken from a JSON object (text values cast to each parameter type; omitted parameters take their defaults) and returns its result as JSON. The RPC runs its own authorization against the session.';
revoke all on function private.sync_call(text, jsonb) from public, anon, authenticated;

create or replace function app.apply_sync_mutation(p_mutation_id uuid, p_org_id uuid, p_device_id text, p_rpc text, p_args jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
  v_stored app.sync_mutations;
  v_result jsonb;
  v_rule text;
  v_message text;
begin
  if p_mutation_id is null then
    perform private.refuse('sync_mutation_id_required', 'Every offline mutation carries its client mutation id.');
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('sync_mutation:' || p_mutation_id::text, 0));
  select * into v_stored from app.sync_mutations m where m.id = p_mutation_id;
  if v_stored.id is not null then
    if v_stored.person_id <> v_person or v_stored.rpc <> p_rpc then
      perform private.refuse('sync_mutation_conflict', 'This mutation id was already used for another mutation; generate a new id.');
    end if;
    return v_stored.result;
  end if;
  if p_org_id is null or p_org_id not in (select private.my_org_ids()) then
    raise exception using errcode = '42501', message = 'the device acts only in an org the person belongs to';
  end if;
  if not exists (select 1 from private.sync_rpcs r where r.rpc = p_rpc) then
    perform private.refuse('sync_rpc_not_allowed', format('%s cannot be replayed from a device.', coalesce(p_rpc, 'This RPC')));
  end if;
  begin
    v_result := jsonb_build_object('data', private.sync_call(p_rpc, p_args));
  exception when sqlstate 'XR001' then
    get stacked diagnostics v_rule = pg_exception_hint, v_message = message_text;
    v_result := jsonb_build_object('refusal', jsonb_build_object('rule', v_rule, 'message', v_message));
  end;
  insert into app.sync_mutations (id, org_id, person_id, device_id, rpc, result)
  values (p_mutation_id, p_org_id, v_person, btrim(coalesce(p_device_id, '')), p_rpc, v_result);
  return v_result;
end;
$$;

comment on function app.apply_sync_mutation(uuid, uuid, text, text, jsonb) is 'Applies one offline mutation exactly once (Section 13). A known mutation id returns its stored result without running again; a new id calls the allowlisted RPC (private.sync_rpcs) with named arguments from p_args, stores {"data": result} or, when the RPC refuses, {"refusal": {"rule", "message"}}, and returns it. Other errors roll back and raise, so the client retries with the same id. An id reused by another person or for another RPC is refused.';

revoke all on function app.apply_sync_mutation(uuid, uuid, text, text, jsonb) from public, anon;
grant execute on function app.apply_sync_mutation(uuid, uuid, text, text, jsonb) to authenticated, service_role;

-- pgTAP: migration 1295, finding A69-001 (RRR-114). PostgREST runs a GET call in a read-only transaction. Every volatile
-- api_public RPC now refuses that before it looks anything up, with one fixed message, so a GET can neither skip the
-- failed-attempt count nor tell a right access code from a wrong one. The catalog part covers every volatile api_public
-- function, including ones added later. Also: the access-code lockout still counts and locks through POST, and the
-- resolvers lock the token row.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(13);

-- Calls an api_public function with NULL for every argument inside a read-only subtransaction, as anon, and answers the
-- error it raised ('' when it raised nothing). The subtransaction always rolls back.
create function pg_temp.read_only_outcome(p_fn regprocedure) returns text
language plpgsql as $$
declare
  v_args text;
  v_name text := (select proname from pg_proc where oid = p_fn);
  v_outcome text := '';
begin
  select coalesce(string_agg(format('null::%s', t::regtype), ', ' order by o), '') into v_args
  from pg_proc p, unnest(p.proargtypes::oid[]) with ordinality as a (t, o)
  where p.oid = p_fn;
  begin
    perform set_config('request.jwt.claims', '{"role":"anon"}', true);
    perform set_config('role', 'anon', true);
    perform set_config('transaction_read_only', 'on', true);
    execute format('select * from api_public.%I(%s)', v_name, v_args);
    raise exception using errcode = 'ZZ001', message = 'no error';
  exception
    when sqlstate 'ZZ001' then v_outcome := '';
    when others then v_outcome := sqlstate || ' ' || sqlerrm;
  end;
  return v_outcome;
end $$;

-- Volatile api_public functions that a read-only call does not refuse. record_cookie_consent checks no secret: it
-- only logs a consent choice, which a read-only call cannot write.
select is_empty($$
  select p.oid::regprocedure::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'api_public' and p.provolatile = 'v' and p.proname <> 'record_cookie_consent'
    and pg_temp.read_only_outcome(p.oid::regprocedure) <> '25006 this call changes data: send it with POST'
$$, 'every volatile api_public RPC refuses a read-only (GET) call before looking anything up');

select cmp_ok((select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'api_public' and p.provolatile = 'v'), '>=', 9, 'the check covers at least the nine token and code RPCs');

select is(pg_temp.read_only_outcome('api_public.preview_advance(text, text)'::regprocedure),
  '25006 this call changes data: send it with POST', 'preview_advance refuses GET');
select is(pg_temp.read_only_outcome('api_public.token_document(text, text)'::regprocedure),
  '25006 this call changes data: send it with POST', 'token_document refuses GET');
select is(pg_temp.read_only_outcome('api_public.verify_certification(text)'::regprocedure),
  '25006 this call changes data: send it with POST', 'verify_certification refuses GET');

-- A link with a known code, on the suite's own packet (0300 world), so it runs without the demo seed (A71, RRR-116).
-- The read-only refusal happens before the token is read, so a GET with a wrong code counts nothing and a GET with the
-- right code returns nothing.
select pg_temp.as_user('dave');
with x as (insert into app.advance_packets (project_id, title) values (pg_temp.id('prj_a'), 'Headliner Advance') returning id)
insert into world select 'pkt', id from x;
insert into app.advance_sections (advance_packet_id, position, title, prompt)
  values (pg_temp.id('pkt'), 1, 'Arrival', 'When does the party arrive, and how many travel?');
with x as (insert into app.advance_recipients (advance_packet_id, person_id) values (pg_temp.id('pkt'), pg_temp.id('mia')) returning id)
insert into world select 'rcp', id from x;
select app.send_advance_packet(pg_temp.id('pkt'));
select pg_temp.as_platform();
insert into app.advance_recipient_tokens (advance_recipient_id, recipient_email, token_hash, access_code_hash, expires_at)
values (pg_temp.id('rcp'), 'a69-probe@example.test', private.advance_token_hash('xadv_a69test'),
  private.advance_code_hash('xadv_a69test', '424242'), now() + interval '1 day');

create function pg_temp.preview(p_code text, p_read_only boolean) returns text
language plpgsql as $$
declare
  v_reason text;
begin
  begin
    perform set_config('request.jwt.claims', '{"role":"anon"}', true);
    perform set_config('role', 'anon', true);
    if p_read_only then
      perform set_config('transaction_read_only', 'on', true);
    end if;
    select coalesce(reason, 'ok') into v_reason from api_public.preview_advance('xadv_a69test', p_code) limit 1;
    raise exception using errcode = 'ZZ002', message = v_reason;
  exception
    when sqlstate 'ZZ002' then return sqlerrm;
    when others then return sqlstate;
  end;
end $$;

select is(pg_temp.preview('000001', true), '25006', 'a wrong code through GET is refused before it is checked');
select is(pg_temp.preview('424242', true), '25006', 'the right code through GET is refused the same way');
select is((select failed_attempts from app.advance_recipient_tokens where token_hash = private.advance_token_hash('xadv_a69test')),
  0::smallint, 'a refused GET leaves the counter alone');

-- Through POST (read-write) the lockout works as designed.
select is(pg_temp.preview('424242', false), 'ok', 'the right code through POST opens the packet');
set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
do $$
begin
  for i in 1 .. 4 loop
    perform * from api_public.preview_advance('xadv_a69test', lpad(i::text, 6, '0'));
  end loop;
end $$;
select is((select reason from api_public.preview_advance('xadv_a69test', '000005') limit 1), 'advance_token_locked',
  'the fifth wrong code through POST locks the link');
select is((select reason from api_public.preview_advance('xadv_a69test', '424242') limit 1), 'advance_token_locked',
  'a locked link refuses even the right code');
reset role;

-- The resolvers lock the token row before comparing, so parallel guesses wait for each other.
select ok(pg_get_functiondef('private.resolve_advance_token(text, text)'::regprocedure) ~* 'token_hash\(p_token\)\s+for update',
  'the advance resolver locks the token row');
select ok(pg_get_functiondef('private.resolve_document_token(text, text)'::regprocedure) ~* 'token_hash\(p_token\)\s+for update',
  'the document resolver locks the token row');

select * from finish();
rollback;

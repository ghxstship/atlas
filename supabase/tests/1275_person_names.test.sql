-- pgTAP: app.person_names (migration 1275, finding A59-011). Members of an org read the names of the
-- external people it engages, as Pipeline does, and of their fellow members; a person outside every one
-- of the reader's orgs stays unnamed, and anonymous callers cannot call it at all.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;

select plan(6);

create function pg_temp.as_person(p_user uuid) returns void
language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;

-- A person no demo org knows.
insert into app.people (id, full_name) values ('01920000-0000-7000-8000-00000a610001', 'Stranger A61');

-- The demo Owner (Demo Productions) and the demo Crew Member, engaged by Demo Productions.
select pg_temp.as_person('01920000-0000-7000-8000-000000000101');
select is(
  (select full_name from app.person_names(array['01920000-0000-7000-8000-000000000201'::uuid])),
  'Demo Crew Member', 'an org member reads the name of a person the org engages');
select is(
  (select full_name from app.person_names(array['01920000-0000-7000-8000-000000000103'::uuid])),
  'Demo Producer', 'and of a fellow member');
select is(
  (select count(*)::integer from app.person_names(array['01920000-0000-7000-8000-00000a610001'::uuid])),
  0, 'a person outside the reader''s network stays unnamed');
select is(
  (select count(*)::integer from app.person_names(array[
    '01920000-0000-7000-8000-000000000201'::uuid, '01920000-0000-7000-8000-000000000103'::uuid])),
  2, 'several names come back in one call');

-- The partner Owner shares no org with the crew member.
select pg_temp.as_person('01920000-0000-7000-8000-000010600101');
select is(
  (select count(*)::integer from app.person_names(array['01920000-0000-7000-8000-000000000201'::uuid])),
  0, 'another org''s member reads no name');

reset role;
select is(has_function_privilege('anon', 'app.person_names(uuid[])', 'execute'), false,
  'anonymous callers cannot read names');

select * from finish();
rollback;

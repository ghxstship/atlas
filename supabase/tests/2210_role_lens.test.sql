-- pgTAP: the role lens (Section 4.8.1, A128, ADR 0107). A member narrows to one role they hold: the lens lists that
-- role's capabilities capped at the member's own reach, never one they lack, and refuses a role they do not hold.
-- Mia is a Member and a Field user of Northwind Live and a Viewer of Harbor Lights (0200_identity_world.psql).
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(13);

select pg_temp.as_user('mia');
select ok((select count(*) from app.role_lens_capabilities(pg_temp.id('org_a'), pg_temp.system_role('field'))) > 0,
  'a Member and Field user narrows to the Field role');
select ok((select count(*) from app.role_lens_capabilities(pg_temp.id('org_a'), pg_temp.system_role('member'))) > 0,
  'and to the Member role');
select is((select count(*)::int from app.role_lens_capabilities(pg_temp.id('org_a'), pg_temp.system_role('field'))
           where lens_reach > viewer_reach or lens_reach > role_reach), 0,
  'no capability under the lens exceeds the role''s reach or the member''s own');
-- The member's own reach, read with the private helper under their claims.
select pg_temp.claims('mia');
select is((select count(*)::int from app.role_lens_capabilities(pg_temp.id('org_a'), pg_temp.system_role('field')) l
           where private.person_capability_reach(pg_temp.id('mia'), pg_temp.id('org_a'), l.capability_code, true) is null), 0,
  'every capability under the lens is one the member holds');
select pg_temp.as_user('mia');
select is((select count(*)::int from app.role_lens_capabilities(pg_temp.id('org_a'), pg_temp.system_role('field'))),
  (select count(*)::int from app.role_capabilities rc where rc.role_id = pg_temp.system_role('field') and rc.deleted_at is null),
  'a role the member holds keeps every one of its capabilities');
select ok((select count(*) from app.role_lens_capabilities(pg_temp.id('org_a'), pg_temp.system_role('field')) f
           where not exists (select 1 from app.role_capabilities rc where rc.role_id = pg_temp.system_role('field')
                             and rc.capability_code = f.capability_code and rc.deleted_at is null)) = 0,
  'the Field lens adds nothing the Field role lacks, though the member also holds the Member role');
-- A Field capability Mia holds more widely than the Field role gives it, by a direct grant from Bob, an Admin who holds
-- it org-wide, so the next two tests always have a row to check.
select pg_temp.as_user('bob');
insert into app.user_capability_grants (membership_id, capability_code, reason)
select pg_temp.id('mia@org_a'), rc.capability_code, 'Covers the gate during the festival.'
from app.role_capabilities rc
where rc.role_id = pg_temp.system_role('field') and rc.deleted_at is null and rc.reach <> 'organization'
  and exists (select 1 from app.role_capabilities a where a.role_id = pg_temp.system_role('admin')
              and a.capability_code = rc.capability_code and a.reach = 'organization' and a.deleted_at is null)
order by rc.capability_code limit 1;
select pg_temp.as_user('mia');
select ok((select count(*) from app.role_lens_capabilities(pg_temp.id('org_a'), pg_temp.system_role('field')) l
           join app.role_capabilities rc on rc.role_id = pg_temp.system_role('field') and rc.capability_code = l.capability_code
             and rc.deleted_at is null
           where rc.reach < l.viewer_reach) > 0,
  'the member holds a Field capability more widely than the Field role gives it');
select is((select count(*)::int from app.role_lens_capabilities(pg_temp.id('org_a'), pg_temp.system_role('field')) l
           join app.role_capabilities rc on rc.role_id = pg_temp.system_role('field') and rc.capability_code = l.capability_code
             and rc.deleted_at is null
           where rc.reach < l.viewer_reach and l.lens_reach <> rc.reach), 0,
  'each capability the member holds more widely through another source shows at the lens role''s reach');
select throws_ok($$select * from app.role_lens_capabilities(pg_temp.id('org_a'), pg_temp.system_role('owner'))$$,
  'XR001', 'role_lens_role_not_held: Choose one of the roles you hold in this organization.',
  'a role the member does not hold is refused');
select throws_ok($$select * from app.role_lens_capabilities(pg_temp.id('org_b'), pg_temp.system_role('field'))$$,
  'XR001', 'role_lens_role_not_held: Choose one of the roles you hold in this organization.',
  'a role the member holds in one org is refused in another where they hold a different role');
select pg_temp.as_user('xavier');
select throws_ok($$select * from app.role_lens_capabilities(pg_temp.id('org_a'), pg_temp.system_role('member'))$$,
  'XR001', 'role_lens_role_not_held: Choose one of the roles you hold in this organization.',
  'another org''s Owner cannot narrow to a role of an org they do not belong to');
select pg_temp.as_anon();
select throws_ok($$select * from app.role_lens_capabilities(gen_random_uuid(), gen_random_uuid())$$, '42501', null,
  'anon cannot ask');
select pg_temp.as_platform();
select is(has_function_privilege('authenticated', 'app.role_lens_capabilities(uuid, uuid)', 'execute'), true,
  'signed-in people may call it');

select * from finish();
rollback;

-- pgTAP: migrations 2620 to 2625 (R3, owner decision 7), org and project offerings. A fresh engagement resolves every
-- offering Not Offered from the Default; an org value of each of the nine settings answers Provided; a project value
-- overrides it; a locked org value beats rules and project values; audience rules by role type, vendor class and
-- project, with caps; vendor class entitlements; private.assert_offered; who may call app.effective_offerings; the
-- api_external.engagement_offerings view and its time box; the offering_rules policies and constraints; the backfill;
-- the per diem writer's and the table's offering check; and the private functions stay closed to signed-in callers.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

select * from no_plan();

-- How one offering resolves on an engagement, as mode/source.
create function pg_temp.resolved(p_engagement text, p_offering text) returns text
language sql as $$
  select o.offering_mode::text || '/' || o.source
  from private.effective_offerings(pg_temp.id(p_engagement)) o where o.offering = p_offering::app.offering_kind;
$$;

-- The supplier of eng_vendor_a (Bayside Audio, cp_v_a) is a vendor of org_a in the class R3 Backline.
select pg_temp.as_user('alice');
with x as (insert into app.vendors (counterparty_id) values (pg_temp.id('cp_v_a')) returning id) insert into world select 'vendor_a', id from x;
with x as (insert into app.vendor_classes (org_id, name) values (pg_temp.id('org_a'), 'R3 Backline') returning id) insert into world select 'class_a', id from x;
insert into app.vendor_class_assignments (vendor_id, vendor_class_id) values (pg_temp.id('vendor_a'), pg_temp.id('class_a'));
select pg_temp.as_user('xavier');
with x as (insert into app.vendor_classes (org_id, name) values (pg_temp.id('org_b'), 'R3 Harbor Staging') returning id) insert into world select 'class_b', id from x;
select pg_temp.as_platform();

-- (1) Not Offered by default ----------------------------------------------------------------------------------------------
select is((select array_agg(o.offering::text) from private.effective_offerings(pg_temp.id('eng_ivy_a')) o),
  array['Travel', 'Lodging', 'Catering', 'Parking', 'Uniforms', 'Per Diem', 'Radios', 'Carts', 'Guest List'],
  'one row per offering, in enum order');
select is((select count(*)::int from private.effective_offerings(pg_temp.id('eng_ivy_a')) o
           where o.offering_mode = 'Not Offered' and o.source = 'Default' and o.cap_per_engagement is null and o.cap_per_person is null),
  9, 'a fresh engagement: every offering is Not Offered, source Default');
select is_empty(format($$select 1 from private.effective_offerings(%L)$$, '00000000-0000-0000-0000-000000000000'), 'a missing engagement has no rows');

-- (2) An org value of each setting answers Provided ----------------------------------------------------------------------
select pg_temp.as_user('alice');
select app.set_setting(pg_temp.id('org_a'), 'offerings.travel', 'Organization', null, 'provided');
select app.set_setting(pg_temp.id('org_a'), 'offerings.lodging', 'Organization', null, 'provided');
select app.set_setting(pg_temp.id('org_a'), 'offerings.catering', 'Organization', null, 'provided');
select app.set_setting(pg_temp.id('org_a'), 'offerings.parking', 'Organization', null, 'provided');
select app.set_setting(pg_temp.id('org_a'), 'offerings.uniforms', 'Organization', null, 'provided');
select app.set_setting(pg_temp.id('org_a'), 'offerings.per_diem', 'Organization', null, 'provided');
select app.set_setting(pg_temp.id('org_a'), 'offerings.radios', 'Organization', null, 'provided');
select app.set_setting(pg_temp.id('org_a'), 'offerings.carts', 'Organization', null, 'provided');
select app.set_setting(pg_temp.id('org_a'), 'offerings.guest_list', 'Organization', null, 'provided');
select pg_temp.as_platform();
select is(pg_temp.resolved('eng_ivy_a', 'Travel'), 'Provided/Organization', 'offerings.travel: an org value provided answers Provided, source Organization');
select is(pg_temp.resolved('eng_ivy_a', 'Lodging'), 'Provided/Organization', 'offerings.lodging: an org value answers');
select is(pg_temp.resolved('eng_ivy_a', 'Catering'), 'Provided/Organization', 'offerings.catering: an org value answers');
select is(pg_temp.resolved('eng_ivy_a', 'Parking'), 'Provided/Organization', 'offerings.parking: an org value answers');
select is(pg_temp.resolved('eng_ivy_a', 'Uniforms'), 'Provided/Organization', 'offerings.uniforms: an org value answers');
select is(pg_temp.resolved('eng_ivy_a', 'Per Diem'), 'Provided/Organization', 'offerings.per_diem: an org value answers');
select is(pg_temp.resolved('eng_ivy_a', 'Radios'), 'Provided/Organization', 'offerings.radios: an org value answers');
select is(pg_temp.resolved('eng_ivy_a', 'Carts'), 'Provided/Organization', 'offerings.carts: an org value answers');
select is(pg_temp.resolved('eng_ivy_a', 'Guest List'), 'Provided/Organization', 'offerings.guest_list: an org value answers');
select is(pg_temp.resolved('eng_ivy_b', 'Travel'), 'Not Offered/Default', 'another org''s engagement is untouched');

-- (3) A project value overrides the org value ------------------------------------------------------------------------------
select pg_temp.as_user('carol');
select app.set_setting(pg_temp.id('org_a'), 'offerings.travel', 'Project', pg_temp.id('prj_a'), 'reimbursed');
select pg_temp.as_platform();
select is(pg_temp.resolved('eng_ivy_a', 'Travel'), 'Reimbursed/Project', 'a project value reimbursed overrides the org value, source Project');

-- (4) A locked org value beats a project rule and a project value ----------------------------------------------------------
select pg_temp.as_user('carol');
insert into app.offering_rules (org_id, project_id, offering, offering_mode)
values (pg_temp.id('org_a'), pg_temp.id('prj_a'), 'Travel', 'Provided');
select pg_temp.as_platform();
select is(pg_temp.resolved('eng_ivy_a', 'Travel'), 'Provided/Project Rule', 'a project rule beats the project value');
select pg_temp.as_user('alice');
select app.set_setting(pg_temp.id('org_a'), 'offerings.travel', 'Organization', null, 'not-offered', null, null, true);
select pg_temp.as_platform();
select is(pg_temp.resolved('eng_ivy_a', 'Travel'), 'Not Offered/Locked', 'an org value locked at not-offered beats the rule and the project value, source Locked');
select pg_temp.as_user('alice');
select app.set_setting(pg_temp.id('org_a'), 'offerings.travel', 'Organization', null, 'provided', null, null, false);
select pg_temp.as_platform();
select is(pg_temp.resolved('eng_ivy_a', 'Travel'), 'Provided/Project Rule', 'unlocked, the rule answers again');

-- (5) Audience rules ---------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
insert into app.offering_rules (org_id, offering, external_role_type, offering_mode, cap_per_engagement, cap_per_person)
values (pg_temp.id('org_a'), 'Catering', 'Vendor', 'Provided', 10, 2);
select pg_temp.as_platform();
select is(pg_temp.resolved('eng_vendor_a', 'Catering'), 'Provided/Organization Rule', 'an org rule for role type Vendor applies to the vendor engagement');
select is((select array[o.cap_per_engagement, o.cap_per_person] from private.effective_offerings(pg_temp.id('eng_vendor_a')) o where o.offering = 'Catering'),
  array[10, 2], 'with its caps');
select is(pg_temp.resolved('eng_ivy_a', 'Catering'), 'Provided/Organization', 'and not to the crew engagement');
select pg_temp.as_user('carol');
insert into app.offering_rules (org_id, project_id, offering, offering_mode)
values (pg_temp.id('org_a'), pg_temp.id('prj_a'), 'Catering', 'Reimbursed');
select pg_temp.as_platform();
select is(pg_temp.resolved('eng_vendor_a', 'Catering'), 'Reimbursed/Project Rule', 'a project rule beats an org rule');
select pg_temp.as_user('carol');
insert into app.offering_rules (org_id, offering, external_role_type, offering_mode)
values (pg_temp.id('org_a'), 'Lodging', 'Vendor', 'Provided');
insert into app.offering_rules (org_id, offering, vendor_class_id, offering_mode, cap_per_person)
values (pg_temp.id('org_a'), 'Lodging', pg_temp.id('class_a'), 'Buyout', 5);
select pg_temp.as_platform();
select is(pg_temp.resolved('eng_vendor_a', 'Lodging'), 'Buyout/Organization Rule', 'a vendor-class rule beats a role-type rule');
select is((select array[o.cap_per_engagement, o.cap_per_person] from private.effective_offerings(pg_temp.id('eng_vendor_a')) o where o.offering = 'Lodging'),
  array[null, 5]::integer[], 'and returns its caps');
select is(pg_temp.resolved('eng_ivy_a', 'Lodging'), 'Provided/Organization', 'a vendor-class rule never reaches an engagement without that class');

-- (6) Vendor class entitlements ----------------------------------------------------------------------------------------
select pg_temp.as_user('alice');
select app.clear_setting(pg_temp.id('org_a'), 'offerings.parking', 'Organization', null);
select app.clear_setting(pg_temp.id('org_a'), 'offerings.carts', 'Organization', null);
insert into app.vendor_class_entitlements (vendor_class_id, module, is_permitted) values
  (pg_temp.id('class_a'), 'Parking', true),
  (pg_temp.id('class_a'), 'Vehicles', true);
select pg_temp.as_platform();
select is(pg_temp.resolved('eng_vendor_a', 'Parking'), 'Provided/Vendor Class', 'a vendor class entitlement Parking permitted gives Provided, source Vendor Class');
select is(pg_temp.resolved('eng_ivy_a', 'Parking'), 'Not Offered/Default', 'an engagement without the class gets the setting');
select is(pg_temp.resolved('eng_vendor_a', 'Carts'), 'Not Offered/Default', 'Vehicles maps to no offering');
select is_empty($$select k from unnest(enum_range(null::app.offering_kind)) k
  where private.offering_entitlement_module(k) in ('Vehicles', 'Quartermaster')$$, 'neither Vehicles nor Quartermaster answers for an offering');
select pg_temp.as_user('alice');
update app.vendor_class_entitlements set is_permitted = false where vendor_class_id = pg_temp.id('class_a') and module = 'Parking';
select pg_temp.as_platform();
select is(pg_temp.resolved('eng_vendor_a', 'Parking'), 'Not Offered/Vendor Class', 'an entitlement that is not permitted gives Not Offered');
select pg_temp.as_user('alice');
update app.vendor_class_entitlements set is_permitted = true where vendor_class_id = pg_temp.id('class_a') and module = 'Parking';
select pg_temp.as_user('carol');
insert into app.offering_rules (org_id, offering, external_role_type, offering_mode)
values (pg_temp.id('org_a'), 'Parking', 'Vendor', 'Not Offered');
select pg_temp.as_platform();
select is(pg_temp.resolved('eng_vendor_a', 'Parking'), 'Not Offered/Organization Rule', 'an explicit rule still beats the entitlement');

-- (7) private.assert_offered ---------------------------------------------------------------------------------------------
select throws_ok(format($$select private.assert_offered(%L, 'Parking')$$, pg_temp.id('eng_ivy_a')),
  'XR001', 'offering_not_offered: Parking is not offered on this engagement''s project.', 'assert_offered refuses an offering that is Not Offered');
select lives_ok(format($$select private.assert_offered(%L, 'Radios')$$, pg_temp.id('eng_ivy_a')), 'and passes an offered one');
select is(private.offering_mode(pg_temp.id('eng_ivy_a'), 'Radios'), 'Provided'::app.offering_mode, 'offering_mode answers one offering');

-- (8) app.effective_offerings --------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
select is((select count(*)::int from app.effective_offerings(pg_temp.id('eng_ivy_a'))), 9, 'an engagement reader reads the offerings');
select is((select source from app.effective_offerings(pg_temp.id('eng_ivy_a')) where offering = 'Travel'), 'Project Rule', 'with their source');
select pg_temp.as_user('ivy');
select is((select count(*)::int from app.effective_offerings(pg_temp.id('eng_ivy_a'))), 9, 'the engaged party reads them');
select pg_temp.as_user('quinn');
select throws_ok(format($$select * from app.effective_offerings(%L)$$, pg_temp.id('eng_ivy_a')),
  '42501', 'the engagement is not readable', 'another party gets 42501');
select pg_temp.as_user('gina');
select throws_ok(format($$select * from app.effective_offerings(%L)$$, pg_temp.id('eng_ivy_b')),
  '42501', 'the engagement is not readable', 'a member of another org gets 42501');

-- (9) api_external.engagement_offerings ------------------------------------------------------------------------------------
select hasnt_column('api_external', 'engagement_offerings', 'source', 'the external view has no source column');
select pg_temp.as_user('ivy');
select is((select count(*)::int from api_external.engagement_offerings where engagement_id = pg_temp.id('eng_ivy_a')), 9, 'the caller reads their own engagement''s offerings');
select is((select offering_mode::text from api_external.engagement_offerings where engagement_id = pg_temp.id('eng_ivy_a') and offering = 'Travel'),
  'Provided', 'as resolved');
select is((select count(*)::int from api_external.engagement_offerings), 18, 'both of the caller''s engagements, nothing else');
select is((select count(*)::int from api_external.engagement_offerings where engagement_id = pg_temp.id('eng_quinn_b')), 0, 'none for another party''s engagement');
-- The view's definer function is the door: with ivy's claims (as the view owner, which can reach the private
-- schema), it answers her own engagement and nothing for another party's.
select set_config('role', 'postgres', true);
select is((select count(*)::int from private.my_engagement_offerings(pg_temp.id('eng_ivy_a'))), 9, 'the definer function answers the caller''s engagement');
select is((select count(*)::int from private.my_engagement_offerings(pg_temp.id('eng_quinn_b'))), 0, 'and nothing for another party''s');
select pg_temp.as_user('ivy');
select pg_temp.as_user('quinn');
select is((select count(*)::int from api_external.engagement_offerings where engagement_id = pg_temp.id('eng_ivy_a')), 0, 'and the other party never reads the caller''s');
select pg_temp.as_anon();
select throws_ok($$select 1 from api_external.engagement_offerings$$, '42501', null, 'anon cannot read the view');
select pg_temp.as_platform();

-- (10) offering_rules: policies and constraints ----------------------------------------------------------------------------
select pg_temp.as_user('dave');
select throws_ok(format($$insert into app.offering_rules (org_id, project_id, offering, offering_mode) values (%L, %L, 'Carts', 'Provided')$$,
  pg_temp.id('org_a'), pg_temp.id('prj_a')), '42501', null, 'a member without projects.settings.write cannot insert a project rule');
select is((select count(*)::int from app.offering_rules), 6, 'a member reads the org''s rules');
select pg_temp.as_user('xavier');
select is((select count(*)::int from app.offering_rules), 0, 'another org reads none of them');
select pg_temp.as_user('carol');
select throws_like(format($$insert into app.offering_rules (org_id, offering, vendor_class_id, offering_mode) values (%L, 'Carts', %L, 'Provided')$$,
  pg_temp.id('org_a'), pg_temp.id('class_b')), 'cross_org_reference:%', 'a vendor class of another org is refused');
select throws_ok(format($$insert into app.offering_rules (org_id, offering, offering_mode, cap_per_person) values (%L, 'Carts', 'Not Offered', 3)$$,
  pg_temp.id('org_a')), '23514', null, 'caps on a Not Offered rule are refused');
select throws_ok(format($$insert into app.offering_rules (org_id, offering, external_role_type, vendor_class_id, offering_mode) values (%L, 'Carts', 'Crew', %L, 'Provided')$$,
  pg_temp.id('org_a'), pg_temp.id('class_a')), '23514', null, 'a vendor class rule for a role type other than Vendor is refused');
select throws_ok(format($$insert into app.offering_rules (org_id, offering, offering_mode, cap_per_engagement) values (%L, 'Carts', 'Provided', 10001)$$,
  pg_temp.id('org_a')), '23514', null, 'a cap above 10000 is refused');
select throws_ok(format($$insert into app.offering_rules (org_id, offering, external_role_type, offering_mode) values (%L, 'Catering', 'Vendor', 'Buyout')$$,
  pg_temp.id('org_a')), '23505', null, 'a duplicate live audience is refused');
update app.offering_rules set deleted_at = now() where offering = 'Catering' and external_role_type = 'Vendor' and project_id is null;
select lives_ok(format($$insert into app.offering_rules (org_id, offering, external_role_type, offering_mode) values (%L, 'Catering', 'Vendor', 'Buyout')$$,
  pg_temp.id('org_a')), 'a soft-deleted rule frees the audience');
select pg_temp.as_platform();
select ok(not exists (select 1 from private.trash_tables where table_name = 'offering_rules'), 'offering rules stay out of Trash');

-- (11) private.backfill_offerings ------------------------------------------------------------------------------------------
select pg_temp.as_user('alice');
with x as (insert into app.projects (org_id, project_key, name, time_zone) values (pg_temp.id('org_a'), 'NWT', 'Northwind Travel Week', 'America/New_York') returning id)
  insert into world select 'prj_t', id from x;
with x as (insert into app.projects (org_id, project_key, name, time_zone) values (pg_temp.id('org_a'), 'NWR', 'Northwind Archive', 'America/New_York') returning id)
  insert into world select 'prj_archived', id from x;
with x as (insert into app.projects (org_id, project_key, name, time_zone) values (pg_temp.id('org_a'), 'NWC', 'Northwind Closed Run', 'America/New_York') returning id)
  insert into world select 'prj_complete', id from x;
with x as (insert into app.projects (org_id, project_key, name, time_zone) values (pg_temp.id('org_a'), 'NWG', 'Northwind Green Room', 'America/New_York') returning id)
  insert into world select 'prj_amenity', id from x;
select pg_temp.as_platform();
insert into app.fulfillments (org_id, project_id, fulfillment_kind, title)
values (pg_temp.id('org_a'), pg_temp.id('prj_amenity'), 'Amenity', 'Green Room Supplies');
insert into app.travel_segments (project_id, person_id, travel_mode, departs_from, departs_at, departs_time_zone, arrives_at_place, arrives_time_zone)
select p, pg_temp.id('frank'), 'Flight', 'BOS', '2027-05-31 12:00+00', 'America/New_York', 'MIA', 'America/New_York'
from unnest(array[pg_temp.id('prj_t'), pg_temp.id('prj_archived'), pg_temp.id('prj_complete'), pg_temp.id('prj_a')]) p;
update app.projects set archived_at = now() where id = pg_temp.id('prj_archived');
select private.transition_lifecycle('project', 'app.projects', 'project_state', 'app.project_state_transitions', 'project_id',
  pg_temp.id('prj_complete'), 'Proposed', 'Active', 'Fixture start.');
select private.transition_lifecycle('project', 'app.projects', 'project_state', 'app.project_state_transitions', 'project_id',
  pg_temp.id('prj_complete'), 'Active', 'Complete', 'Fixture close.');
select ok(private.backfill_offerings() >= 1, 'the backfill writes values');
select is((select value_text from app.setting_values where setting_key = 'offerings.travel' and scope_kind = 'Project'
           and scope_id = pg_temp.id('prj_t') and deleted_at is null), 'provided', 'offerings.travel is provided on a live project with a travel segment');
select is((select count(*)::int from app.setting_values where scope_kind = 'Project' and scope_id = pg_temp.id('prj_t')
           and setting_key like 'offerings.%' and deleted_at is null), 1, 'and nothing else without evidence');
select is((select array_agg(setting_key) from app.setting_values where scope_kind = 'Project' and scope_id = pg_temp.id('prj_amenity')
           and setting_key like 'offerings.%' and deleted_at is null), array['offerings.catering'],
  'an Amenity fulfillment alone offers catering, so the Hospitality tab stays open');
select is((select count(*)::int from app.setting_values where scope_kind = 'Project' and scope_id = pg_temp.id('prj_a2')
           and setting_key like 'offerings.%'), 0, 'nothing for a project without evidence');
select is((select count(*)::int from app.setting_values where scope_kind = 'Project' and scope_id in (pg_temp.id('prj_archived'), pg_temp.id('prj_complete'))
           and setting_key like 'offerings.%'), 0, 'nothing for an archived or Complete project');
select is((select value_text from app.setting_values where setting_key = 'offerings.travel' and scope_kind = 'Project'
           and scope_id = pg_temp.id('prj_a') and deleted_at is null), 'reimbursed', 'never overwrites an existing project value');
select is(private.backfill_offerings(), 0, 'running it again writes nothing');

-- (2625) The per diem writer and the table refuse an engagement where per diem is Not Offered -----------------------------
select pg_temp.move_engagement('eng_ivy_a', 'Onboarding', 'Active');
select pg_temp.as_user('carol');
select app.set_setting(pg_temp.id('org_a'), 'offerings.per_diem', 'Project', pg_temp.id('prj_a'), 'not-offered');
select throws_ok(format($$select app.add_per_diems(%L, null, %L, '2027-06-01', '2027-06-02', 7000, 'USD')$$, pg_temp.id('prj_a'), pg_temp.id('eng_ivy_a')),
  'XR001', 'offering_not_offered: Per Diem is not offered on this engagement''s project.', 'an engagement per diem where per diem is Not Offered is refused');
select is(app.add_per_diems(pg_temp.id('prj_a'), pg_temp.id('dave@org_a'), null, '2027-06-01', '2027-06-02', 6500, 'USD'), 2,
  'a member per diem still succeeds');
select pg_temp.as_platform();
select throws_ok(format($$insert into app.per_diems (project_id, engagement_id, day, amount_minor, currency_code) values (%L, %L, '2027-06-03', 7000, 'USD')$$,
  pg_temp.id('prj_a'), pg_temp.id('eng_ivy_a')),
  'XR001', 'offering_not_offered: Per Diem is not offered on this engagement''s project.', 'a direct insert is refused the same way');
select pg_temp.as_user('carol');
select app.set_setting(pg_temp.id('org_a'), 'offerings.per_diem', 'Project', pg_temp.id('prj_a'), 'provided');
select is(app.add_per_diems(pg_temp.id('prj_a'), null, pg_temp.id('eng_ivy_a'), '2027-06-01', '2027-06-02', 7000, 'USD'), 2,
  'once offered, the engagement per diem is added');
select app.set_setting(pg_temp.id('org_a'), 'offerings.per_diem', 'Project', pg_temp.id('prj_a'), 'not-offered');
select pg_temp.as_platform();
select lives_ok(format($$update app.per_diems set amount_minor = 7100 where engagement_id = %L$$, pg_temp.id('eng_ivy_a')),
  'per diems recorded while offered stay editable after per diem is turned off');

-- (9, continued) The view closes 18 months after Complete -----------------------------------------------------------------
select pg_temp.move_engagement('eng_ivy_a', 'Active', 'Closing');
select pg_temp.move_engagement('eng_ivy_a', 'Closing', 'Complete');
select pg_temp.as_user('ivy');
select is((select count(*)::int from api_external.engagement_offerings where engagement_id = pg_temp.id('eng_ivy_a')), 9, 'still read at Complete');
select pg_temp.backdate_close('eng_ivy_a', interval '19 months');
select pg_temp.as_user('ivy');
select is((select count(*)::int from api_external.engagement_offerings where engagement_id = pg_temp.id('eng_ivy_a')), 0, 'none 18 months after Complete');
select pg_temp.as_platform();

-- (12) The private functions stay closed --------------------------------------------------------------------------------------
select ok(not has_function_privilege('authenticated', f, 'execute'), format('%s is not executable by authenticated', f))
from unnest(array['private.offering_mode_of_choice(text)', 'private.offering_entitlement_module(app.offering_kind)',
  'private.offering_setting_key(app.offering_kind)', 'private.engagement_vendor_class_ids(uuid)', 'private.effective_offerings(uuid)',
  'private.offering_mode(uuid, app.offering_kind)', 'private.assert_offered(uuid, app.offering_kind)', 'private.backfill_offerings()',
  'private.guard_per_diem_offered()']) f;
select ok(not has_function_privilege('anon', 'app.effective_offerings(uuid)', 'execute'), 'app.effective_offerings is not executable by anon');
select ok(has_function_privilege('authenticated', 'app.effective_offerings(uuid)', 'execute'), 'and is executable by authenticated');
select pg_temp.as_user('ivy');
select throws_ok(format($$select * from private.effective_offerings(%L)$$, pg_temp.id('eng_ivy_b')), '42501', null, 'a signed-in caller cannot call the resolver');
select pg_temp.as_platform();

select * from finish();
rollback;

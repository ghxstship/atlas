-- pgTAP: migration 2663 (R6a, ADR 0105), allergies are Restricted and Contact is shared. Ivy shares her dietary
-- needs, emergency contacts and contact with her crew engagement. A hospitality reader (Bob, Admin) reads her dietary
-- needs with the allergies masked and no medical block; after someone else makes him the catering lead on the project he
-- reads them, and so does the Owner, each read logged once as allergies.viewed and once in the audit ledger. A
-- medical-only reader (Mel, Field, on-site medical on the project) reads them in the medical block alone. Every read logs
-- work_details.viewed, with no ten-minute merge. The company reads its rostered person's allergies masked, and the
-- verified email of both. The ten-minute helper is gone, and the person reads her own allergies only through
-- app.my_allergies.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

select plan(36);

-- A read of the engaged person's work details as someone, back as the platform.
create function pg_temp.read(p_who text, p_engagement text) returns jsonb
language plpgsql as $$
declare v jsonb;
begin
  perform pg_temp.as_user(p_who);
  v := app.shared_work_details(pg_temp.id(p_engagement));
  perform pg_temp.as_platform();
  return v;
end $$;

create function pg_temp.entry_read(p_who text, p_entry text) returns jsonb
language plpgsql as $$
declare v jsonb;
begin
  perform pg_temp.as_user(p_who);
  v := app.roster_shared_work_details(pg_temp.id(p_entry));
  perform pg_temp.as_platform();
  return v;
end $$;

create function pg_temp.can(p_who text, p_project text, p_capability text) returns boolean
language plpgsql as $$
declare v boolean;
begin
  perform pg_temp.claims(p_who);
  v := private.can_on_project(pg_temp.id(p_project), p_capability);
  perform pg_temp.as_platform();
  return v;
end $$;

create function pg_temp.events(p_person text, p_action text) returns integer
language sql as $$
  select count(*)::int from app.work_detail_events where person_id = pg_temp.id(p_person) and action = p_action
$$;

create function pg_temp.audits(p_action text) returns integer
language sql as $$
  select count(*)::int from app.audit_events where org_id = pg_temp.id('org_a') and action = p_action
$$;

-- Schema --------------------------------------------------------------------------------------------------------------------------
select results_eq($$select classification::text, read_capability from private.column_classifications
  where table_name = 'app.person_work_details' and column_name = 'allergies'$$,
  $$values ('Restricted', 'data.restricted.read.medical')$$, 'allergies are Restricted under data.restricted.read.medical');
select results_eq($$select classification::text from private.column_classifications
  where table_name = 'app.person_work_details' and column_name in ('dietary_needs', 'dietary_notes') order by column_name$$,
  $$values ('Confidential'), ('Confidential')$$, 'dietary needs and notes stay Confidential');
select hasnt_function('private', 'work_details_view_logged_recently', array['uuid', 'uuid'],
  'the ten-minute view helper is gone');
select ok('Contact' = any (enum_range(null::app.work_detail_category)), 'Contact is a work detail category');
select is(private.work_detail_category_capabilities('Contact'), array['opportunities.engagement.read', 'safety.incident.read'],
  'engagement readers and safety readers read a shared contact');

-- Fixture: Ivy's details and share; Mel works the medical tent ---------------------------------------------------------------
select pg_temp.as_user('ivy');
select app.ensure_my_work_details();
update app.person_work_details set dietary_needs = '{Vegan}', allergies = 'Peanuts, severe' where person_id = pg_temp.id('ivy');
insert into app.person_emergency_contacts (person_id, full_name, phone_e164) values (pg_temp.id('ivy'), 'Marco Marchetti', '+393471234567');
select is(app.my_allergies(), 'Peanuts, severe', 'the person reads her own allergies through app.my_allergies');
select throws_ok($$select allergies from app.person_work_details$$, '42501', null,
  'and never selects the Restricted column directly');
select lives_ok($$select dietary_needs from app.person_work_details$$, 'while the rest of her row stays readable');
select lives_ok(format($$select app.share_work_details(%L, '{Dietary Needs,Emergency Contacts,Contact}')$$, pg_temp.id('eng_ivy_a')),
  'a share may name Contact');
select pg_temp.new_user('mel', 'mel@northwind.test', 'Mel Ferreira');
select pg_temp.join_org('alice', 'org_a', 'mel', 'field');
select pg_temp.as_user('carol');
with x as (insert into app.role_assignments (project_id, role_code, person_id)
  values (pg_temp.id('prj_a'), '7000.51.01', pg_temp.id('mel')) returning id) insert into world select 'ra_mel', id from x;
select app.transition_role_assignment(pg_temp.id('ra_mel'), 'Proposed', 'Active', 'On the medical tent.');
select pg_temp.as_platform();
select ok(not pg_temp.can('bob', 'prj_a', 'data.restricted.read.medical') and pg_temp.can('bob', 'prj_a', 'hospitality.fulfillment.read'),
  'fixture: Bob reads hospitality but holds no medical capability');
select ok(pg_temp.can('mel', 'prj_a', 'data.restricted.read.medical') and not pg_temp.can('mel', 'prj_a', 'hospitality.fulfillment.read'),
  'fixture: Mel holds the medical capability on the project and reads no hospitality');

-- A hospitality reader reads them masked ---------------------------------------------------------------------------------------
create temporary table counts as select pg_temp.events('ivy', 'work_details.viewed') as views;
select ok(pg_temp.read('bob', 'eng_ivy_a') #> '{dietary,allergies}' = 'null'::jsonb, 'a hospitality reader reads no allergies');
select is(pg_temp.read('bob', 'eng_ivy_a') #>> '{dietary,allergies_masked}', 'true', 'they are masked');
select is(pg_temp.read('bob', 'eng_ivy_a') #>> '{dietary,dietary_needs,0}', 'Vegan', 'the dietary needs still reach them');
select ok(pg_temp.read('bob', 'eng_ivy_a') -> 'medical' = 'null'::jsonb, 'and no medical block');
select is(pg_temp.events('ivy', 'allergies.viewed'), 0, 'a masked read logs no allergies.viewed');
select is(pg_temp.events('ivy', 'work_details.viewed') - (select views from counts), 4,
  'each of the four reads logs work_details.viewed, with no ten-minute merge');
select is(pg_temp.read('bob', 'eng_ivy_a') #>> '{contact,email}', 'ivy@freelance.test', 'an engagement reader reads the verified sign-in email');
select ok(pg_temp.read('bob', 'eng_ivy_a') #> '{contact,phone}' = 'null'::jsonb, 'and no phone, since none is verified');
select ok((select categories @> '{Contact}' from app.work_detail_events where person_id = pg_temp.id('ivy') and action = 'work_details.viewed'
  order by created_at desc, id desc limit 1), 'the contact read is logged with its category');

-- The Owner and the catering lead read them, each read logged ---------------------------------------------------------------------
create temporary table before_owner as select pg_temp.events('ivy', 'allergies.viewed') as views, pg_temp.audits('work_details.allergies_viewed') as audits;
select is(pg_temp.read('alice', 'eng_ivy_a') #>> '{dietary,allergies}', 'Peanuts, severe', 'the Owner reads the allergies');
select is(pg_temp.events('ivy', 'allergies.viewed') - (select views from before_owner), 1, 'one read logs one allergies.viewed');
select is(pg_temp.audits('work_details.allergies_viewed') - (select audits from before_owner), 1, 'and one audit event');
select is(pg_temp.read('alice', 'eng_ivy_a') #>> '{medical,allergies}', 'Peanuts, severe', 'the Owner reads the medical block too');
select is(pg_temp.events('ivy', 'allergies.viewed') - (select views from before_owner), 2, 'two reads log two allergies.viewed');
select is(pg_temp.audits('work_details.allergies_viewed') - (select audits from before_owner), 2, 'and two audit events');

select pg_temp.as_user('carol');
with x as (insert into app.role_assignments (project_id, role_code, person_id)
  values (pg_temp.id('prj_a'), '8000.51.01', pg_temp.id('bob')) returning id) insert into world select 'ra_bob', id from x;
select app.transition_role_assignment(pg_temp.id('ra_bob'), 'Proposed', 'Active', 'Catering captain for the series.');
select pg_temp.as_platform();
select is(pg_temp.read('bob', 'eng_ivy_a') #>> '{dietary,allergies}', 'Peanuts, severe',
  'once someone else makes him the catering lead, the hospitality reader reads them');
select is(pg_temp.read('bob', 'eng_ivy_a') #>> '{dietary,allergies_masked}', 'false', 'unmasked');
select is((select actor_person_id from app.work_detail_events where person_id = pg_temp.id('ivy') and action = 'allergies.viewed'
  order by created_at desc, id desc limit 1), pg_temp.id('bob'), 'and the access log names him');

-- A medical-only reader ----------------------------------------------------------------------------------------------------------
select is(pg_temp.read('mel', 'eng_ivy_a') #>> '{medical,allergies}', 'Peanuts, severe', 'on-site medical reads the allergies');
select ok(pg_temp.read('mel', 'eng_ivy_a') -> 'dietary' = 'null'::jsonb
  and not ((pg_temp.read('mel', 'eng_ivy_a') -> 'readable') ? 'Dietary Needs'), 'and nothing else of the dietary needs');
select is((select actor_person_id from app.work_detail_events where person_id = pg_temp.id('ivy') and action = 'work_details.viewed'
  order by created_at desc, id desc limit 1), pg_temp.id('mel'), 'the medical read is logged as a view too');

-- The company reads them masked -----------------------------------------------------------------------------------------------------
select pg_temp.new_user('kai', 'kai@bayside-audio.test', 'Kai Morgan');
select pg_temp.as_user('victor');
select app.add_account_member(pg_temp.id('acct_v'), pg_temp.id('kai'), 'Account Member');
select pg_temp.as_user('kai');
select app.accept_account_membership((select m.id from app.account_memberships m
  where m.org_id = (select id from world where key = 'acct_v') and m.person_id = (select id from world where key = 'kai') and m.deleted_at is null));
select app.ensure_my_work_details();
update app.person_work_details set allergies = 'Shellfish' where person_id = pg_temp.id('kai');
select pg_temp.as_user('victor');
insert into world select 'e_kai', app.add_roster_entry(pg_temp.id('eng_vendor_a'), pg_temp.id('kai'));
select pg_temp.as_user('kai');
select app.respond_roster_entry(pg_temp.id('e_kai'), 'Accepted');
select pg_temp.as_platform();
select is(pg_temp.entry_read('victor', 'e_kai') ->> 'reader', 'company', 'fixture: the account''s Owner reads as the company');
select ok(pg_temp.entry_read('victor', 'e_kai') #> '{dietary,allergies}' = 'null'::jsonb
  and (pg_temp.entry_read('victor', 'e_kai') #>> '{dietary,allergies_masked}')::boolean
  and pg_temp.entry_read('victor', 'e_kai') -> 'medical' = 'null'::jsonb, 'the company always reads allergies masked, with no medical block');
select ok((pg_temp.entry_read('victor', 'e_kai') -> 'readable') ? 'Contact'
  and not ((pg_temp.entry_read('victor', 'e_kai') -> 'readable') ? 'Uniform Sizes'), 'it reads Contact, and no longer the retired Uniform Sizes');
select is(pg_temp.entry_read('victor', 'e_kai') #>> '{contact,email}', 'kai@bayside-audio.test', 'with the verified email of an accepted rostered person');

select * from finish();
rollback;

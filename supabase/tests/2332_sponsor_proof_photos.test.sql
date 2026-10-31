-- pgTAP: migration 2332, sponsors' proof-of-performance photos from Compass (A140, RRR-204; Section 4.5.7, journey 47)
-- under Section 8.7: a photo goes only to an entitlement of the caller's own active Sponsor engagement, into that
-- engagement's field-media folder, and nobody else reads it. Tested for access through the person's own engagement and
-- through the sponsor account (sponsors have no representation), denial for another party's engagement, another
-- account, another tenant, anon and after close, and no internal columns in the projection. The org reads with
-- vendors.vendor.read.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

select plan(34);

-- Both sponsors' engagements are org_a's.
create function pg_temp.photo_path(p_engagement text, p_file text) returns text
language sql stable as $$ select format('%s/proof-of-performance/%s/%s', pg_temp.id('org_a'), pg_temp.id(p_engagement), p_file) $$;

create function pg_temp.n(p_who text, p_sql text) returns integer
language plpgsql as $$
declare v integer;
begin
  perform pg_temp.as_user(p_who);
  execute 'select count(*)::int from (' || p_sql || ') x' into v;
  perform pg_temp.as_platform();
  return v;
end $$;

-- Fixture: Brightwave Drinks sponsors prj_a (sol holds the engagement and owns the account; lena is an Account
-- Member, fred its Account Finance); Tidewater Coffee sponsors prj_a too, through its own account (tom).
select pg_temp.new_user('sol', 'sol@brightwave-drinks.test', 'Sol Ferreira');
select pg_temp.new_user('lena', 'lena@brightwave-drinks.test', 'Lena Park');
select pg_temp.new_user('fred', 'fred@brightwave-drinks.test', 'Fred Okafor');
select pg_temp.new_user('tom', 'tom@tidewater-coffee.test', 'Tom Reyes');
select pg_temp.as_user('sol');
insert into world values ('acct_s', app.create_external_account('Brightwave Drinks', 'brightwave-drinks'));
select app.add_account_member(pg_temp.id('acct_s'), pg_temp.id('lena'), 'Account Member');
select app.add_account_member(pg_temp.id('acct_s'), pg_temp.id('fred'), 'Account Finance');
select pg_temp.as_user('tom');
insert into world values ('acct_t2', app.create_external_account('Tidewater Coffee', 'tidewater-coffee'));
select pg_temp.as_user('alice');
insert into world values ('cp_s_a', app.create_counterparty(pg_temp.id('org_a'), null, null, pg_temp.id('acct_s')));
insert into world values ('cp_t_a', app.create_counterparty(pg_temp.id('org_a'), null, null, pg_temp.id('acct_t2')));
with e as (insert into app.engagements (project_id, person_id, counterparty_id, role_type, start_date)
  values (pg_temp.id('prj_a'), pg_temp.id('sol'), pg_temp.id('cp_s_a'), 'Sponsor', '2027-06-01') returning id)
  insert into world select 'eng_sponsor', id from e;
with e as (insert into app.engagements (project_id, person_id, counterparty_id, role_type, start_date)
  values (pg_temp.id('prj_a'), pg_temp.id('tom'), pg_temp.id('cp_t_a'), 'Sponsor', '2027-06-01') returning id)
  insert into world select 'eng_other', id from e;
select pg_temp.as_user('carol');
with s as (insert into app.sponsor_entitlements (project_id, counterparty_id, description, quantity)
  values (pg_temp.id('prj_a'), pg_temp.id('cp_s_a'), 'Main stage banner placement', 2) returning id) insert into world select 'ent', id from s;
with s as (insert into app.sponsor_entitlements (project_id, counterparty_id, description)
  values (pg_temp.id('prj_a'), pg_temp.id('cp_t_a'), 'Coffee cart at the gate') returning id) insert into world select 'ent_other', id from s;
select pg_temp.as_platform();
insert into world values ('p1', gen_random_uuid()), ('p2', gen_random_uuid()), ('p3', gen_random_uuid());

-- 1. Shape ---------------------------------------------------------------------------------------------------------------
select has_table('app', 'proof_of_performance_photos', 'the photos table exists');
select has_function('app', 'record_proof_of_performance_photo', array['uuid', 'uuid', 'text', 'timestamptz'], 'the RPC exists');
select ok(not has_function_privilege('anon', 'app.record_proof_of_performance_photo(uuid,uuid,text,timestamptz)', 'execute'),
  'anon cannot record a photo');
select is((select count(*)::int from private.sync_rpcs where rpc = 'app.record_proof_of_performance_photo'), 1,
  'Compass replays it through the outbox');
select is_empty($$select column_name from information_schema.columns where table_schema = 'api_external'
    and table_name = 'proof_of_performance_photos' and column_name in ('org_id', 'created_by', 'updated_by', 'updated_at', 'deleted_at')$$,
  'denial for internal columns: the projection shows no person ids or audit columns');
select is((select count(*)::int from private.trash_excluded_tables where table_name = 'proof_of_performance_photos'), 1,
  'the photos are kept out of Trash, with why (ADR 0110)');

-- 2. Before the engagement is active ---------------------------------------------------------------------------------------
select pg_temp.as_user('sol');
select throws_ok(format($$insert into storage.objects (bucket_id, name) values ('field-media', %L)$$, pg_temp.photo_path('eng_sponsor', 'early.jpg')),
  '42501', null, 'Onboarding: no capture before the operational area opens');
select pg_temp.as_platform();
select pg_temp.move_engagement('eng_sponsor', 'Onboarding', 'Active');
select pg_temp.move_engagement('eng_other', 'Onboarding', 'Active');

-- 3. Own engagement and account engagement ---------------------------------------------------------------------------------
select pg_temp.as_user('sol');
select lives_ok(format($$insert into storage.objects (bucket_id, name) values ('field-media', %L)$$, pg_temp.photo_path('eng_sponsor', 'banner-1.jpg')),
  'the engaged sponsor stores a photo in the engagement''s folder');
select is(app.record_proof_of_performance_photo(pg_temp.id('p1'), pg_temp.id('ent'), pg_temp.photo_path('eng_sponsor', 'banner-1.jpg'),
    '2027-06-12T19:30:00Z'), pg_temp.id('p1'), 'and records it against the entitlement');
select is(app.record_proof_of_performance_photo(pg_temp.id('p1'), pg_temp.id('ent'), pg_temp.photo_path('eng_sponsor', 'banner-1.jpg'),
    '2027-06-12T19:30:00Z'), pg_temp.id('p1'), 'a replay from the outbox returns the same photo');
select pg_temp.as_platform();
select results_eq(format($$select org_id, engagement_id, created_by from app.proof_of_performance_photos where id = %L$$, pg_temp.id('p1')),
  format($$values (%L::uuid, %L::uuid, %L::uuid)$$, pg_temp.id('org_a'), pg_temp.id('eng_sponsor'), pg_temp.id('sol')),
  'the photo belongs to the org and the engagement, recorded by sol');
select is((select count(*)::int from app.proof_of_performance_photos), 1, 'the replay made no second row');

select pg_temp.as_user('lena');
-- As the storage API writes it, with the uploader as the object's owner.
select lives_ok(format($$insert into storage.objects (bucket_id, name, owner_id) values ('field-media', %L, %L)$$,
  pg_temp.photo_path('eng_sponsor', 'banner-2.jpg'), pg_temp.id('lena_user')),
  'an Account Member of the sponsor captures through the account''s engagement');
select lives_ok(format($$select app.record_proof_of_performance_photo(%L, %L, %L)$$, pg_temp.id('p2'), pg_temp.id('ent'),
  pg_temp.photo_path('eng_sponsor', 'banner-2.jpg')), 'and records the photo');
select throws_ok(format($$select app.record_proof_of_performance_photo(%L, %L, %L)$$, pg_temp.id('p1'), pg_temp.id('ent'),
  pg_temp.photo_path('eng_sponsor', 'banner-2.jpg')), 'XR001', null, 'another person''s photo id is refused');
select pg_temp.as_user('fred');
select throws_ok(format($$insert into storage.objects (bucket_id, name) values ('field-media', %L)$$, pg_temp.photo_path('eng_sponsor', 'fred.jpg')),
  '42501', null, 'Account Finance reaches money and documents, not the operational area, so captures nothing');

-- 4. Another party's engagement, account and tenant ---------------------------------------------------------------------------
select pg_temp.as_user('sol');
select throws_ok(format($$insert into storage.objects (bucket_id, name) values ('field-media', %L)$$, pg_temp.photo_path('eng_other', 'sneak.jpg')),
  '42501', null, 'denial: no upload into another sponsor''s engagement folder');
select throws_ok(format($$select app.record_proof_of_performance_photo(%L, %L, %L)$$, pg_temp.id('p3'), pg_temp.id('ent_other'),
  pg_temp.photo_path('eng_sponsor', 'banner-1.jpg')), '42501', null, 'denial: no photo on another sponsor''s entitlement');
select pg_temp.as_user('tom');
select throws_ok(format($$select app.record_proof_of_performance_photo(%L, %L, %L)$$, pg_temp.id('p3'), pg_temp.id('ent'),
  pg_temp.photo_path('eng_other', 'x.jpg')), '42501', null, 'denial: another account cannot attach a photo to Brightwave''s entitlement');
select throws_ok(format($$select app.record_proof_of_performance_photo(%L, %L, %L)$$, pg_temp.id('p3'), pg_temp.id('ent'),
  pg_temp.photo_path('eng_sponsor', 'x.jpg')), '42501', null, 'nor through Brightwave''s folder');
select pg_temp.as_user('sol');
select throws_ok(format($$select app.record_proof_of_performance_photo(%L, %L, %L)$$, pg_temp.id('p3'), pg_temp.id('ent'),
  pg_temp.id('org_a') || '/expense-receipts/' || pg_temp.id('prj_a') || '/x.jpg'), 'XR001', null, 'a path outside the engagement folder is refused');

-- 5. Reading -----------------------------------------------------------------------------------------------------------------
-- Photos read once they scan clean (1041); before that only their uploader reads each.
select is(pg_temp.n('lena', $$select 1 from storage.objects where bucket_id = 'field-media'$$), 1, 'before the scan, lena reads only her own upload');
select pg_temp.as_platform();
update private.object_scans set scan_status = 'Clean', scanned_at = now() where bucket_id = 'field-media';
select is(pg_temp.n('lena', $$select 1 from storage.objects where bucket_id = 'field-media'$$), 2, 'once clean, the sponsor''s team reads its engagement''s photos');
select is(pg_temp.n('tom', $$select 1 from storage.objects where bucket_id = 'field-media'$$), 0, 'denial: another sponsor reads none of them');
select is(pg_temp.n('xavier', $$select 1 from storage.objects where bucket_id = 'field-media'$$), 0, 'denial: another tenant reads none');
select is(pg_temp.n('ivy', $$select 1 from storage.objects where bucket_id = 'field-media'$$), 0, 'denial: crew on the same project read none');
select is(pg_temp.n('carol', $$select 1 from storage.objects where bucket_id = 'field-media'$$), 2, 'the org reads them with vendors.vendor.read');
select is(pg_temp.n('carol', 'select 1 from app.proof_of_performance_photos'), 2, 'and their rows');
select is(pg_temp.n('sol', 'select 1 from app.proof_of_performance_photos'), 0, 'the sponsor never reads the app table');
select is(pg_temp.n('sol', 'select 1 from api_external.proof_of_performance_photos'), 2, 'the sponsor reads the projection of its engagement');
select is(pg_temp.n('tom', 'select 1 from api_external.proof_of_performance_photos'), 0, 'denial: another sponsor''s projection is empty');
select pg_temp.as_anon();
select throws_ok('select 1 from api_external.proof_of_performance_photos', '42501', null, 'anon reads none');
select pg_temp.as_platform();

-- 6. After close -------------------------------------------------------------------------------------------------------------
select pg_temp.move_engagement('eng_sponsor', 'Active', 'Closing');
select pg_temp.move_engagement('eng_sponsor', 'Closing', 'Complete');
select pg_temp.as_user('sol');
select throws_ok(format($$insert into storage.objects (bucket_id, name) values ('field-media', %L)$$, pg_temp.photo_path('eng_sponsor', 'late.jpg')),
  '42501', null, 'denial after close: capture ends at Complete');
select is((select count(*)::int from api_external.proof_of_performance_photos), 0, 'and the photos leave the sponsor''s device');
select pg_temp.as_platform();

select * from finish();
rollback;

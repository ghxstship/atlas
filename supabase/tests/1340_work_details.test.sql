-- pgTAP: migration 1340, Work Details (A78, findings A65-003 and A65-028 names). Ivy keeps her own work details, emergency
-- contacts and loyalty programs; nobody else reads them directly. Her passport number is Restricted: encrypted, never
-- selectable, masked on every read path and shown only through an audited reveal. She shares chosen categories with
-- one engagement under work_details_sharing consent; the engaging org reads only those categories its readers'
-- project capabilities cover, only while the share stands and the engagement is open, and every read is logged. She
-- narrows and revokes the share, the consent is withdrawn with the last share, and account deletion erases it all.
-- Column comments and the given and family names are checked too.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

select plan(66);

-- Claims with a second factor, for the Restricted reveal.
create function pg_temp.as_user_aal2(p_key text) returns void
language plpgsql as $$
begin
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', pg_temp.id(p_key || '_user'), 'role', 'authenticated', 'aal', 'aal2')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;

-- Schema ----------------------------------------------------------------------------------------------------------------
select has_table('app', 'person_work_details', 'app.person_work_details exists');
select has_table('app', 'person_emergency_contacts', 'app.person_emergency_contacts exists');
select has_table('app', 'person_loyalty_programs', 'app.person_loyalty_programs exists');
select has_table('app', 'work_detail_shares', 'app.work_detail_shares exists');
select has_table('app', 'work_detail_events', 'app.work_detail_events exists');
select is_empty($$
  select c.relname || '.' || a.attname from pg_class c join pg_namespace n on n.oid = c.relnamespace
  join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
  where n.nspname = 'app' and c.relname in ('person_work_details', 'person_emergency_contacts', 'person_loyalty_programs',
    'work_detail_shares', 'work_detail_events')
    and col_description(c.oid, a.attnum) is null
$$, 'every column of the work details tables has a comment');
select is_empty($$
  select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'app' and c.relname in ('person_work_details', 'person_emergency_contacts', 'person_loyalty_programs',
    'work_detail_shares', 'work_detail_events') and obj_description(c.oid, 'pg_class') is null
$$, 'every work details table has a comment');
select is_empty($$
  select p.oid::regprocedure::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('app', 'private') and p.proname in ('ensure_my_work_details', 'set_my_passport_number',
    'reveal_my_passport_number', 'share_work_details', 'revoke_work_detail_share', 'my_work_detail_sharing',
    'shared_work_details', 'reveal_shared_passport_number', 'erase_work_details', 'log_work_detail_event',
    'log_work_detail_change', 'work_detail_category_capabilities', 'can_read_work_detail_category',
    'work_detail_share_visible', 'close_work_detail_share', 'passport_number_key')
    and obj_description(p.oid, 'pg_proc') is null
$$, 'every work details function has a comment');
select results_eq($$select classification::text, read_capability from private.column_classifications
  where table_name = 'app.person_work_details' and column_name = 'passport_number'$$,
  $$values ('Restricted', 'data.restricted.read.government_id')$$, 'the passport number is classified Restricted (government identifier)');

-- Owner writes -------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('ivy');
insert into world select 'wd_ivy', app.ensure_my_work_details();
select is(app.ensure_my_work_details(), pg_temp.id('wd_ivy'), 'ensure_my_work_details returns the same row');
select lives_ok($$update app.person_work_details set shirt_size = 'M', shoe_size = 'US 9', dietary_needs = '{Vegan,Nut Free,Vegan}',
  allergies = 'Peanuts, severe', accessibility_needs = '{Seating}', seat_preference = 'Aisle', home_airport = 'MIA',
  passport_issuing_country = 'IT', passport_expires_on = '2031-04-30', passport_name = 'IVY MARCHETTI'
  where id = (select id from world where key = 'wd_ivy')$$, 'the owner fills in her work details');
select is((select dietary_needs::text from app.person_work_details where id = pg_temp.id('wd_ivy')), '{Vegan,"Nut Free"}',
  'each dietary need is kept once, in enum order');
select lives_ok($$insert into app.person_emergency_contacts (person_id, full_name, relationship, phone_e164, sort_order)
  values ((select id from world where key = 'ivy'), 'Marco Marchetti', 'Brother', '+393471234567', 0)$$, 'the owner adds an emergency contact');
select throws_ok($$insert into app.person_emergency_contacts (person_id, full_name, phone_e164)
  values ((select id from world where key = 'ivy'), 'Bad Number', '305-555-0142')$$, '23514', null, 'an emergency phone must be E.164');
select lives_ok($$insert into app.person_loyalty_programs (person_id, program_kind, program_name, member_number)
  values ((select id from world where key = 'ivy'), 'Airline', 'SkyMiles', 'SM-0000-TEST')$$, 'the owner adds a loyalty program');
select throws_ok($$insert into app.person_emergency_contacts (person_id, full_name, phone_e164)
  values ((select id from world where key = 'quinn'), 'Not Mine', '+13055550199')$$, '42501', null, 'nobody writes another person''s contacts');
insert into app.person_emergency_contacts (person_id, full_name, phone_e164, sort_order)
select pg_temp.id('ivy'), 'Contact ' || g, '+1305555010' || g, g from generate_series(1, 4) g;
select throws_ok($$insert into app.person_emergency_contacts (person_id, full_name, phone_e164)
  values ((select id from world where key = 'ivy'), 'Sixth Contact', '+13055550109')$$, 'XR001',
  'emergency_contact_limit: Keep at most 5; remove one first.', 'at most five live emergency contacts');
update app.person_emergency_contacts set deleted_at = now() where person_id = pg_temp.id('ivy') and full_name like 'Contact %';

-- Names (Section 15).
select lives_ok($$update app.people set given_name = 'Ivy', family_name = 'Marchetti' where id = (select id from world where key = 'ivy')$$,
  'the person records optional given and family names');
select is((select full_name from app.people where id = pg_temp.id('ivy')), 'Ivy Marchetti', 'the full name stays as given');

-- Passport number: Restricted and encrypted ---------------------------------------------------------------------------------
select throws_ok($$select passport_number from app.person_work_details$$, '42501', null, 'the Restricted ciphertext is never selectable, even by the owner');
select throws_ok($$update app.person_work_details set passport_number_last4 = '9999' where id = (select id from world where key = 'wd_ivy')$$,
  '42501', null, 'the passport columns have no update grant');
select throws_ok($$select app.set_my_passport_number('AB12')$$, 'XR001',
  'passport_number_format: A passport number has 5 to 20 letters and digits.', 'a passport number has 5 to 20 letters and digits');
select lives_ok($$select app.set_my_passport_number('ya 0000-TEST')$$, 'the owner sets her passport number through the RPC');
select is((select passport_number_last4 from app.person_work_details where id = pg_temp.id('wd_ivy')), 'TEST', 'only the last four are readable');
select is(app.reveal_my_passport_number(), 'YA0000TEST', 'the owner''s explicit reveal returns the cleaned number');
select is((select count(*)::int from app.work_detail_events where person_id = pg_temp.id('ivy') and action = 'passport.revealed' and org_id is null),
  1, 'the owner''s reveal is written to her access log');
select is((select count(*)::int from app.work_detail_events where person_id = pg_temp.id('ivy') and action = 'person_work_details.update'
  and changed_columns @> array['allergies', 'shirt_size']), 1, 'owner changes are logged with the changed column names');

-- Owner-only reads -------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('quinn');
select is((select count(*)::int from app.person_work_details), 0, 'another person reads no work details');
select is((select count(*)::int from app.person_emergency_contacts), 0, 'another person reads no emergency contacts');
select is((select count(*)::int from app.work_detail_events where person_id = pg_temp.id('ivy')), 0, 'another person reads none of her access log');
select pg_temp.as_user('alice');
select is((select count(*)::int from app.person_work_details) + (select count(*)::int from app.person_emergency_contacts)
  + (select count(*)::int from app.person_loyalty_programs), 0, 'the engaging org''s Owner reads none of it directly');
select is((select jsonb_array_length(d -> 'categories') from app.shared_work_details(pg_temp.id('eng_ivy_a')) d), 0,
  'before a share the org reads nothing');
select pg_temp.as_anon();
select throws_ok('select 1 from app.person_work_details', '42501', null, 'anon reads no work details');

-- Sharing with one engagement ----------------------------------------------------------------------------------------------------
select pg_temp.as_user('quinn');
select throws_ok(format($$select app.share_work_details('%s', '{Dietary Needs}')$$, pg_temp.id('eng_ivy_a')), 'XR001', null,
  'only the engaged person shares their work details');
select pg_temp.as_user('ivy');
select throws_ok(format($$select app.share_work_details('%s', '{}')$$, pg_temp.id('eng_ivy_a')), 'XR001',
  'work_detail_share_categories: Choose at least one category to share, or revoke the share.', 'at least one category');
select throws_ok(format($$insert into app.work_detail_shares (engagement_id, person_id, consent_record_id, categories)
  values ('%s', '%s', '%s', '{Passport}')$$, pg_temp.id('eng_ivy_a'), pg_temp.id('ivy'), gen_random_uuid()), '42501', null,
  'shares are written only through the RPC');
insert into world select 'share_a', app.share_work_details(pg_temp.id('eng_ivy_a'),
  array['Dietary Needs', 'Emergency Contacts', 'Passport', 'Dietary Needs']::app.work_detail_category[]);
select is((select categories::text from app.work_detail_shares where id = pg_temp.id('share_a')),
  '{"Emergency Contacts","Dietary Needs",Passport}', 'categories are kept once each');
select is((select count(*)::int from app.consent_records where person_id = pg_temp.id('ivy') and org_id = pg_temp.id('org_a')
  and purpose_code = 'work_details_sharing' and withdrawn_at is null), 1, 'sharing records work_details_sharing consent for the org');
select is((select count(*)::int from app.my_work_detail_sharing() where work_detail_share_id is not null), 1,
  'the owner sees which engagement shares what');

-- The engaging org reads what was shared.
select pg_temp.as_user('alice');
select is((select d -> 'readable' from app.shared_work_details(pg_temp.id('eng_ivy_a')) d),
  '["Emergency Contacts", "Dietary Needs", "Passport"]'::jsonb, 'the Owner reads every shared category');
select is((select d -> 'dietary' ->> 'allergies' from app.shared_work_details(pg_temp.id('eng_ivy_a')) d), 'Peanuts, severe',
  'the shared dietary needs reach the org');
select is((select jsonb_array_length(d -> 'emergency_contacts') from app.shared_work_details(pg_temp.id('eng_ivy_a')) d), 1,
  'the live emergency contacts reach the org');
select ok((select d -> 'uniform' = 'null'::jsonb and d -> 'travel' = 'null'::jsonb from app.shared_work_details(pg_temp.id('eng_ivy_a')) d),
  'unshared categories stay hidden');
select results_eq($$select d -> 'passport' ->> 'passport_number', d -> 'passport' ->> 'passport_number_last4',
  (d -> 'passport' ->> 'passport_number_masked')::boolean from app.shared_work_details((select id from world where key = 'eng_ivy_a')) d$$,
  $$values (null::text, 'TEST'::text, true)$$, 'the shared passport number is masked to its last four');
select is((select count(*)::int from app.work_detail_events where person_id = pg_temp.id('ivy') and action = 'work_details.viewed'
  and org_id = pg_temp.id('org_a')), 1, 'the org''s reads are logged once per reader in ten minutes');
select is((select count(*)::int from app.audit_events where org_id = pg_temp.id('org_a') and action = 'work_details.viewed'
  and subject_id = pg_temp.id('share_a')), 1, 'the org''s audit ledger records the read');
select is((select count(*)::int from app.work_detail_shares where id = pg_temp.id('share_a')), 1, 'the org sees the share itself');
select pg_temp.as_user('xavier');
select throws_ok(format($$select app.shared_work_details('%s')$$, pg_temp.id('eng_ivy_a')), '42501', null,
  'cross-tenant: another org reads nothing of the share');
select is((select jsonb_array_length(d -> 'categories') from app.shared_work_details(pg_temp.id('eng_ivy_b')) d), 0,
  'a share serves one engagement: the other org of the same person reads nothing');

-- The audited reveal by the org.
select pg_temp.as_user('bob');
select throws_ok(format($$select app.reveal_shared_passport_number('%s', 'Booking the June flights.')$$, pg_temp.id('eng_ivy_a')),
  '42501', null, 'an Admin without data.restricted.read.government_id cannot reveal it');
select pg_temp.as_user('alice');
select throws_ok(format($$select app.reveal_shared_passport_number('%s', 'Booking the June flights.')$$, pg_temp.id('eng_ivy_a')),
  'XR001', null, 'the reveal needs step-up authentication');
select pg_temp.as_user_aal2('alice');
select throws_ok(format($$select app.reveal_shared_passport_number('%s', 'Flights')$$, pg_temp.id('eng_ivy_a')), 'XR001',
  'passport_reveal_reason: Write why you need the passport number, in at least 10 characters.', 'the reveal needs a reason');
select is(app.reveal_shared_passport_number(pg_temp.id('eng_ivy_a'), 'Booking the June flights.'), 'YA0000TEST',
  'the Owner with a second factor and a reason reveals the number');
select is((select count(*)::int from app.audit_events where org_id = pg_temp.id('org_a') and action = 'work_details.passport_revealed'
  and diff ->> 'reason' = 'Booking the June flights.' and diff::text not like '%0000TEST%'), 1,
  'the org''s audit ledger records the reveal and its reason, never the value');
select pg_temp.as_user('ivy');
select is((select count(*)::int from app.work_detail_events where person_id = pg_temp.id('ivy') and action = 'passport.revealed'
  and org_id = pg_temp.id('org_a') and reason = 'Booking the June flights.'), 1, 'the person sees who revealed it and why');
select is((select count(*)::int from app.work_detail_events where person_id = pg_temp.id('ivy')
  and (coalesce(reason, '') || changed_columns::text) like '%0000TEST%'), 0, 'the access log never holds the value');

-- Narrowing and revoking ------------------------------------------------------------------------------------------------------------
select is(app.share_work_details(pg_temp.id('eng_ivy_a'), '{Emergency Contacts}'), pg_temp.id('share_a'),
  'sharing again changes the same live share');
select pg_temp.as_user('alice');
select is((select d -> 'dietary' from app.shared_work_details(pg_temp.id('eng_ivy_a')) d), 'null'::jsonb,
  'a narrowed share hides the removed category at once');
select pg_temp.as_user('ivy');
select lives_ok(format($$select app.revoke_work_detail_share('%s')$$, pg_temp.id('share_a')), 'the person revokes the share');
select ok((select withdrawn_at is not null from app.consent_records where person_id = pg_temp.id('ivy') and org_id = pg_temp.id('org_a')
  and purpose_code = 'work_details_sharing'), 'revoking the org''s last share withdraws the consent');
select pg_temp.as_user('alice');
select is((select jsonb_array_length(d -> 'categories') from app.shared_work_details(pg_temp.id('eng_ivy_a')) d), 0,
  'after revocation the org reads nothing');
select pg_temp.as_user_aal2('alice');
select throws_ok(format($$select app.reveal_shared_passport_number('%s', 'Booking the June flights.')$$, pg_temp.id('eng_ivy_a')),
  'XR001', 'work_detail_not_shared: The person has not shared their passport details with this engagement.', 'nor reveals anything');

-- A closed engagement shares nothing.
select pg_temp.as_user('ivy');
insert into world select 'share_a2', app.share_work_details(pg_temp.id('eng_ivy_a'), '{Uniform Sizes}');
select pg_temp.move_engagement('eng_ivy_a', 'Onboarding', 'Canceled');
select pg_temp.as_user('alice');
select ok((select d -> 'uniform' = 'null'::jsonb and not (d ->> 'sharing_open')::boolean
  from app.shared_work_details(pg_temp.id('eng_ivy_a')) d), 'a canceled engagement reads nothing, share or not');
select pg_temp.as_user('ivy');
select throws_ok(format($$select app.share_work_details('%s', '{Passport}')$$, pg_temp.id('eng_ivy_a')), 'XR001',
  'work_detail_share_closed: This engagement is complete or canceled, so nothing more is shared with it.', 'nor takes a new share');

-- Account deletion erases the work details ----------------------------------------------------------------------------------------------
select pg_temp.as_user('ivy');
insert into world select 'share_b', app.share_work_details(pg_temp.id('eng_ivy_b'), '{Travel Profile}');
select pg_temp.as_platform();
update app.people set full_name = null, deleted_at = now() where id = pg_temp.id('ivy');
select is((select count(*)::int from app.person_work_details where person_id = pg_temp.id('ivy'))
  + (select count(*)::int from app.person_emergency_contacts where person_id = pg_temp.id('ivy'))
  + (select count(*)::int from app.person_loyalty_programs where person_id = pg_temp.id('ivy')), 0,
  'deleting the person erases their work details');
select ok((select revoked_at is not null from app.work_detail_shares where id = pg_temp.id('share_b')),
  'and revokes their live shares');

select * from finish();
rollback;

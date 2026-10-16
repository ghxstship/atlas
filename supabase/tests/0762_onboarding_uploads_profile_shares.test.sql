-- pgTAP: migration 0762. Onboarding uploads (Section 4.4.4, Section 8.7): the party uploads into the private
-- onboarding-uploads bucket only under their own open item, org members who read the engagement read the file,
-- strangers and other tenants never do, and registering the upload makes a document version and submits the item.
-- Profile shares the caller gave: own and account shares, never an org's received shares.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

select * from no_plan();

create function pg_temp.n(p_who text, p_sql text) returns integer
language plpgsql as $$
declare v integer;
begin
  perform pg_temp.as_user(p_who);
  execute 'select count(*)::int from (' || p_sql || ') x' into v;
  perform pg_temp.as_platform();
  return v;
end $$;

-- Fixture: a blocking Document Upload requirement and its item on ivy's Northwind engagement ------------------------------
select pg_temp.as_user('carol');
insert into app.onboarding_requirements (org_id, name, item_kind, role_type, verification_method)
values (pg_temp.id('org_a'), 'Certificate of Insurance', 'Document Upload', 'Crew', 'Reviewer');
select pg_temp.as_platform();
with i as (
  insert into app.onboarding_items (engagement_id, onboarding_requirement_id)
  select pg_temp.id('eng_ivy_a'), r.id from app.onboarding_requirements r where r.name = 'Certificate of Insurance' and r.org_id = pg_temp.id('org_a')
  returning id)
insert into world select 'item_ivy', id from i;
create function pg_temp.path(p_file text) returns text language sql as $$
  select pg_temp.id('org_a') || '/' || pg_temp.id('eng_ivy_a') || '/' || pg_temp.id('item_ivy') || '/' || p_file;
$$;

select ok(exists (select 1 from storage.buckets where id = 'onboarding-uploads' and not public), 'the bucket exists and is private');

-- Uploads ------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('ivy');
select lives_ok(format($$insert into storage.objects (bucket_id, name) values ('onboarding-uploads', %L)$$, pg_temp.path('coi.pdf')),
  'own engagement: the party uploads under their open onboarding item');
select throws_ok(format($$insert into storage.objects (bucket_id, name) values ('onboarding-uploads', %L)$$,
  pg_temp.id('org_a') || '/' || pg_temp.id('eng_ivy_a') || '/coi.pdf'), '42501', null, 'a name outside the item layout is refused');
select pg_temp.as_platform();
select pg_temp.as_user('quinn');
select throws_ok(format($$insert into storage.objects (bucket_id, name) values ('onboarding-uploads', %L)$$, pg_temp.path('other.pdf')),
  '42501', null, 'denial: another party cannot upload into this engagement');
select pg_temp.as_platform();
select pg_temp.as_anon();
select throws_ok(format($$insert into storage.objects (bucket_id, name) values ('onboarding-uploads', %L)$$, pg_temp.path('anon.pdf')),
  '42501', null, 'anon deny');
select pg_temp.as_platform();

-- The scanner reports the file Clean first: only the uploader reads an unscanned file (A22-011, 1041).
update private.object_scans set scan_status = 'Clean', scanned_at = now() where bucket_id = 'onboarding-uploads';
select is(pg_temp.n('ivy', $$select 1 from storage.objects where bucket_id = 'onboarding-uploads'$$), 1, 'the party reads their upload');
select is(pg_temp.n('carol', $$select 1 from storage.objects where bucket_id = 'onboarding-uploads'$$), 1, 'same tenant: a Manager reads the upload');
select is(pg_temp.n('xavier', $$select 1 from storage.objects where bucket_id = 'onboarding-uploads'$$), 0, 'cross tenant: another org reads none');
select is(pg_temp.n('quinn', $$select 1 from storage.objects where bucket_id = 'onboarding-uploads'$$), 0, 'denial: another party reads none');
select is(pg_temp.n('gina', $$select 1 from storage.objects where bucket_id = 'onboarding-uploads'$$), 0, 'role band: a Viewer outside the project reads none');

-- Registering ------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('quinn');
select throws_ok(format($$select app.register_onboarding_upload(%L, 'Certificate', '%s')$$, pg_temp.path('coi.pdf'), repeat('a', 64)),
  '42501', null, 'denial: another party cannot register the upload');
select pg_temp.as_platform();
select pg_temp.as_user('ivy');
select throws_ok(format($$select app.register_onboarding_upload(%L, 'Certificate', '%s')$$, pg_temp.path('missing.pdf'), repeat('a', 64)),
  'XR001', null, 'a file must be uploaded before it is registered');
select throws_ok(format($$select app.register_onboarding_upload(%L, 'Certificate', 'not-a-checksum')$$, pg_temp.path('coi.pdf')),
  'XR001', null, 'the checksum must be SHA-256 hex');
select lives_ok(format($$select app.register_onboarding_upload(%L, 'Certificate of Insurance', '%s')$$, pg_temp.path('coi.pdf'), repeat('b', 64)),
  'the party registers the upload');
select pg_temp.as_platform();
select ok((select submitted_at is not null and document_id is not null from app.onboarding_items where id = pg_temp.id('item_ivy')),
  'registering submits the item with its document');
select is((select v.storage_uri from app.onboarding_items i join app.document_versions v on v.document_id = i.document_id
  where i.id = pg_temp.id('item_ivy')), 'storage://onboarding-uploads/' || pg_temp.path('coi.pdf'), 'the document version points at the object');
select is((select d.project_id from app.onboarding_items i join app.documents d on d.id = i.document_id where i.id = pg_temp.id('item_ivy')),
  pg_temp.id('prj_a'), 'the document belongs to the engagement''s project');

-- The onboarding area closes at Complete ------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
insert into app.onboarding_verifications (onboarding_item_id, outcome) values (pg_temp.id('item_ivy'), 'Passed');
select pg_temp.as_platform();
select pg_temp.move_engagement('eng_ivy_a', 'Onboarding', 'Active');
select pg_temp.move_engagement('eng_ivy_a', 'Active', 'Closing');
select pg_temp.move_engagement('eng_ivy_a', 'Closing', 'Complete');
select pg_temp.as_user('ivy');
select throws_ok(format($$insert into storage.objects (bucket_id, name) values ('onboarding-uploads', %L)$$, pg_temp.path('late.pdf')),
  '42501', null, 'Complete: uploads close with the onboarding area');
select pg_temp.as_platform();

-- Profile shares the caller gave -----------------------------------------------------------------------------------------------------
select pg_temp.as_user('ivy');
select app.share_profile(pg_temp.id('org_a'), array['headline', 'city'], array['Head Rigger', 'Miami']);
select pg_temp.as_user('victor');
select app.share_profile(pg_temp.id('org_a'), array['headline'], array['Touring audio'], pg_temp.id('acct_v'));
select pg_temp.as_platform();
select is(pg_temp.n('ivy', 'select 1 from api_external.my_profile_shares'), 1, 'own: the person lists their share');
select is(pg_temp.n('ivy', 'select 1 from api_external.my_profile_share_fields'), 2, 'with each shared field');
select is(pg_temp.n('victor', 'select 1 from api_external.my_profile_shares'), 1, 'account: the Owner lists the account share');
select is(pg_temp.n('fiona', 'select 1 from api_external.my_profile_shares'), 0, 'Account Finance does not manage company shares');
select is(pg_temp.n('quinn', 'select 1 from api_external.my_profile_shares'), 0, 'denial: another person lists none');
select is(pg_temp.n('alice', 'select 1 from api_external.my_profile_shares'), 0, 'the receiving org never lists shares here');
select pg_temp.as_user('ivy');
select lives_ok($$select app.revoke_profile_share((select id from api_external.my_profile_shares))$$, 'the owner revokes from the list');
select ok((select revoked_at is not null from api_external.my_profile_shares), 'the revocation shows in the list');
select pg_temp.as_platform();

select * from finish();
rollback;

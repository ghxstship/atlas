-- pgTAP: migration 6071. Files a vendor engagement uploaded wait for whoever records certificates, until someone reviews
-- them or a certificate points at them. Recording a certificate verifies nothing, and holders of vendors.coi.write may read
-- a vendor's file while nobody else outside the engagement may.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

select plan(13);

create function pg_temp.uploads(p_who text) returns integer
language plpgsql as $$
declare v integer;
begin
  perform pg_temp.as_user(p_who);
  select count(*)::int into v from app.vendor_certificate_uploads(pg_temp.id('org_a'));
  perform pg_temp.as_platform();
  return v;
end $$;

-- Bayside Audio is a vendor of org_a. Its engagement and Ivy's crew engagement each uploaded a file.
select pg_temp.as_platform();
with v as (insert into app.vendors (org_id, counterparty_id) values (pg_temp.id('org_a'), pg_temp.id('cp_v_a')) returning id)
insert into world select 'vendor_a', id from v;
with r as (insert into app.onboarding_requirements (org_id, name, item_kind, verification_method)
  values (pg_temp.id('org_a'), 'Proof of Coverage', 'Document Upload', 'Reviewer') returning id)
insert into world select 'req', id from r;
with i as (insert into app.onboarding_items (engagement_id, onboarding_requirement_id)
  values (pg_temp.id('eng_vendor_a'), pg_temp.id('req')) returning id)
insert into world select 'item_v', id from i;
with i as (
  select i.id from app.onboarding_items i where i.engagement_id = pg_temp.id('eng_ivy_a') and i.onboarding_requirement_id = pg_temp.id('req')
), made as (
  insert into app.onboarding_items (engagement_id, onboarding_requirement_id)
  select pg_temp.id('eng_ivy_a'), pg_temp.id('req') where not exists (select 1 from i) returning id
)
insert into world select 'item_i', id from (select id from i union all select id from made) x;
create function pg_temp.upload(p_item text, p_engagement text, p_file text) returns text
language plpgsql as $$
declare v_doc uuid; v_uri text;
begin
  v_uri := 'storage://onboarding-uploads/' || pg_temp.id('org_a') || '/' || pg_temp.id(p_engagement) || '/' || pg_temp.id(p_item) || '/' || p_file;
  insert into app.documents (org_id, project_id, title) values (pg_temp.id('org_a'), pg_temp.id('prj_a'), 'Proof of Coverage') returning id into v_doc;
  insert into app.document_versions (document_id, storage_uri, checksum_sha256) values (v_doc, v_uri, repeat('a', 64));
  update app.onboarding_items set document_id = v_doc, submitted_at = now() where id = pg_temp.id(p_item);
  return v_uri;
end $$;

select is(pg_temp.uploads('carol'), 0, 'an item nobody uploaded for waits for nothing');
create temporary table f (key text primary key, uri text);
grant select on f to public;
insert into f values ('v', pg_temp.upload('item_v', 'eng_vendor_a', 'coi.pdf'));
insert into f values ('i', pg_temp.upload('item_i', 'eng_ivy_a', 'coi.pdf'));

-- Who sees it ---------------------------------------------------------------------------------------------------------
select is(pg_temp.uploads('carol'), 1, 'whoever records certificates sees the vendor''s upload, and not a crew member''s');
select pg_temp.as_user('carol');
select is((select u.item_name || '/' || u.vendor_id::text || '/' || u.storage_uri from app.vendor_certificate_uploads(pg_temp.id('org_a')) u),
  'Proof of Coverage/' || pg_temp.id('vendor_a')::text || '/' || (select uri from f where key = 'v'),
  'under whatever name the org gave it, with its vendor and its file');
select pg_temp.as_platform();
select is(pg_temp.uploads('gina'), 0, 'a Viewer without vendors.coi.write gets no rows');
select is(pg_temp.uploads('xavier'), 0, 'nor does another org');
select is(pg_temp.uploads('sam'), 0, 'nor does the vendor''s own person');

-- Reading the file ------------------------------------------------------------------------------------------------------
create function pg_temp.reads(p_who text, p_uri text) returns boolean
language plpgsql as $$
declare v boolean;
begin
  -- As the storage policy calls it: with the person's claims, under a role that reaches the private schema.
  perform pg_temp.as_user(p_who);
  perform set_config('role', 'postgres', true);
  v := private.onboarding_upload_readable(replace(p_uri, 'storage://onboarding-uploads/', ''));
  perform pg_temp.as_platform();
  return v;
end $$;
select ok(pg_temp.reads('carol', (select uri from f where key = 'v')), 'a holder of vendors.coi.write may read a vendor''s file');
select ok(not pg_temp.reads('xavier', (select uri from f where key = 'v')), 'another org may not');

-- Recording a certificate takes it off the list, and verifies nothing -------------------------------------------------------
select pg_temp.as_user('carol');
with c as (insert into app.insurance_certificates (vendor_id, insurer, policy_identifier, coverage_type, valid_from, valid_to, document_uri)
  values (pg_temp.id('vendor_a'), 'Atlantic Mutual', 'GL-1', 'General Liability', current_date, current_date + 365, (select uri from f where key = 'v'))
  returning id)
insert into world select 'cert', id from c;
select pg_temp.as_platform();
select is(pg_temp.uploads('carol'), 0, 'a certificate recorded from the upload takes it off the list');
select is((select count(*)::integer from app.onboarding_verifications ov where ov.onboarding_item_id = pg_temp.id('item_v')), 0,
  'recording a certificate verifies nothing');
select is((select i.submitted_at is not null from app.onboarding_items i where i.id = pg_temp.id('item_v')), true, 'and the item still waits for its reviewer');

select pg_temp.as_user('carol');
update app.insurance_certificates set deleted_at = now() where id = pg_temp.id('cert');
select pg_temp.as_platform();
select is(pg_temp.uploads('carol'), 1, 'removing the certificate brings it back');

-- A reviewer's decision takes it off the list -----------------------------------------------------------------------------
select pg_temp.as_user('carol');
insert into app.onboarding_verifications (onboarding_item_id, outcome, note) values (pg_temp.id('item_v'), 'Failed', 'Not a certificate.');
select pg_temp.as_platform();
select is(pg_temp.uploads('carol'), 0, 'a reviewed upload no longer waits');

select * from finish();
rollback;

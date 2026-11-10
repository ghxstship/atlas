-- pgTAP: migration 6801. Files a vendor engagement uploaded wait for whoever records certificates until a certificate
-- points at them, a review fails them or the scanner refuses them. A passed review keeps them, because it records no
-- certificate. Recording a certificate verifies nothing, and who may open the file is unchanged.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

select plan(30);

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
  insert into private.object_scans (bucket_id, object_name, scan_status, scanned_at)
  values ('onboarding-uploads', replace(v_uri, 'storage://onboarding-uploads/', ''), 'Clean', now());
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
-- A Contractor engagement whose counterparty is also the vendor is not a vendor engagement.
insert into app.engagements (project_id, person_id, counterparty_id, role_type, role_code, worker_classification, pay_basis,
  arrangement, start_date)
values (pg_temp.id('prj_a'), pg_temp.id('sam'), pg_temp.id('cp_v_a'), 'Contractor', '9000.50.02', 'VENDOR_SUPPLIED', 'Day Rate',
  'Per Engagement', '2027-06-01');
insert into world select 'eng_contractor_a', e.id from app.engagements e
where e.counterparty_id = pg_temp.id('cp_v_a') and e.role_type = 'Contractor';
update app.engagements set engagement_state = 'Onboarding' where id = pg_temp.id('eng_contractor_a');
insert into world select 'item_c', i.id from app.onboarding_items i
where i.engagement_id = pg_temp.id('eng_contractor_a') and i.onboarding_requirement_id = pg_temp.id('req');
select pg_temp.upload('item_c', 'eng_contractor_a', 'coi.pdf');
select is(pg_temp.uploads('carol'), 1, 'nor a Contractor engagement whose counterparty is also a vendor');
select is(pg_temp.uploads('sam'), 0, 'nor does the vendor''s own person');

-- Reading the file: unchanged by 6801 --------------------------------------------------------------------------------------
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
select ok(pg_temp.reads('carol', (select uri from f where key = 'v')), 'whoever reads the engagement may read the vendor''s file');
select ok(not pg_temp.reads('xavier', (select uri from f where key = 'v')), 'another org may not');
select ok(position('vendors.coi.write' in pg_get_functiondef('private.onboarding_upload_readable(text)'::regprocedure)) = 0,
  'and holding vendors.coi.write opens no file by itself');

-- What the scanner says --------------------------------------------------------------------------------------------------
create function pg_temp.scan_of(p_uri text) returns text
language sql as $$ select s.scan_status::text from private.object_scans s where s.object_name = replace(p_uri, 'storage://onboarding-uploads/', '') $$;
create function pg_temp.set_scan(p_uri text, p_status text) returns void
language sql as $$
  update private.object_scans s
  set scan_status = p_status::app.scan_status, scanned_at = case when p_status = 'Scanning' then null else now() end
  where s.object_name = replace(p_uri, 'storage://onboarding-uploads/', '') $$;
create function pg_temp.listed_scan() returns text
language plpgsql as $$
declare v text;
begin
  perform pg_temp.as_user('carol');
  select u.scan_status into v from app.vendor_certificate_uploads(pg_temp.id('org_a')) u;
  perform pg_temp.as_platform();
  return v;
end $$;
select is(pg_temp.listed_scan(), 'Clean', 'a cleared file says so');
select pg_temp.set_scan((select uri from f where key = 'v'), 'Scanning');
select is(pg_temp.listed_scan(), 'Scanning', 'a file still being scanned is listed, and says so');
select pg_temp.set_scan((select uri from f where key = 'v'), 'Infected');
select is(pg_temp.uploads('carol'), 0, 'an infected file is not listed');
select pg_temp.set_scan((select uri from f where key = 'v'), 'Scan Failed');
select is(pg_temp.uploads('carol'), 0, 'nor one the scanner refused');
delete from private.object_scans s where s.object_name = replace((select uri from f where key = 'v'), 'storage://onboarding-uploads/', '');
select is(pg_temp.uploads('carol'), 0, 'nor one the scanner removed');
insert into private.object_scans (bucket_id, object_name, scan_status, scanned_at)
values ('onboarding-uploads', replace((select uri from f where key = 'v'), 'storage://onboarding-uploads/', ''), 'Clean', now());

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

-- A review ---------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
update app.insurance_certificates set deleted_at = now() where id = pg_temp.id('cert') and deleted_at is null;
select is((select u.review_passed from app.vendor_certificate_uploads(pg_temp.id('org_a')) u), false, 'before a review it is not passed');
insert into app.onboarding_verifications (onboarding_item_id, outcome, note) values (pg_temp.id('item_v'), 'Passed', 'Checked.');
select pg_temp.as_platform();
select is(pg_temp.uploads('carol'), 1, 'a passed review keeps it listed, since it recorded no certificate');
select pg_temp.as_user('carol');
select is((select u.review_passed from app.vendor_certificate_uploads(pg_temp.id('org_a')) u), true, 'and says it passed');
select pg_temp.as_platform();
update app.onboarding_items set submitted_at = now() + interval '1 second' where id = pg_temp.id('item_v');
select pg_temp.as_user('carol');
select is((select u.review_passed from app.vendor_certificate_uploads(pg_temp.id('org_a')) u), false, 'a new upload after it waits for review again');
insert into app.onboarding_verifications (onboarding_item_id, outcome, note) values (pg_temp.id('item_v'), 'Failed', 'Not a certificate.');
select pg_temp.as_platform();
-- Back to the upload this review is of: inside one transaction every timestamp is the same instant.
update app.onboarding_items set submitted_at = now() where id = pg_temp.id('item_v');
select is(pg_temp.uploads('carol'), 0, 'a failed review takes it off the list');
create function pg_temp.vendor_awaits() returns boolean
language plpgsql as $$
declare v boolean;
begin
  perform pg_temp.as_user('sam');
  select o.awaiting_review into v from api_external.onboarding_items o where o.id = pg_temp.id('item_v');
  perform pg_temp.as_platform();
  return v;
end $$;
select is(pg_temp.vendor_awaits(), false, 'and the vendor reads it as no longer waiting');
update app.onboarding_items set submitted_at = now() + interval '1 second' where id = pg_temp.id('item_v');
select is(pg_temp.uploads('carol'), 1, 'and a new upload brings it back');
select is(pg_temp.vendor_awaits(), true, 'which the vendor reads as received and waiting for review, as the staff list does');
select pg_temp.set_scan((select uri from f where key = 'v'), 'Infected');
select is(pg_temp.vendor_awaits(), false, 'but not a file the scanner refused');
select pg_temp.set_scan((select uri from f where key = 'v'), 'Clean');

-- Bounded ----------------------------------------------------------------------------------------------------------------
do $$
declare v_req uuid; v_item uuid; v_doc uuid; v_uri text;
begin
  for g in 1..50 loop
    insert into app.onboarding_requirements (org_id, name, item_kind, verification_method)
    values (pg_temp.id('org_a'), 'Extra ' || g, 'Document Upload', 'Reviewer') returning id into v_req;
    insert into app.onboarding_items (engagement_id, onboarding_requirement_id) values (pg_temp.id('eng_vendor_a'), v_req) returning id into v_item;
    v_uri := 'storage://onboarding-uploads/' || pg_temp.id('org_a') || '/' || pg_temp.id('eng_vendor_a') || '/' || v_item || '/x.pdf';
    insert into app.documents (org_id, project_id, title) values (pg_temp.id('org_a'), pg_temp.id('prj_a'), 'Extra') returning id into v_doc;
    insert into app.document_versions (document_id, storage_uri, checksum_sha256) values (v_doc, v_uri, repeat('b', 64));
    update app.onboarding_items set document_id = v_doc, submitted_at = now() where id = v_item;
    insert into private.object_scans (bucket_id, object_name, scan_status, scanned_at)
    values ('onboarding-uploads', replace(v_uri, 'storage://onboarding-uploads/', ''), 'Clean', now());
  end loop;
end $$;
select is(pg_temp.uploads('carol'), 50, 'the list holds at most 50');
select pg_temp.as_user('carol');
select is((select max(u.total_count) from app.vendor_certificate_uploads(pg_temp.id('org_a')) u), 51, 'and says how many there are');
select pg_temp.as_platform();

select * from finish();
rollback;

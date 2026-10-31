-- pgTAP: migration 2713 (R9), sponsor-supplied brand assets. The sponsor's Owner supplies a logo with files from its
-- entitlement's folder; the org approves or returns it under the separation rule; the sponsor resubmits with revision 1
-- files; the sponsor's own approval path and the org's resubmit are refused with sponsor_asset_source; files are
-- required, from the right folder and attached once; the sponsor reads its assets and their files.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

select no_plan();

create function pg_temp.spon(p_file text) returns text
language sql stable as $$ select pg_temp.id('org_a') || '/sponsor-asset/' || pg_temp.id('ent') || '/' || p_file $$;

-- Uploads and registers a file as p_who, returning the document id.
create function pg_temp.doc(p_who text, p_name text) returns uuid
language plpgsql as $$
begin
  perform pg_temp.as_user(p_who);
  insert into storage.objects (bucket_id, name, owner_id, metadata)
  values ('party-uploads', p_name, pg_temp.id(p_who || '_user')::text, jsonb_build_object('mimetype', 'image/png', 'size', 4096));
  return app.register_party_upload(p_name, regexp_replace(p_name, '^.*/', ''), repeat('b', 64));
end $$;

-- Fixture: Brightwave Drinks sponsors prj_a; Sol owns its account ------------------------------------------------------------
select pg_temp.new_user('sol', 'sol@brightwave-drinks.test', 'Sol Ferreira');
select pg_temp.as_user('sol');
insert into world values ('acct_s', app.create_external_account('Brightwave Drinks', 'brightwave-drinks'));
select pg_temp.as_user('alice');
insert into world values ('cp_s_a', app.create_counterparty(pg_temp.id('org_a'), null, null, pg_temp.id('acct_s')));
with e as (insert into app.engagements (project_id, person_id, counterparty_id, role_type, start_date)
  values (pg_temp.id('prj_a'), pg_temp.id('sol'), pg_temp.id('cp_s_a'), 'Sponsor', '2027-06-01') returning id) insert into world select 'eng_sponsor', id from e;
select pg_temp.as_user('carol');
with s as (insert into app.sponsor_entitlements (project_id, counterparty_id, description, quantity)
  values (pg_temp.id('prj_a'), pg_temp.id('cp_s_a'), 'Main stage banner placement', 2) returning id) insert into world select 'ent', id from s;
select pg_temp.move_engagement('eng_sponsor', 'Onboarding', 'Active');

-- Supplying -----------------------------------------------------------------------------------------------------------------------
insert into world values ('logo_v0', pg_temp.doc('sol', pg_temp.spon('logo.png')));
select pg_temp.as_user('sol');
select throws_ok($$select app.supply_sponsor_asset((select id from world where key = 'ent'), 'Logo', 'Brightwave logo', null, null, '{}')$$,
  'XR001', 'sponsor_asset_files_required: Attach 1 to 10 files.', 'an asset is supplied with files');
select throws_ok($$select app.supply_sponsor_asset((select id from world where key = 'ent'), 'Logo', 'Brightwave logo', null, null,
  array[gen_random_uuid()])$$, 'XR001', 'sponsor_asset_files_invalid: Each file is uploaded for this entitlement and attached once.',
  'a document from anywhere else is refused');
select pg_temp.as_user('ivy');
select throws_ok($$select app.supply_sponsor_asset((select id from world where key = 'ent'), 'Logo', 'Fake', null, null,
  array[(select id from world where key = 'logo_v0')])$$, '42501', null, 'someone who does not answer for the sponsor cannot supply');
select pg_temp.as_user('sol');
insert into world values ('asset', app.supply_sponsor_asset(pg_temp.id('ent'), 'Logo', 'Brightwave logo', 'Stage screens', '2027-05-15',
  array[pg_temp.id('logo_v0')]));
select pg_temp.as_platform();
select is((select asset_source::text || ' ' || asset_state::text || ' ' || revision from app.sponsor_assets where id = pg_temp.id('asset')),
  'Sponsor Supplied Submitted 0', 'the asset is Sponsor Supplied and Submitted at revision 0');
select is((select reason from app.sponsor_asset_state_transitions where sponsor_asset_id = pg_temp.id('asset') and to_state = 'Submitted'),
  'Supplied by the sponsor.', 'the ledger says the sponsor supplied it');
select is((select count(*)::int from app.sponsor_asset_files where sponsor_asset_id = pg_temp.id('asset') and revision = 0), 1, 'with its file at revision 0');
insert into world values ('spare', pg_temp.doc('sol', pg_temp.spon('spare.png')));
select pg_temp.as_platform();
select throws_ok($$insert into app.sponsor_asset_files (sponsor_asset_id, revision, document_id, position)
  values ((select id from world where key = 'asset'), 0, (select id from world where key = 'spare'), 2)$$,
  'XR001', 'sponsor_asset_files_invalid: Files are supplied with app.supply_sponsor_asset or app.resubmit_sponsor_asset.', 'files are never inserted directly');
select pg_temp.as_user('sol');
select is((select awaiting_sponsor from api_external.sponsor_assets where id = pg_temp.id('asset')), false, 'a submitted sponsor asset awaits the org');
select is((select asset_source::text from api_external.sponsor_assets where id = pg_temp.id('asset')), 'Sponsor Supplied', 'Gateway shows who supplied it');
select is((select count(*)::int from api_external.sponsor_asset_files where sponsor_asset_id = pg_temp.id('asset')), 1, 'and its files');
select throws_ok($$select app.respond_sponsor_asset((select id from world where key = 'asset'), 'Submitted', 'Approved', null)$$,
  'XR001', 'sponsor_asset_source: The org approves the assets the sponsor supplies; resubmit a returned one with new files.',
  'the sponsor never approves its own asset');

-- The org returns, the sponsor resubmits, the org approves ---------------------------------------------------------------------------
select pg_temp.as_user('carol');
select lives_ok($$select app.transition_sponsor_asset((select id from world where key = 'asset'), 'Submitted', 'Returned', 'Use the white version.')$$,
  'the org returns the asset with a reason');
select throws_ok($$select app.transition_sponsor_asset((select id from world where key = 'asset'), 'Returned', 'Submitted', 'Resubmitted.')$$,
  'XR001', 'sponsor_asset_source: The org approves, returns or cancels a submitted asset the sponsor supplied; the sponsor resubmits it.',
  'the org never resubmits the sponsor''s asset');
select pg_temp.as_user('sol');
select is((select awaiting_sponsor from api_external.sponsor_assets where id = pg_temp.id('asset')), true, 'a returned sponsor asset awaits the sponsor');
insert into world values ('logo_v1', pg_temp.doc('sol', pg_temp.spon('logo-white.png')));
select pg_temp.as_user('sol');
select throws_ok($$select app.resubmit_sponsor_asset((select id from world where key = 'asset'), array[(select id from world where key = 'logo_v0')], null)$$,
  'XR001', 'sponsor_asset_files_invalid: Each file is uploaded for this entitlement and attached once.', 'a file already attached is not attached again');
select lives_ok($$select app.resubmit_sponsor_asset((select id from world where key = 'asset'), array[(select id from world where key = 'logo_v1')], 'White version.')$$,
  'the sponsor resubmits with a new file');
select pg_temp.as_platform();
select is((select asset_state::text || ' ' || revision from app.sponsor_assets where id = pg_temp.id('asset')), 'Submitted 1', 'Submitted again at revision 1');
select is((select document_id from app.sponsor_asset_files where sponsor_asset_id = pg_temp.id('asset') and revision = 1), pg_temp.id('logo_v1'),
  'the new file is revision 1''s');
select pg_temp.as_user('carol');
select lives_ok($$select app.transition_sponsor_asset((select id from world where key = 'asset'), 'Submitted', 'Approved', 'Looks right.')$$,
  'the org approves it');
select pg_temp.as_platform();
select is((select decided_by from app.sponsor_assets where id = pg_temp.id('asset')), pg_temp.id('carol'), 'stamped with the org''s reviewer');

-- Separation and the org's own assets ------------------------------------------------------------------------------------------------
select pg_temp.as_user('sol');
insert into world values ('art_v0', app.supply_sponsor_asset(pg_temp.id('ent'), 'Artwork', 'Banner art', null, null,
  array[pg_temp.doc('sol', pg_temp.spon('banner.png'))]));
select pg_temp.as_user('sol');
select throws_ok($$select app.transition_sponsor_asset((select id from world where key = 'art_v0'), 'Submitted', 'Approved', 'Mine.')$$,
  '42501', null, 'the sponsor has no org authority to approve');
select pg_temp.as_user('carol');
with a as (insert into app.sponsor_assets (sponsor_entitlement_id, asset_kind, title) values (pg_temp.id('ent'), 'Copy', 'PA script') returning id)
insert into world select 'org_asset', id from a;
select app.transition_sponsor_asset(pg_temp.id('org_asset'), 'Proposed', 'Submitted', 'For the sponsor.');
select throws_ok($$select app.transition_sponsor_asset((select id from world where key = 'org_asset'), 'Submitted', 'Approved', 'Own work.')$$,
  'XR001', null, 'the org''s uploader still cannot approve its own asset (sod_approval_requester)');
select pg_temp.as_user('sol');
select lives_ok($$select app.respond_sponsor_asset((select id from world where key = 'org_asset'), 'Submitted', 'Approved', null)$$,
  'the sponsor still approves the org''s assets');
select throws_ok($$select app.resubmit_sponsor_asset((select id from world where key = 'org_asset'), array[gen_random_uuid()], null)$$,
  '42501', null, 'resubmitting is only for the sponsor''s own assets');

select * from finish();
rollback;

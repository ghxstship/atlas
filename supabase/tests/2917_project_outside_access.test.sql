-- pgTAP: migration 2917, B2 (RRR-226, ADR 0141). app.project_outside_access lists every source of outside access on one
-- project: live view and display links, file links with their opens, advance and signing links, a roster invitation, pack
-- recipients with their activity, intake and form links, and an external Contractor engagement with its party's name. Each
-- source's own policy decides what a member sees, a partner org sees nothing, and neither anon nor the backup login selects it.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

select plan(26);

create temporary table k (key text primary key, id uuid, val text);
grant select, insert, update, delete on k to public;

create function pg_temp.k(p_key text) returns uuid language sql stable as $$ select id from k where key = p_key $$;
create function pg_temp.v(p_key text) returns text language sql stable as $$ select val from k where key = p_key $$;
create function pg_temp.put(p_key text, p_id uuid, p_val text) returns void language sql as $$
  insert into k values (p_key, p_id, p_val) on conflict (key) do update set id = excluded.id, val = excluded.val $$;
grant execute on function pg_temp.k(text), pg_temp.v(text) to public;

create function pg_temp.sources(p_user text) returns text[]
language plpgsql as $$
declare v text[];
begin
  perform pg_temp.as_user(p_user);
  select array_agg(distinct a.source order by a.source) into v from app.project_outside_access a where a.project_id = pg_temp.id('prj_a');
  perform pg_temp.as_platform();
  return v;
end $$;

create function pg_temp.row_of(p_source text, p_id uuid) returns app.project_outside_access
language plpgsql as $$
declare v app.project_outside_access;
begin
  perform pg_temp.as_user('alice');
  select * into v from app.project_outside_access a where a.project_id = pg_temp.id('prj_a') and a.source = p_source and a.source_id = p_id;
  perform pg_temp.as_platform();
  return v;
end $$;

-- Every source on prj_a -------------------------------------------------------------------------------------------------
select pg_temp.as_user('dave');
with x as (insert into app.run_of_show (project_id, name, show_date) values (pg_temp.id('prj_a'), 'Show Order', current_date + 8) returning id) insert into k select 'ros', id, null from x;
with x as (insert into app.advance_packets (project_id, title) values (pg_temp.id('prj_a'), 'Vendor Advance') returning id) insert into k select 'pkt', id, null from x;
insert into app.advance_sections (advance_packet_id, position, title) values (pg_temp.k('pkt'), 1, 'Power');
with x as (insert into app.advance_recipients (advance_packet_id, person_id) values (pg_temp.k('pkt'), pg_temp.id('mia')) returning id) insert into k select 'rcp', id, null from x;
select app.send_advance_packet(pg_temp.k('pkt'));
insert into k select 'advance', t.token_id, null from app.issue_advance_token(pg_temp.k('rcp'), 'mia@northwind.test') t;
select pg_temp.as_user('carol');
insert into k select 'display', d.live_link_id, null from app.create_display_link(pg_temp.k('ros'), now() + interval '30 days') d;
with d as (insert into app.engagement_documents (engagement_id, document_kind, title) values (pg_temp.id('eng_ivy_a'), 'Agreement', 'Crew Agreement') returning id) insert into k select 'doc', id, null from d;
select app.transition_engagement_document(pg_temp.k('doc'), 'Proposed', 'Sent', 'Sent.');
insert into k select 'signing', t.token_id, null from app.issue_engagement_document_token(pg_temp.k('doc'), 'ivy@freelance.test') t;

select u.attachment_version_id as v_id, u.object_name from app.begin_attachment_upload('app.projects', pg_temp.id('prj_a'), 'plan.pdf', 'application/pdf', 1200) u \gset
insert into storage.objects (bucket_id, name, metadata) values ('attachments', :'object_name', '{"size": 1200}');
select app.complete_attachment_upload(:'v_id'::uuid, repeat('ab', 32));
select pg_temp.as_platform();
select app.record_attachment_scan(:'v_id'::uuid, true);
insert into k select 'att', v.attachment_id, null from app.attachment_versions v where v.id = :'v_id'::uuid;
select pg_temp.as_user('carol');
update app.attachments set classification = 'Public' where id = pg_temp.k('att');
insert into k select 'file', s.share_link_id, s.token from app.create_share_link(pg_temp.k('att'), now() + interval '30 days') s;

insert into k values ('pack', app.create_stakeholder_pack(pg_temp.id('prj_a'), 'Client pack', now() + interval '30 days'), null);
insert into k select 'recipient', r.recipient_id, r.access_code from app.add_stakeholder_pack_recipient(pg_temp.k('pack'), 'Cleo Client', 'cleo@client.test') r;
insert into k select 'intake', l.vendor_intake_link_id, l.token from app.create_vendor_intake_link(pg_temp.id('prj_a'), 'Audio vendors', 'Vendor', '9000.50.02', 'VENDOR_SUPPLIED', 'Day Rate',
  'Per Engagement', '2027-06-01', now() + interval '30 days', null, 'AV Integrator') l;
insert into app.form_templates (org_id, name, record_kind, fields) values (pg_temp.id('org_a'), 'Supplier check', 'Document', '[{"key": "a", "label": "A", "kind": "text"}]');
select pg_temp.as_user('dave');
select app.publish_form_template((select t.id from app.form_templates t where t.name = 'Supplier check' and t.org_id = pg_temp.id('org_a')));
insert into k select 'form', l.form_link_id, l.token from app.create_form_link((select t.id from app.form_templates t where t.name = 'Supplier check' and t.org_id = pg_temp.id('org_a')), now() + interval '30 days', pg_temp.id('prj_a')) l;
select pg_temp.as_user('victor');
insert into k values ('invite_entry', app.invite_to_roster(pg_temp.id('eng_vendor_a'), 'nell@touring.test', '9000.50.02'), null);
select pg_temp.as_platform();
insert into k select 'roster', i.id, null from app.roster_invitations i where i.roster_entry_id = pg_temp.k('invite_entry');
select pg_temp.as_user('carol');
with v as (insert into app.saved_views (membership_id, collection_key, name, view_type, shared)
  values (pg_temp.id('carol@org_a'), 'project/schedule', 'Venue schedule', 'List', true) returning id) insert into k select 'saved', id, null from v;
insert into k select 'view', l.live_link_id, null from app.create_view_link(pg_temp.k('saved'), pg_temp.id('prj_a'), now() + interval '30 days') l;
select pg_temp.as_platform();

select is(pg_temp.sources('alice'),
  array['Advance link', 'Display link', 'Engagement', 'File link', 'Form link', 'Intake link', 'Live view link', 'Pack recipient', 'Roster invitation', 'Signing link'],
  'the view lists every source for the org''s Owner');

select is((pg_temp.row_of('Display link', pg_temp.k('display'))).link_state, 'Active', 'a display link shows its state');
select ok((pg_temp.row_of('Display link', pg_temp.k('display'))).token_hint ~ '^[0-9a-f]{4}$', 'and its hint');
select is((pg_temp.row_of('Advance link', pg_temp.k('advance'))).recipient_email, 'mia@northwind.test', 'an advance link shows who holds it');
select is((pg_temp.row_of('Signing link', pg_temp.k('signing'))).label, 'Crew Agreement', 'a signing link shows its document');
select is((pg_temp.row_of('Roster invitation', pg_temp.k('roster'))).link_state, 'Pending', 'a roster invitation shows Pending');
select is((pg_temp.row_of('Engagement', pg_temp.id('eng_ivy_a'))).label, 'Ivy Marchetti', 'an external Contractor engagement shows its party''s name');
select is((pg_temp.row_of('Intake link', pg_temp.k('intake'))).label, 'Audio vendors', 'an intake link shows its title');
select is((pg_temp.row_of('Form link', pg_temp.k('form'))).label, 'Supplier check', 'a form link shows its form');

-- File link opens ------------------------------------------------------------------------------------------------------
select is((pg_temp.row_of('File link', pg_temp.k('file'))).open_count, 0::bigint, 'a file link starts with no opens');
alter table app.share_links disable trigger user;
update app.share_links set open_count = 3, last_opened_at = now() where id = pg_temp.k('file');
alter table app.share_links enable trigger user;
select is((pg_temp.row_of('File link', pg_temp.k('file'))).open_count, 3::bigint, 'a file link shows its open count');
select ok((pg_temp.row_of('File link', pg_temp.k('file'))).last_opened_at is not null, 'and when it was last opened');

-- Pack activity --------------------------------------------------------------------------------------------------------
select is((pg_temp.row_of('Pack recipient', pg_temp.k('recipient'))).open_count, 0::bigint, 'a pack recipient shows no opens yet');
select is((pg_temp.row_of('Pack recipient', pg_temp.k('recipient'))).recipient_email, 'cleo@client.test', 'and their email');
select ok((select count(*) = 0 from information_schema.columns where table_schema = 'app' and table_name = 'project_outside_access'
  and column_name ~ '(hash|salt|code|^token$)'), 'the view has no token, code or hash column');

-- Who sees what --------------------------------------------------------------------------------------------------------
select ok(not ('Pack recipient' = any (pg_temp.sources('frank'))), 'a field member without projects.settings.write sees no pack recipient');
select ok(not ('Form link' = any (coalesce(pg_temp.sources('frank'), '{}'))), 'nor a form link: each source''s own policy decides');
select is(pg_temp.sources('xavier'), null, 'a member of another org sees nothing');
select is(pg_temp.sources('ivy'), null, 'an external party sees nothing');

select pg_temp.as_user('alice');
insert into app.project_shares (project_id, partner_organization_id, project_role) values (pg_temp.id('prj_a'), pg_temp.id('org_p'), 'Coordinator');
select pg_temp.as_platform();
select is(pg_temp.sources('paul'), null, 'a partner org reaching the project sees none of it');

select ok(not has_table_privilege('anon', 'app.project_outside_access', 'select'), 'anon cannot select the view');
select ok(not has_table_privilege('xos_backup', 'app.project_outside_access', 'select'), 'the backup login cannot select the view');
select ok(not has_table_privilege('xos_backup', 'app.stakeholder_pack_recipient_activity', 'select'), 'nor the pack activity view');

-- Revoking from a source shows at once ----------------------------------------------------------------------------------
select pg_temp.as_user('carol');
select app.revoke_share_link(pg_temp.k('file'));
select app.revoke_stakeholder_pack_recipient(pg_temp.k('recipient'));
select app.revoke_vendor_intake_link(pg_temp.k('intake'));
select pg_temp.as_platform();
select is((pg_temp.row_of('File link', pg_temp.k('file'))).link_state, 'Revoked', 'a revoked file link reads Revoked');
select is((pg_temp.row_of('Pack recipient', pg_temp.k('recipient'))).link_state, 'Revoked', 'a revoked recipient reads Revoked');
select is((pg_temp.row_of('Intake link', pg_temp.k('intake'))).link_state, 'Revoked', 'a revoked intake link reads Revoked');

select * from finish();
rollback;

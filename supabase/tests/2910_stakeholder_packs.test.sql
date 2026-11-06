-- pgTAP: migration 2910, B2 (RRR-226, ADR 0141). Stakeholder packs: only members of the project's org holding
-- projects.settings.write make them, every pack expires within 90 days, live link items need P1's manageable link on
-- the same project, file items are inserted under the attachment's own read policy and must be clean, on the project and
-- Public or Internal (and log Share Link Created), recipients get a 6-digit code once that nobody signed in can read,
-- revocation drops grants and links, the activity view counts events, and packs stay out of Trash.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(34);

create temporary table k (key text primary key, id uuid, val text);
grant select, insert, update, delete on k to public;

create function pg_temp.k(p_key text) returns uuid language sql stable as $$ select id from k where key = p_key $$;
create function pg_temp.v(p_key text) returns text language sql stable as $$ select val from k where key = p_key $$;

-- Runs a statement as a person and answers ok, the refusal rule, or the SQLSTATE.
create function pg_temp.try(p_user text, p_sql text) returns text
language plpgsql as $$
begin
  perform pg_temp.as_user(p_user);
  begin
    execute p_sql;
  exception when sqlstate 'XR001' then
    perform pg_temp.as_platform();
    return split_part(sqlerrm, ':', 1);
  when others then
    perform pg_temp.as_platform();
    return sqlstate;
  end;
  perform pg_temp.as_platform();
  return 'ok';
end $$;

-- A clean file uploaded by a person on a project.
create function pg_temp.clean_file(p_user text, p_project text, p_name text) returns uuid
language plpgsql as $$
declare
  v_version uuid;
  v_object text;
begin
  perform pg_temp.as_user(p_user);
  select u.attachment_version_id, u.object_name into v_version, v_object
  from app.begin_attachment_upload('app.projects', pg_temp.id(p_project), p_name, 'application/pdf', 1200) u;
  insert into storage.objects (bucket_id, name, metadata) values ('attachments', v_object, '{"size": 1200}');
  perform app.complete_attachment_upload(v_version, repeat('ab', 32));
  perform pg_temp.as_platform();
  perform app.record_attachment_scan(v_version, true);
  insert into k select p_name, v.attachment_id, v_object from app.attachment_versions v where v.id = v_version;
  return v_version;
end $$;

select pg_temp.clean_file('carol', 'prj_a', 'site-map.pdf');
select pg_temp.clean_file('carol', 'prj_a', 'budget.pdf');
select pg_temp.clean_file('carol', 'prj_a2', 'gala.pdf');

-- A running order on prj_a and a display link carol may share.
select pg_temp.as_user('dave');
with x as (insert into app.run_of_show (project_id, name, show_date) values (pg_temp.id('prj_a'), 'Load-in Order', current_date + 10) returning id)
  insert into k select 'ros', id, null from x;
select pg_temp.as_user('carol');
insert into k select 'display', d.live_link_id, d.token from app.create_display_link(pg_temp.k('ros'), now() + interval '20 days') d;
select pg_temp.as_platform();

-- Making a pack ------------------------------------------------------------------------------------------------------
select has_table('app', 'stakeholder_packs', 'app.stakeholder_packs exists');
select pg_temp.as_user('carol');
insert into k values ('pack', app.create_stakeholder_pack(pg_temp.id('prj_a'), 'Venue pack', now() + interval '30 days',
  'Everything the venue needs for load-in.', 'For the venue manager'), null);
select pg_temp.as_platform();
select results_eq($$select name, message, note, project_id, org_id from app.stakeholder_packs where id = pg_temp.k('pack')$$,
  $$values ('Venue pack'::text, 'Everything the venue needs for load-in.'::text, 'For the venue manager'::text, pg_temp.id('prj_a'), pg_temp.id('org_a'))$$,
  'a Manager with projects.settings.write makes a pack on the project');
select is(pg_temp.try('dave', format($$select app.create_stakeholder_pack(%L, 'Mine', now() + interval '5 days')$$, pg_temp.id('prj_a'))),
  '42501', 'a member without projects.settings.write on the project makes no pack');
select is(pg_temp.try('xavier', format($$select app.create_stakeholder_pack(%L, 'Theirs', now() + interval '5 days')$$, pg_temp.id('prj_a'))),
  '42501', 'nor does someone of another org');
select is(pg_temp.try('carol', format($$select app.create_stakeholder_pack(%L, 'Old', now() - interval '1 day')$$, pg_temp.id('prj_a'))),
  'stakeholder_pack_expiry_range', 'an expiry in the past is refused');
select is(pg_temp.try('carol', format($$select app.create_stakeholder_pack(%L, 'Far', now() + interval '91 days')$$, pg_temp.id('prj_a'))),
  'stakeholder_pack_expiry_range', 'and one more than 90 days out');
select is(pg_temp.try('carol', format($$insert into app.stakeholder_packs (project_id, name, expires_at) values (%L, 'Direct', now() + interval '1 day')$$,
  pg_temp.id('prj_a'))), '42501', 'a pack is never inserted directly');
select is(pg_temp.try('carol', format($$select app.update_stakeholder_pack(%L, 'Venue pack', 'Updated message.', null, now() + interval '60 days')$$,
  pg_temp.k('pack'))), 'ok', 'the expiry may move later while it stays within 90 days');

-- Items --------------------------------------------------------------------------------------------------------------
select is(pg_temp.try('carol', format($$insert into k values ('item_live', app.add_stakeholder_pack_item(%L, %L, null, 'Load-in clock', true), null)$$,
  pg_temp.k('pack'), pg_temp.k('display'))), 'ok', 'a live link of the project the caller may manage becomes an item');
select is((select item_kind::text || ' ' || position::text from app.stakeholder_pack_items where id = pg_temp.k('item_live')), 'Live Link 0',
  'the database sets its kind and puts it first');
select is(pg_temp.try('carol', format($$insert into k values ('item_file', app.add_stakeholder_pack_item(%L, null, %L, 'Site map'), null)$$,
  pg_temp.k('pack'), pg_temp.k('site-map.pdf'))), 'ok', 'a clean Internal file of the project becomes an item');
select is((select item_kind::text || ' ' || position::text from app.stakeholder_pack_items where id = pg_temp.k('item_file')), 'File 1',
  'last in order');
select is((select count(*)::int from app.file_access_log where object_path = pg_temp.v('site-map.pdf') and action = 'Share Link Created'), 1,
  'adding a file logs one Share Link Created row');
select is(pg_temp.try('carol', format($$select app.add_stakeholder_pack_item(%L, null, %L, 'Winter gala')$$, pg_temp.k('pack'), pg_temp.k('gala.pdf'))),
  'stakeholder_pack_item_file', 'a file of another project is refused');
select pg_temp.as_user('carol');
update app.attachments set classification = 'Confidential' where id = pg_temp.k('budget.pdf');
select pg_temp.as_platform();
select is(pg_temp.try('carol', format($$select app.add_stakeholder_pack_item(%L, null, %L, 'Budget')$$, pg_temp.k('pack'), pg_temp.k('budget.pdf'))),
  'stakeholder_pack_item_classified', 'a Confidential file is refused: only Public or Internal files go in a pack');
select is(pg_temp.try('dave', format($$select app.add_stakeholder_pack_item(%L, null, %L, 'Again')$$, pg_temp.k('pack'), pg_temp.k('site-map.pdf'))),
  '42501', 'someone who does not manage the pack adds nothing');
select is(pg_temp.try('carol', format($$select app.add_stakeholder_pack_item(%L, %L, %L, 'Both')$$, pg_temp.k('pack'), pg_temp.k('display'),
  pg_temp.k('site-map.pdf'))), 'stakeholder_pack_item_subject', 'an item is one live link or one file');
select is(pg_temp.try('carol', format($$update app.stakeholder_pack_items set title = 'Renamed' where id = %L$$, pg_temp.k('item_file'))),
  '42501', 'items are never edited directly');

-- Recipients ---------------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
insert into k select 'recipient', r.recipient_id, r.access_code
from app.add_stakeholder_pack_recipient(pg_temp.k('pack'), 'Vera Venue', ' Vera@Venue.Test ', null, 'Venue') r;
select pg_temp.as_platform();
select matches(pg_temp.v('recipient'), '^[0-9]{6}$', 'adding a recipient answers a 6-digit code once');
select is((select email from app.stakeholder_pack_recipients where id = pg_temp.k('recipient')), 'vera@venue.test', 'the email is kept lower case');
select ok((select access_code_hash = extensions.digest(encode(code_salt, 'hex') || ':' || pg_temp.v('recipient'), 'sha256')
  from app.stakeholder_pack_recipients where id = pg_temp.k('recipient')), 'only the salted SHA-256 of the code is stored');
select is(pg_temp.try('carol', format($$select code_salt from app.stakeholder_pack_recipients where id = %L$$, pg_temp.k('recipient'))),
  '42501', 'inv_08_token_rpcs_hashed_secrets: signed-in callers cannot select the salt');
select is(pg_temp.try('carol', format($$select access_code_hash from app.stakeholder_pack_recipients where id = %L$$, pg_temp.k('recipient'))),
  '42501', 'inv_08_token_rpcs_hashed_secrets: nor the code hash');
select is(pg_temp.try('carol', format($$select app.add_stakeholder_pack_recipient(%L, 'Vera Again', 'vera@venue.test')$$, pg_temp.k('pack'))),
  'stakeholder_pack_recipient_duplicate', 'a second live recipient with the same email is refused');
select is((select classification::text from private.column_classifications
  where table_name = 'app.stakeholder_pack_recipients' and column_name = 'email'), 'Confidential', 'a recipient''s email is Confidential');

-- Reset and revoke ----------------------------------------------------------------------------------------------------
insert into private.stakeholder_pack_grants (grant_hash, org_id, recipient_id, expires_at)
values (extensions.digest('xpkg_fixture', 'sha256'), pg_temp.id('org_a'), pg_temp.k('recipient'), now() + interval '1 day');
select pg_temp.as_user('carol');
insert into k values ('new_code', null, app.reset_stakeholder_pack_recipient_code(pg_temp.k('recipient')));
select pg_temp.as_platform();
select ok(pg_temp.v('new_code') ~ '^[0-9]{6}$' and (select count(*) from private.stakeholder_pack_grants where recipient_id = pg_temp.k('recipient')) = 0,
  'resetting the code answers a new one and drops the device grants');
insert into private.stakeholder_pack_grants (grant_hash, org_id, recipient_id, expires_at)
values (extensions.digest('xpkg_fixture_2', 'sha256'), pg_temp.id('org_a'), pg_temp.k('recipient'), now() + interval '1 day');
select is(pg_temp.try('carol', format($$select app.revoke_stakeholder_pack_recipient(%L)$$, pg_temp.k('recipient'))), 'ok', 'a recipient is revoked');
select is((select count(*)::int from private.stakeholder_pack_grants where recipient_id = pg_temp.k('recipient')), 0, 'revoking drops their grants');
select is(pg_temp.try('carol', format($$select app.revoke_stakeholder_pack(%L)$$, pg_temp.k('pack'))), 'ok', 'the pack is revoked');
select is(pg_temp.try('carol', format($$select app.add_stakeholder_pack_recipient(%L, 'Late', 'late@venue.test')$$, pg_temp.k('pack'))),
  'stakeholder_pack_revoked', 'a revoked pack takes no new recipient');

-- Activity, read access and Trash ---------------------------------------------------------------------------------------
select is((select opens::int from app.stakeholder_pack_recipient_activity where recipient_id = pg_temp.k('recipient')), 0,
  'the activity view counts a recipient''s events; none yet');
select ok(not has_table_privilege('xos_backup', 'app.stakeholder_pack_recipient_activity', 'SELECT')
  and not has_table_privilege('anon', 'app.stakeholder_pack_recipient_activity', 'SELECT'),
  'neither the backup login nor anon reads the activity view');
select pg_temp.as_user('dave');
select is((select count(*)::int from app.stakeholder_packs where id = pg_temp.k('pack')), 0,
  'a member without projects.settings.write does not read the pack');
select pg_temp.as_platform();
select is((select count(*)::int from private.trash_excluded_tables
  where table_name in ('stakeholder_packs', 'stakeholder_pack_items', 'stakeholder_pack_recipients', 'stakeholder_pack_events')), 4,
  'packs, items, recipients and events stay out of Trash (ADR 0110)');

select * from finish();
rollback;

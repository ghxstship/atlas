-- pgTAP: migration 2912, B2 (RRR-226, ADR 0141). The anonymous side of stakeholder packs (Section 7.5 invariant 8):
-- a read-only call is refused first, an unknown token counts a failure and a superseded one does not, 5 wrong codes
-- lock the recipient, the address limit spares a device with a valid grant, a correct code earns a grant that opens
-- next week's link without the code, the pack read answers exactly its key set, a live item answers P1's payload and
-- logs Viewed once an hour, a file item issues a ticket the Edge Function honors once while the file stays Internal,
-- an acknowledgement is stored once, revocation ends reads, and unsubscribing stops emails while the pack still opens.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(54);

create temporary table k (key text primary key, id uuid, val text);
grant select, insert, update, delete on k to public;

create function pg_temp.k(p_key text) returns uuid language sql stable as $$ select id from k where key = p_key $$;
create function pg_temp.v(p_key text) returns text language sql stable as $$ select val from k where key = p_key $$;
create function pg_temp.put(p_key text, p_id uuid, p_val text) returns void language sql as $$
  insert into k values (p_key, p_id, p_val) on conflict (key) do update set id = excluded.id, val = excluded.val $$;

create function pg_temp.clean_file(p_user text, p_name text) returns uuid
language plpgsql as $$
declare
  v_version uuid;
  v_object text;
begin
  perform pg_temp.as_user(p_user);
  select u.attachment_version_id, u.object_name into v_version, v_object
  from app.begin_attachment_upload('app.projects', pg_temp.id('prj_a'), p_name, 'application/pdf', 1200) u;
  insert into storage.objects (bucket_id, name, metadata) values ('attachments', v_object, '{"size": 1200}');
  perform app.complete_attachment_upload(v_version, repeat('ab', 32));
  perform pg_temp.as_platform();
  perform app.record_attachment_scan(v_version, true);
  perform pg_temp.put(p_name, (select v.attachment_id from app.attachment_versions v where v.id = v_version), v_object);
  return v_version;
end $$;

-- Sends one recipient a fresh link and mints it as the worker would; keeps the token and unsubscribe token.
create function pg_temp.mint(p_key text, p_recipient text) returns void
language plpgsql as $$
declare
  v_delivery uuid;
  v record;
begin
  perform pg_temp.as_user('carol');
  perform app.send_stakeholder_pack(pg_temp.k('pack'), array[pg_temp.k(p_recipient)]);
  perform pg_temp.as_platform();
  select d.id into v_delivery from app.stakeholder_pack_deliveries d
  where d.recipient_id = pg_temp.k(p_recipient) order by d.created_at desc, d.id desc limit 1;
  select * into v from app.mint_stakeholder_pack_link(v_delivery);
  perform pg_temp.put(p_key, v_delivery, v.token);
  perform pg_temp.put(p_key || ':unsubscribe', null, v.unsubscribe_token);
end $$;

create function pg_temp.anon(p_client text) returns void
language plpgsql as $$
begin
  perform pg_temp.as_anon();
  perform set_config('request.headers', json_build_object('x-forwarded-for', '192.0.2.10')::text, true);
end $$;

-- Opens a link as an anonymous visitor; answers the reason, or ok with the grant kept under the key.
create function pg_temp.open(p_key text, p_token text, p_code text, p_grants text[] default null, p_client text default '198.51.100.7')
returns text
language plpgsql as $$
declare
  v jsonb;
begin
  perform pg_temp.anon(p_client);
  v := api_public.open_stakeholder_pack(p_token, p_code, p_client, p_grants);
  perform pg_temp.as_platform();
  if v ->> 'status' = 'ok' then
    perform pg_temp.put(p_key, null, v ->> 'grant');
    perform pg_temp.put(p_key || ':expires', null, v ->> 'grant_expires_at');
    perform pg_temp.put(p_key || ':dead', null, (v -> 'dead_grants')::text);
    return 'ok';
  end if;
  return v ->> 'reason';
end $$;

create function pg_temp.pack(p_token text, p_grant text, p_client text default '198.51.100.7') returns jsonb
language plpgsql as $$
declare
  v jsonb;
begin
  perform pg_temp.anon(p_client);
  v := api_public.stakeholder_pack(p_token, array[p_grant], p_client);
  perform pg_temp.as_platform();
  return v;
end $$;

create function pg_temp.failures() returns integer language sql stable as $$
  select count(*)::int from private.rate_limit_events where bucket = 'pack_link.failure' $$;

-- A pack with a live display item, a file item that asks for an acknowledgement, and two recipients.
select pg_temp.clean_file('carol', 'plan.pdf');
select pg_temp.as_user('dave');
with x as (insert into app.run_of_show (project_id, name, show_date) values (pg_temp.id('prj_a'), 'Show Order', current_date + 8) returning id)
  insert into k select 'ros', id, null from x;
select pg_temp.as_user('carol');
insert into k select 'display', d.live_link_id, null from app.create_display_link(pg_temp.k('ros'), now() + interval '30 days') d;
insert into k values ('pack', app.create_stakeholder_pack(pg_temp.id('prj_a'), 'Client pack', now() + interval '40 days',
  'Welcome.', 'Internal note for the team'), null);
insert into k values ('item_live', app.add_stakeholder_pack_item(pg_temp.k('pack'), pg_temp.k('display'), null, 'Show clock'), null);
insert into k values ('item_file', app.add_stakeholder_pack_item(pg_temp.k('pack'), null, pg_temp.k('plan.pdf'), 'Floor plan', true), null);
insert into k select 'r1', r.recipient_id, r.access_code from app.add_stakeholder_pack_recipient(pg_temp.k('pack'), 'Cleo Client', 'cleo@client.test') r;
insert into k select 'r2', r.recipient_id, r.access_code from app.add_stakeholder_pack_recipient(pg_temp.k('pack'), 'Dan Dept', 'dan@client.test', null, 'Finance') r;
select pg_temp.as_platform();
select pg_temp.mint('t1', 'r1');

-- Opening ---------------------------------------------------------------------------------------------------------
create function pg_temp.read_only_open() returns text
language plpgsql as $$
begin
  begin
    perform set_config('transaction_read_only', 'on', true);
    perform api_public.open_stakeholder_pack(pg_temp.v('t1'), '000000', null, null);
  exception when others then
    perform set_config('transaction_read_only', 'off', true);
    return sqlstate;
  end;
  perform set_config('transaction_read_only', 'off', true);
  return 'ran';
end $$;
select pg_temp.as_anon();
select is(pg_temp.read_only_open(), '25006', 'a read-only (GET) call of open_stakeholder_pack is refused before any lookup');
select pg_temp.as_platform();

select pg_temp.put('f0', null, pg_temp.failures()::text);
select is(pg_temp.open('x', 'xpkl_' || repeat('0', 64), '123456'), 'pack_link_invalid', 'an unknown token is refused');
select is(pg_temp.failures(), pg_temp.v('f0')::int + 1, 'and counts one failure against the address');
select is(pg_temp.open('x', pg_temp.v('t1'), null), 'pack_access_code_required', 'a known link asks for the code');
select is(pg_temp.open('x', pg_temp.v('t1'), case when pg_temp.v('r1') = '000000' then '111111' else '000000' end), 'pack_access_code',
  'a wrong code is refused');
select is((select failed_attempts::int from app.stakeholder_pack_recipients where id = pg_temp.k('r1')), 1, 'and counted on the recipient');
select is(pg_temp.open('g1', pg_temp.v('t1'), pg_temp.v('r1')), 'ok', 'the right code opens the pack');
select matches(pg_temp.v('g1'), '^xpkg_[0-9a-f]{64}$', 'and earns an xpkg_ device grant');
select ok(pg_temp.v('g1:expires')::timestamptz <= now() + interval '7 days'
  and pg_temp.v('g1:expires')::timestamptz <= (select expires_at from private.stakeholder_pack_links where token_hash = extensions.digest(pg_temp.v('t1'), 'sha256')),
  'the grant expires at the earliest of 7 days and the link''s expiry');
select is((select count(*)::int from app.stakeholder_pack_events where recipient_id = pg_temp.k('r1') and action = 'Opened'), 1, 'one Opened event');

-- Reading -----------------------------------------------------------------------------------------------------------
select pg_temp.put('read', null, pg_temp.pack(pg_temp.v('t1'), pg_temp.v('g1'))::text);
select is((select array_agg(x order by x) from jsonb_object_keys(pg_temp.v('read')::jsonb) x),
  array['items', 'meta', 'recipient_name', 'status'], 'the pack read answers exactly status, meta, recipient_name and items');
select is((select array_agg(x order by x) from jsonb_object_keys(pg_temp.v('read')::jsonb -> 'meta') x),
  array['brand_accent_hex', 'brand_logo_dark_path', 'brand_logo_light_path', 'brand_name', 'brand_suppress_powered_by', 'expires_at',
    'message', 'pack_name', 'project_name', 'time_zone'], 'meta holds the brand''s Public columns, the project and the pack''s name, message and expiry');
select is((select array_agg(x order by x) from jsonb_object_keys(pg_temp.v('read')::jsonb -> 'items' -> 0) x),
  array['available', 'id', 'kind', 'requires_acknowledgement', 'signed_at', 'title'], 'each item answers only its own fields');
select ok(pg_temp.v('read') not like '%Internal note%' and pg_temp.v('read') not like '%@client.test%'
  and pg_temp.v('read') not like '%' || pg_temp.k('plan.pdf')::text || '%',
  'never the note, any email or an attachment id');
select is(pg_temp.v('read')::jsonb ->> 'recipient_name', 'Cleo Client', 'the recipient sees their own name');

select pg_temp.anon('198.51.100.7');
select pg_temp.put('live', null, api_public.stakeholder_pack_item(pg_temp.v('t1'), array[pg_temp.v('g1')], pg_temp.k('item_live'), '198.51.100.7')::text);
select pg_temp.put('live2', null, api_public.stakeholder_pack_item(pg_temp.v('t1'), array[pg_temp.v('g1')], pg_temp.k('item_live'), '198.51.100.7')::text);
select pg_temp.as_platform();
select ok(pg_temp.v('live')::jsonb ->> 'status' = 'ok' and pg_temp.v('live')::jsonb ? 'cues' and pg_temp.v('live')::jsonb ? 'channel',
  'a live item answers P1''s display payload with its channel');
select is((select count(*)::int from app.stakeholder_pack_events where recipient_id = pg_temp.k('r1') and action = 'Viewed'), 1,
  'two reads within the hour log one Viewed');

select pg_temp.anon('198.51.100.7');
select pg_temp.put('ticket', null, (select f.ticket from api_public.stakeholder_pack_file(pg_temp.v('t1'), array[pg_temp.v('g1')], pg_temp.k('item_file'), '198.51.100.7') f));
select pg_temp.as_platform();
select matches(pg_temp.v('ticket'), '^xdlt_[0-9a-f]{64}$', 'a file item issues a download ticket');
select ok((select count(*) from app.file_access_log where object_path = pg_temp.v('plan.pdf') and action = 'Share Link Opened' and person_id is null and not watermarked) = 1
  and (select count(*) from app.stakeholder_pack_events where recipient_id = pg_temp.k('r1') and action = 'Downloaded') = 1,
  'and logs Downloaded in the pack and Share Link Opened, with no person, in the file access log');
select is((select org_id from private.file_download_tickets where ticket_hash = extensions.digest(pg_temp.v('ticket'), 'sha256')), pg_temp.id('org_a'),
  'the ticket is stamped with the org of its attachment version');
select is((select count(*)::int from app.consume_file_download_ticket(pg_temp.v('ticket'))), 1, 'the file-download function honors the ticket');
select is((select count(*)::int from app.consume_file_download_ticket(pg_temp.v('ticket'))), 0, 'once');

select pg_temp.anon('198.51.100.7');
select pg_temp.put('ticket2', null, (select f.ticket from api_public.stakeholder_pack_file(pg_temp.v('t1'), array[pg_temp.v('g1')], pg_temp.k('item_file'), '198.51.100.7') f));
select pg_temp.as_platform();
select pg_temp.as_user('carol');
update app.attachments set classification = 'Confidential' where id = pg_temp.k('plan.pdf');
select pg_temp.as_platform();
select is((select count(*)::int from app.consume_file_download_ticket(pg_temp.v('ticket2'))), 0,
  'a ticket issued before the file was raised to Confidential answers nothing');
select is(pg_temp.pack(pg_temp.v('t1'), pg_temp.v('g1')) -> 'items' -> 1 ->> 'available', 'false', 'and the item now reads unavailable');
select pg_temp.as_user('carol');
update app.attachments set classification = 'Internal' where id = pg_temp.k('plan.pdf');
select pg_temp.as_platform();

-- Acknowledging ------------------------------------------------------------------------------------------------------
select pg_temp.anon('198.51.100.7');
select pg_temp.put('sign', null, api_public.sign_stakeholder_pack_item(pg_temp.v('t1'), array[pg_temp.v('g1')], pg_temp.k('item_file'), ' Cleo Client ', '198.51.100.7')::text);
select pg_temp.put('sign2', null, api_public.sign_stakeholder_pack_item(pg_temp.v('t1'), array[pg_temp.v('g1')], pg_temp.k('item_file'), 'Cleo Again', '198.51.100.7')::text);
select pg_temp.put('sign3', null, api_public.sign_stakeholder_pack_item(pg_temp.v('t1'), array[pg_temp.v('g1')], pg_temp.k('item_live'), 'Cleo', '198.51.100.7')::text);
select pg_temp.as_platform();
select is(pg_temp.v('sign')::jsonb ->> 'status', 'ok', 'an item that asks for an acknowledgement takes the typed name');
select ok(pg_temp.v('sign2')::jsonb ->> 'reason' = 'already_signed' and pg_temp.v('sign2')::jsonb ->> 'signed_at' = pg_temp.v('sign')::jsonb ->> 'signed_at',
  'a repeat answers already_signed with the first time');
select is((select signer_name from app.stakeholder_pack_events where recipient_id = pg_temp.k('r1') and action = 'Signed'), 'Cleo Client',
  'the name is stored once');
select is(pg_temp.v('sign3')::jsonb ->> 'reason', 'pack_item_not_acknowledgeable', 'an item that asks for none takes no acknowledgement');

-- Next week's link opens with the grant; a superseded link is not a guess ----------------------------------------------
select pg_temp.mint('t2', 'r1');
select pg_temp.put('stale', null, 'xpkg_' || repeat('f', 64));
select pg_temp.put('old_g1', null, pg_temp.v('g1'));
select is(pg_temp.open('g2', pg_temp.v('t2'), null, array[pg_temp.v('stale'), pg_temp.v('g1')]), 'ok',
  'a new delivery link for the same recipient opens with the device''s grant and no code');
select is((select count(*)::int from private.stakeholder_pack_grants where grant_hash = extensions.digest(pg_temp.v('g1'), 'sha256')), 0,
  'and the old grant is swapped for the fresh one');
select is((pg_temp.v('g2:dead'))::jsonb, jsonb_build_array(pg_temp.v('stale'), pg_temp.v('old_g1')),
  'the answer names the grants the device presented that no longer open anything, so its cookie drops them');
select ok(not (pg_temp.v('g2:dead')::jsonb ? pg_temp.v('g2')), 'and never the fresh one');
select pg_temp.as_platform();
select app.mint_stakeholder_pack_link(pg_temp.k('t2'));
select pg_temp.put('f1', null, pg_temp.failures()::text);
select is(pg_temp.open('x', pg_temp.v('t2'), pg_temp.v('r1')), 'pack_link_invalid', 'a link superseded by a later attempt no longer opens');
select is(pg_temp.failures(), pg_temp.v('f1')::int, 'and does not count as a failure');
select pg_temp.mint('t4', 'r1');
select pg_temp.open('g4', pg_temp.v('t4'), null, array[pg_temp.v('g2')]) is not null;

-- Lockout and the address limit ------------------------------------------------------------------------------------------
select pg_temp.mint('t3', 'r2');
select pg_temp.open('x', pg_temp.v('t3'), '999999', null, '198.51.100.20') from generate_series(1, 4);
select is(pg_temp.open('x', pg_temp.v('t3'), '999999', null, '198.51.100.20'), 'pack_locked', 'the fifth wrong code locks the recipient');
select is(pg_temp.open('x', pg_temp.v('t3'), pg_temp.v('r2'), null, '198.51.100.21'), 'pack_locked', 'and the right code stays refused');
select pg_temp.open('x', 'xpkl_' || repeat('1', 64), '000000', null, '198.51.100.30') from generate_series(1, 20);
select ok(pg_temp.open('x', 'xpkl_' || repeat('2', 64), '000000', null, '198.51.100.30') = 'pack_link_rate_limited'
  and pg_temp.pack(pg_temp.v('t4'), pg_temp.v('g4'), '198.51.100.30') ->> 'status' = 'ok',
  'after 20 failures the address is refused, while a read with a valid grant from it is still served');

-- Unsubscribing and revoking --------------------------------------------------------------------------------------------
select pg_temp.anon('198.51.100.7');
select pg_temp.put('unsub', null, api_public.unsubscribe_stakeholder_pack(pg_temp.v('t1:unsubscribe'), '198.51.100.7')::text);
select pg_temp.as_platform();
select ok(pg_temp.v('unsub')::jsonb ->> 'status' = 'ok'
  and (select unsubscribed_at is not null from app.stakeholder_pack_recipients where id = pg_temp.k('r1'))
  and (select count(*) from app.stakeholder_pack_events where recipient_id = pg_temp.k('r1') and action = 'Unsubscribed') = 1,
  'a one-click unsubscribe stops the emails and logs Unsubscribed');
select is(pg_temp.pack(pg_temp.v('t4'), pg_temp.v('g4')) ->> 'status', 'ok', 'the pack still opens after unsubscribing');
select is((select count(*)::int from app.suppression_list where org_id = pg_temp.id('org_a') and address = 'cleo@client.test' and reason = 'Unsubscribe' and category_code is null), 1,
  'the address goes on the org''s suppression list');
select ok(private.pack_email_suppressed(pg_temp.id('org_a'), 'cleo@client.test'), 'so the org''s other packs stop mailing it');
select pg_temp.anon('198.51.100.7');
select api_public.unsubscribe_stakeholder_pack(pg_temp.v('t1:unsubscribe'), '198.51.100.7');
select pg_temp.as_platform();
select is((select count(*)::int from app.suppression_list where org_id = pg_temp.id('org_a') and address = 'cleo@client.test' and reason = 'Unsubscribe'), 1,
  'a repeat changes nothing');
select pg_temp.put('f2', null, pg_temp.failures()::text);
select pg_temp.anon('198.51.100.7');
select is(api_public.unsubscribe_stakeholder_pack('xpku_' || repeat('3', 64), '198.51.100.7') ->> 'reason', 'pack_link_invalid', 'the confirm page refuses an unknown token');
select pg_temp.as_platform();
select is(pg_temp.failures(), pg_temp.v('f2')::int + 1, 'and counts a failure');
select pg_temp.put('f3', null, pg_temp.failures()::text);
select is(app.unsubscribe_pack_by_token('xpku_' || repeat('3', 64)), false, 'one-click answers false for an unknown token');
select is(pg_temp.failures(), pg_temp.v('f3')::int, 'and counts no failure, since the reaching address is the function''s own');
select is(app.unsubscribe_pack_by_token(pg_temp.v('t1:unsubscribe')), true, 'one-click answers true for a known token, idempotently');
select ok(not has_function_privilege('anon', 'app.unsubscribe_pack_by_token(text)', 'execute'), 'anon cannot execute the one-click call');

-- Reads refuse a read-only transaction -------------------------------------------------------------------------------------
create function pg_temp.read_only(p_sql text) returns text
language plpgsql as $$
begin
  begin
    perform set_config('transaction_read_only', 'on', true);
    execute p_sql;
  exception when others then
    perform set_config('transaction_read_only', 'off', true);
    return sqlstate;
  end;
  perform set_config('transaction_read_only', 'off', true);
  return 'ran';
end $$;
select pg_temp.anon('198.51.100.7');
select is(pg_temp.read_only(format($$select api_public.stakeholder_pack(%L, array[%L], null)$$, pg_temp.v('t4'), pg_temp.v('g4'))), '25006', 'a read-only read of the pack is refused');
select is(pg_temp.read_only(format($$select api_public.stakeholder_pack_item(%L, array[%L], %L, null)$$, pg_temp.v('t4'), pg_temp.v('g4'), pg_temp.k('item_live'))), '25006', 'and of a live item');
select pg_temp.as_platform();

-- A newer version that is not clean makes the item unavailable -----------------------------------------------------------------
select pg_temp.as_user('carol');
select pg_temp.as_platform();
insert into app.attachment_versions (attachment_id, version_number, object_name, filename, content_type, size_bytes, scan_status)
select v.attachment_id, v.version_number + 1, v.object_name || '-2', v.filename, v.content_type, v.size_bytes, 'Scanning'
from app.attachment_versions v where v.attachment_id = pg_temp.k('plan.pdf') order by v.version_number desc limit 1;
select is((private.pack_file_version(pg_temp.k('plan.pdf'))).id, null, 'a newer version still scanning means no current clean version');
select is(pg_temp.pack(pg_temp.v('t4'), pg_temp.v('g4')) -> 'items' -> 1 ->> 'available', 'false', 'so the file item reads unavailable rather than serving the older file');
select pg_temp.as_user('carol');
select app.revoke_stakeholder_pack_recipient(pg_temp.k('r1'));
select pg_temp.as_platform();
select is(pg_temp.pack(pg_temp.v('t4'), pg_temp.v('g4')) ->> 'reason', 'pack_recipient_revoked', 'a revoked recipient reads nothing more');

-- A correct code replaces the recipient's grant the device presented, rather than leaving it live beside the new one.
select pg_temp.as_user('carol');
insert into k select 'rc', r.recipient_id, r.access_code from app.add_stakeholder_pack_recipient(pg_temp.k('pack'), 'Code Case', 'code-case@client.test') r;
select pg_temp.as_platform();
select pg_temp.mint('tc', 'rc');
select pg_temp.open('gc1', pg_temp.v('tc'), pg_temp.v('rc'), null, '198.51.100.99') is not null;
select pg_temp.open('gc2', pg_temp.v('tc'), pg_temp.v('rc'), array[pg_temp.v('gc1')], '198.51.100.99') is not null;
select is((select count(*)::int from private.stakeholder_pack_grants where recipient_id = pg_temp.k('rc')), 1,
  'a correct code with the device''s grant leaves one live grant');

select * from finish();
rollback;

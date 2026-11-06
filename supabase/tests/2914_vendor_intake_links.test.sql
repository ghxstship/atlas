-- pgTAP: migration 2914, B2 (RRR-226, ADR 0141). Reusable vendor intake links: only members holding
-- opportunities.engagement.write on the project make them, never for an employee classification, always on one canon
-- rate card row, with an expiry within 90 days; the token and code come back once and are stored as hashes; the
-- agreement must be a clean Public or Internal upload and is pinned; the open applies invariant 8 (read-only refused
-- first, a regenerated token not counted, 5 wrong codes lock); the read never answers the note or the rate; the
-- agreement downloads by ticket until the link is revoked.
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

-- A Knowledge document whose latest version is a clean upload.
create function pg_temp.agreement(p_key text, p_title text) returns uuid
language plpgsql as $$
declare
  v_document uuid;
  v_version uuid;
  v_object text;
begin
  perform pg_temp.as_user('carol');
  insert into app.documents (org_id, project_id, title) values (pg_temp.id('org_a'), pg_temp.id('prj_a'), p_title) returning id into v_document;
  select u.attachment_version_id, u.object_name into v_version, v_object
  from app.begin_attachment_upload('app.documents', v_document, p_key || '.pdf', 'application/pdf', 2400) u;
  insert into storage.objects (bucket_id, name, metadata) values ('attachments', v_object, '{"size": 2400}');
  perform app.complete_attachment_upload(v_version, repeat('cd', 32));
  perform pg_temp.as_platform();
  perform app.record_attachment_scan(v_version, true);
  perform pg_temp.put(p_key, v_document, v_object);
  perform pg_temp.put(p_key || ':attachment', (select v.attachment_id from app.attachment_versions v where v.id = v_version), null);
  return v_document;
end $$;

create function pg_temp.link_sql(p_title text, p_classification text, p_counterparty_type text, p_agreement uuid,
  p_expires interval default '30 days', p_pay_basis text default 'Day Rate') returns text
language sql stable as $$
  select format($f$insert into k select %L, l.vendor_intake_link_id, l.token || ' ' || l.access_code
    from app.create_vendor_intake_link(%L, %L, 'Vendor', '9000.50.02', %L, %L, 'Per Engagement', '2027-06-01',
      now() + %L::interval, null, %L, %L, 'Send us your details.', 'Audio vendors for the summer') l$f$,
    p_title, pg_temp.id('prj_a'), p_title, p_classification, p_pay_basis, p_expires, p_counterparty_type, p_agreement)
$$;

create function pg_temp.open(p_token text, p_code text, p_client text default '198.51.100.7') returns jsonb
language plpgsql as $$
declare
  v jsonb;
begin
  perform pg_temp.as_anon();
  perform set_config('request.headers', json_build_object('x-forwarded-for', '192.0.2.10')::text, true);
  v := api_public.open_vendor_intake(p_token, p_code, p_client);
  perform pg_temp.as_platform();
  return v;
end $$;

create function pg_temp.failures() returns integer language sql stable as $$
  select count(*)::int from private.rate_limit_events where bucket = 'vendor_intake.failure' $$;

select pg_temp.agreement('msa', 'Master services agreement');
select pg_temp.agreement('secret', 'Confidential terms');
select pg_temp.as_user('carol');
update app.attachments set classification = 'Confidential' where id = pg_temp.k('secret:attachment');
select pg_temp.as_platform();

-- Making links ---------------------------------------------------------------------------------------------------------
select is(pg_temp.try('carol', pg_temp.link_sql('audio', 'VENDOR_SUPPLIED', 'AV Integrator', pg_temp.k('msa'))), 'ok',
  'a Manager with opportunities.engagement.write makes a Vendor intake link');
select ok(split_part(pg_temp.v('audio'), ' ', 1) ~ '^xvin_[0-9a-f]{64}$' and split_part(pg_temp.v('audio'), ' ', 2) ~ '^[0-9]{6}$',
  'the token and a 6-digit code come back once');
select ok((select token_hash = extensions.digest(split_part(pg_temp.v('audio'), ' ', 1), 'sha256')
  and access_code_hash = extensions.digest(split_part(pg_temp.v('audio'), ' ', 1) || ':' || split_part(pg_temp.v('audio'), ' ', 2), 'sha256')
  from app.vendor_intake_links where id = pg_temp.k('audio')), 'only their hashes are stored');
select is((select agreement_version_id from app.vendor_intake_links where id = pg_temp.k('audio')),
  (select v.id from app.document_versions v where v.document_id = pg_temp.k('msa') order by v.version_number desc limit 1),
  'the agreement''s latest version is pinned');
select is(pg_temp.try('carol', format($$select token_hash from app.vendor_intake_links where id = %L$$, pg_temp.k('audio'))), '42501',
  'inv_08_token_rpcs_hashed_secrets: signed-in callers cannot select the token hash');
select is(pg_temp.try('dave', pg_temp.link_sql('dave', 'VENDOR_SUPPLIED', 'AV Integrator', null)), '42501',
  'a member without opportunities.engagement.write makes no intake link');
select is(pg_temp.try('carol', pg_temp.link_sql('employee', 'EMPLOYEE', 'AV Integrator', null)), 'vendor_intake_classification',
  'an employee classification is refused');
select is(pg_temp.try('carol', pg_temp.link_sql('no_type', 'VENDOR_SUPPLIED', null, null)), 'vendor_intake_counterparty_type',
  'a Vendor link needs a counterparty type');
select is(pg_temp.try('carol', pg_temp.link_sql('mismatch', 'VENDOR_SUPPLIED', 'AV Integrator', null, '30 days', 'Salary')),
  'vendor_intake_rate_card', 'terms that are not one rate card row are refused');
select is(pg_temp.try('carol', pg_temp.link_sql('far', 'VENDOR_SUPPLIED', 'AV Integrator', null, '91 days')), 'vendor_intake_expiry_range',
  'an expiry past 90 days is refused');
select is(pg_temp.try('carol', pg_temp.link_sql('classified', 'VENDOR_SUPPLIED', 'AV Integrator', pg_temp.k('secret'))), 'intake_agreement_classified',
  'a Confidential agreement is refused');
select is(pg_temp.try('carol', format($$insert into app.vendor_intake_links (project_id, role_type, role_code, worker_classification, title, token_hash,
  token_hint, access_code_hash, expires_at, start_date) values (%L, 'Contractor', '5000.51.02', 'INDEPENDENT_CONTRACTOR', 'Direct', '\x00', 'abcd', '\x00',
  now() + interval '1 day', current_date)$$, pg_temp.id('prj_a'))), '42501', 'a link is never inserted directly');

-- Opening -------------------------------------------------------------------------------------------------------------
create function pg_temp.read_only_open() returns text
language plpgsql as $$
begin
  begin
    perform set_config('transaction_read_only', 'on', true);
    perform api_public.open_vendor_intake(split_part(pg_temp.v('audio'), ' ', 1), '000000', null);
  exception when others then
    perform set_config('transaction_read_only', 'off', true);
    return sqlstate;
  end;
  perform set_config('transaction_read_only', 'off', true);
  return 'ran';
end $$;
select pg_temp.as_anon();
select is(pg_temp.read_only_open(), '25006', 'a read-only (GET) open is refused before any lookup');
select pg_temp.as_platform();
select is(pg_temp.open('xvin_' || repeat('0', 64), '000000') ->> 'reason', 'intake_link_invalid', 'an unknown token is refused');
select is(pg_temp.open(split_part(pg_temp.v('audio'), ' ', 1), null) ->> 'reason', 'intake_access_code_required', 'the code is asked for');
select is(pg_temp.open(split_part(pg_temp.v('audio'), ' ', 1), case when split_part(pg_temp.v('audio'), ' ', 2) = '000000' then '111111' else '000000' end)
  ->> 'reason', 'intake_access_code', 'a wrong code is refused');
select pg_temp.put('grant', null, pg_temp.open(split_part(pg_temp.v('audio'), ' ', 1), split_part(pg_temp.v('audio'), ' ', 2)) ->> 'grant');
select matches(pg_temp.v('grant'), '^xvig_[0-9a-f]{64}$', 'the right code earns an xvig_ grant');

-- Reading -------------------------------------------------------------------------------------------------------------
select pg_temp.as_anon();
select set_config('request.headers', json_build_object('x-forwarded-for', '192.0.2.10')::text, true);
select pg_temp.put('read', null, api_public.vendor_intake(split_part(pg_temp.v('audio'), ' ', 1), pg_temp.v('grant'), '198.51.100.7')::text);
select pg_temp.put('ticket', null, (select a.ticket from api_public.vendor_intake_agreement(split_part(pg_temp.v('audio'), ' ', 1), pg_temp.v('grant'), '198.51.100.7') a));
select pg_temp.as_platform();
select ok(pg_temp.v('read')::jsonb ->> 'status' = 'ok' and pg_temp.v('read')::jsonb #>> '{agreement,title}' = 'Master services agreement'
  and pg_temp.v('read')::jsonb ->> 'role_type' = 'Vendor', 'the read answers the title, role type and the agreement''s title');
select ok(pg_temp.v('read') not like '%Audio vendors for the summer%' and pg_temp.v('read') not like '%rate%85000%'
  and not (pg_temp.v('read')::jsonb ? 'rate_minor'), 'never the note or the rate');
select is((select count(*)::int from app.consume_file_download_ticket(pg_temp.v('ticket'))), 1,
  'the pinned agreement downloads once by ticket');
select ok(exists (select 1 from app.file_access_log l where l.action = 'Share Link Opened' and l.person_id is null and l.object_path = pg_temp.v('msa')),
  'and logs Share Link Opened with no person');
select pg_temp.as_anon();
select is((select array_agg(x order by x) from jsonb_object_keys(pg_temp.v('read')::jsonb) x),
  array['agreement', 'collect_invoice', 'collect_payout', 'collect_tax_form', 'end_date', 'full', 'instructions', 'meta', 'role_title', 'role_type', 'start_date', 'status', 'title'],
  'the read answers its exact key set, never the org''s id');
create function pg_temp.read_only_read() returns text
language plpgsql as $$
begin
  begin
    perform set_config('transaction_read_only', 'on', true);
    perform api_public.vendor_intake(split_part(pg_temp.v('audio'), ' ', 1), pg_temp.v('grant'), null);
  exception when others then
    perform set_config('transaction_read_only', 'off', true);
    return sqlstate;
  end;
  perform set_config('transaction_read_only', 'off', true);
  return 'ran';
end $$;
select is(pg_temp.read_only_read(), '25006', 'a read-only read is refused');
select pg_temp.as_platform();

-- Regenerating, locking and revoking -----------------------------------------------------------------------------------
select pg_temp.as_user('carol');
select pg_temp.put('audio2', null, (select r.token || ' ' || r.access_code from app.regenerate_vendor_intake_link(pg_temp.k('audio')) r));
select pg_temp.as_platform();
select pg_temp.put('f0', null, pg_temp.failures()::text);
select ok(pg_temp.open(split_part(pg_temp.v('audio'), ' ', 1), split_part(pg_temp.v('audio'), ' ', 2)) ->> 'reason' = 'intake_link_invalid'
  and pg_temp.failures() = pg_temp.v('f0')::int, 'a regenerated token answers intake_link_invalid without counting a failure');
select pg_temp.open(split_part(pg_temp.v('audio2'), ' ', 1), '999999', '198.51.100.40') from generate_series(1, 4);
select is(pg_temp.open(split_part(pg_temp.v('audio2'), ' ', 1), '999999', '198.51.100.40') ->> 'reason', 'intake_link_locked',
  'the fifth wrong code locks the link');
select pg_temp.as_user('carol');
select app.revoke_vendor_intake_link(pg_temp.k('audio'));
select pg_temp.as_platform();
select is(pg_temp.open(split_part(pg_temp.v('audio2'), ' ', 1), split_part(pg_temp.v('audio2'), ' ', 2), '198.51.100.41') ->> 'reason',
  'intake_link_invalid', 'a revoked link never opens again');

select * from finish();
rollback;

-- pgTAP: migration 2915, B2 (RRR-226, ADR 0141). What arrives through a reusable vendor intake link: the payout reference
-- path refuses a bank-shaped value, a request carries only references, the requester reads through an allowlisted view,
-- the team is notified, approving makes an Onboarding engagement on the link's terms with its items submitted and never
-- verified, the agreement is signed for the pinned version in the project's zone, the first invoice waits for the money
-- area, and a declined or withdrawn request takes the Restricted rows written for it.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

select plan(67);

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
  return v_document;
end $$;

-- A Vendor or Contractor link; keeps the token, the code and a grant for it.
create function pg_temp.link(p_key text, p_type text, p_agreement uuid default null, p_invoice boolean default false, p_max integer default 50) returns void
language plpgsql as $$
declare
  v record;
  v_open jsonb;
begin
  perform pg_temp.as_user('carol');
  select * into v from app.create_vendor_intake_link(pg_temp.id('prj_a'), 'Intake ' || p_key, p_type::app.external_role_type,
    case when p_type = 'Vendor' then '9000.50.02' else '5000.51.02' end,
    case when p_type = 'Vendor' then 'VENDOR_SUPPLIED' else 'INDEPENDENT_CONTRACTOR' end, 'Day Rate', 'Per Engagement', '2027-06-01',
    now() + interval '30 days', '2027-06-30', case when p_type = 'Vendor' then 'AV Integrator' end, p_agreement, 'Send us your details.', 'Team note',
    true, true, p_invoice, p_max);
  perform pg_temp.put(p_key, v.vendor_intake_link_id, v.token);
  perform pg_temp.as_anon();
  perform set_config('request.headers', json_build_object('x-forwarded-for', '192.0.2.10')::text, true);
  v_open := api_public.open_vendor_intake(v.token, v.access_code, '198.51.100.70');
  perform pg_temp.as_platform();
  perform pg_temp.put(p_key || ':grant', null, v_open ->> 'grant');
end $$;

create function pg_temp.t(p_key text) returns text language sql stable as $$ select val from k where key = p_key $$;
create function pg_temp.g(p_key text) returns text language sql stable as $$ select val from k where key = p_key || ':grant' $$;
grant execute on function pg_temp.k(text), pg_temp.t(text), pg_temp.g(text), pg_temp.v(text) to public;

create function pg_temp.tax_form(p_user text, p_key text, p_kind text, p_account text default null) returns uuid
language plpgsql as $$
declare v_id uuid;
begin
  perform pg_temp.as_user(p_user);
  v_id := app.submit_tax_form(pg_temp.id('org_a'), p_kind::app.tax_form_kind, '123456789', pg_temp.id(p_account));
  perform pg_temp.as_platform();
  perform pg_temp.put(p_key, v_id, null);
  return v_id;
end $$;

create function pg_temp.draft(p_currency text default 'USD') returns jsonb language sql immutable as $$
  select jsonb_strip_nulls(jsonb_build_object('invoice_number', 'BA-77', 'issue_date', '2027-06-01', 'due_date', '2027-07-01', 'currency_code', p_currency,
    'lines', jsonb_build_array(jsonb_build_object('description', 'Audio day', 'quantity', 2, 'unit_price_minor', 120000)))) $$;
grant execute on function pg_temp.draft(text) to public;

select pg_temp.new_user('lena', 'lena@freelance.test', 'Lena Duarte');
select pg_temp.new_user('nora', 'nora@stageworks.test', 'Nora Quist');
select pg_temp.as_user('nora');
insert into world values ('acct_n', app.create_external_account('Stageworks', 'stageworks'));
select pg_temp.as_user('carol');
insert into app.onboarding_requirements (org_id, name, item_kind, verification_method) values
  (pg_temp.id('org_a'), 'W-9 on file', 'Tax Form', 'Reviewer'),
  (pg_temp.id('org_a'), 'Remittance details', 'Payout Details', 'Reviewer');
select pg_temp.as_platform();
select pg_temp.agreement('msa', 'Master services agreement');
select pg_temp.link('vendor', 'Vendor', pg_temp.k('msa'), true);
select pg_temp.link('solo', 'Contractor');
select pg_temp.link('single', 'Contractor', null, false, 1);

-- Payout references ----------------------------------------------------------------------------------------------------
select is(pg_temp.try('victor', format($$select app.add_intake_payout_reference(%L, null, 'V-10442', %L)$$, pg_temp.t('vendor'), pg_temp.id('acct_v'))),
  'intake_grant', 'a payout reference needs the link''s grant');
select is(pg_temp.try('sam', format($$select app.add_intake_payout_reference(%L, %L, 'V-10442', %L)$$, pg_temp.t('vendor'), pg_temp.g('vendor'), pg_temp.id('acct_v'))),
  'vendor_intake_account', 'an Account Member files no payout reference for the account');
select pg_temp.as_user('victor');
select pg_temp.put('payout', app.add_intake_payout_reference(pg_temp.t('vendor'), pg_temp.g('vendor'), 'V-10442', pg_temp.id('acct_v')), null);
select pg_temp.as_platform();
select is((select provider::text || '/' || coalesce(account_last4, 'none') from app.payout_accounts where id = pg_temp.k('payout')), 'Accounting System/none',
  'a reference such as V-10442 is written in provider Accounting System, with no last four');
select pg_temp.as_user('victor');
select is(app.add_intake_payout_reference(pg_temp.t('vendor'), pg_temp.g('vendor'), 'V-10442', pg_temp.id('acct_v')), pg_temp.k('payout'),
  'an identical reference answers the existing row');
select pg_temp.as_platform();
select pg_temp.put('payouts', null, (select count(*)::text from app.payout_accounts));
select is(pg_temp.try('victor', format($$select app.add_intake_payout_reference(%L, %L, '100234', %L)$$, pg_temp.t('vendor'), pg_temp.g('vendor'), pg_temp.id('acct_v'))),
  'payout_reference_bank_number', 'a plain digit run of 6 is refused, an AP vendor number included');
select is(pg_temp.try('victor', format($$select app.add_intake_payout_reference(%L, %L, '12-3456 7890', %L)$$, pg_temp.t('vendor'), pg_temp.g('vendor'), pg_temp.id('acct_v'))),
  'payout_reference_bank_number', 'a hyphenated or spaced digit run is refused');
select is(pg_temp.try('victor', format($$select app.add_intake_payout_reference(%L, %L, 'GB82 WEST 1234 5698 7654 32', %L)$$, pg_temp.t('vendor'), pg_temp.g('vendor'), pg_temp.id('acct_v'))),
  'payout_reference_bank_number', 'an IBAN shape is refused');
select is((select count(*)::text from app.payout_accounts), pg_temp.v('payouts'), 'a refused reference stores nothing');

-- The org's id ---------------------------------------------------------------------------------------------------------
select pg_temp.as_user('victor');
select is(app.vendor_intake_org(pg_temp.t('vendor'), pg_temp.g('vendor')), pg_temp.id('org_a'), 'a signed-in caller holding the token and grant gets the org''s id');
select pg_temp.as_platform();
select is(pg_temp.try('victor', format($$select app.vendor_intake_org(%L, null)$$, pg_temp.t('vendor'))), 'intake_grant', 'without the grant it is refused');
select ok(not has_function_privilege('anon', 'app.vendor_intake_org(text, text, text)', 'execute')
  and not has_function_privilege('anon', 'app.add_intake_payout_reference(text, text, text, uuid, text)', 'execute')
  and not has_function_privilege('anon', 'app.submit_vendor_intake(text, text, uuid, uuid, uuid, text, jsonb, text)', 'execute'),
  'anon cannot execute the signed-in intake calls');

-- Submitting -----------------------------------------------------------------------------------------------------------
select pg_temp.tax_form('victor', 'tax_v', 'W-9', 'acct_v');
select pg_temp.tax_form('lena', 'tax_l', 'W-9');
select pg_temp.tax_form('nora', 'tax_n', 'W-9', 'acct_n');
select is(pg_temp.try('victor', format($$select app.submit_vendor_intake(%L, null, %L, %L, null, 'Victor Osei')$$, pg_temp.t('vendor'), pg_temp.id('acct_v'), pg_temp.k('tax_v'))),
  'intake_grant', 'a request needs the link''s grant');
select is(pg_temp.try('victor', format($$select app.submit_vendor_intake(%L, %L, null, %L, null, 'Victor Osei')$$, pg_temp.t('vendor'), pg_temp.g('vendor'), pg_temp.k('tax_v'))),
  'vendor_intake_account', 'a Vendor request needs an account');
select is(pg_temp.try('sam', format($$select app.submit_vendor_intake(%L, %L, %L, %L, null, 'Sam')$$, pg_temp.t('vendor'), pg_temp.g('vendor'), pg_temp.id('acct_v'), pg_temp.k('tax_v'))),
  'vendor_intake_account', 'an Account Member sends no request for the account');
select is(pg_temp.try('victor', format($$select app.submit_vendor_intake(%L, %L, %L, null, null, 'Victor Osei')$$, pg_temp.t('vendor'), pg_temp.g('vendor'), pg_temp.id('acct_v'))),
  'vendor_intake_tax_form', 'a link that collects a tax form needs one');
select is(pg_temp.try('victor', format($$select app.submit_vendor_intake(%L, %L, %L, %L, null, 'Victor Osei')$$, pg_temp.t('vendor'), pg_temp.g('vendor'), pg_temp.id('acct_v'), pg_temp.k('tax_l'))),
  'vendor_intake_tax_form', 'another payee''s tax form is refused');
select is(pg_temp.try('victor', format($$with p as (insert into app.payout_accounts (org_id, organization_id, provider, provider_account_reference)
  values (%L, %L, 'Accounting System', '99887766') returning id) insert into k select 'laundered', id, null from p$$, pg_temp.id('org_a'), pg_temp.id('acct_v'))), 'ok',
  'the 0730 grant still lets a payee insert a reference directly');
select is(pg_temp.try('victor', format($$select app.submit_vendor_intake(%L, %L, %L, %L, %L, 'Victor Osei')$$, pg_temp.t('vendor'), pg_temp.g('vendor'), pg_temp.id('acct_v'), pg_temp.k('tax_v'), pg_temp.k('laundered'))),
  'payout_reference_bank_number', 'a bank-shaped reference inserted directly is refused at submit');
select is(pg_temp.try('victor', format($$select app.submit_vendor_intake(%L, %L, %L, %L, %L)$$, pg_temp.t('vendor'), pg_temp.g('vendor'), pg_temp.id('acct_v'), pg_temp.k('tax_v'), pg_temp.k('payout'))),
  'vendor_intake_signature', 'a link with an agreement needs the typed name');
select is(pg_temp.try('victor', format($$select app.submit_vendor_intake(%L, %L, %L, %L, %L, 'Victor Osei', %L)$$, pg_temp.t('vendor'), pg_temp.g('vendor'), pg_temp.id('acct_v'), pg_temp.k('tax_v'), pg_temp.k('payout'),
    (pg_temp.draft() - 'currency_code')::text)), 'vendor_intake_invoice_draft', 'an invoice draft without a currency is refused');
select is(pg_temp.try('victor', format($$select app.submit_vendor_intake(%L, %L, %L, %L, %L, 'Victor Osei', %L)$$, pg_temp.t('vendor'), pg_temp.g('vendor'), pg_temp.id('acct_v'), pg_temp.k('tax_v'), pg_temp.k('payout'),
    pg_temp.draft('ZZZ')::text)), 'vendor_intake_invoice_draft', 'an invoice draft with an unknown currency is refused');
select is(pg_temp.try('lena', format($$select app.submit_vendor_intake(%L, %L, null, %L, null, null, %L)$$, pg_temp.t('solo'), pg_temp.g('solo'), pg_temp.k('tax_l'), pg_temp.draft()::text)),
  'vendor_intake_invoice_not_collected', 'an invoice draft on a link that takes none is refused');

select pg_temp.as_user('victor');
select pg_temp.put('r_v', app.submit_vendor_intake(pg_temp.t('vendor'), pg_temp.g('vendor'), pg_temp.id('acct_v'), pg_temp.k('tax_v'), pg_temp.k('payout'), 'Victor Osei', pg_temp.draft()), null);
select pg_temp.as_platform();
select is((select project_id from app.vendor_intake_requests where id = pg_temp.k('r_v')), pg_temp.id('prj_a'), 'the request is stamped with the link''s project');
select ok((select count(*) > 0 and bool_and(n.recipient_person_id <> pg_temp.id('victor')) from app.notifications n
  where n.kind = 'vendor_intake.submitted' and n.subject_id = pg_temp.k('r_v')), 'submitting notifies the project''s members through vendor_intake.submitted');
select is(pg_temp.try('victor', format($$select app.submit_vendor_intake(%L, %L, %L, %L, %L, 'Victor Osei')$$, pg_temp.t('vendor'), pg_temp.g('vendor'), pg_temp.id('acct_v'), pg_temp.k('tax_v'), pg_temp.k('payout'))),
  'vendor_intake_pending', 'a second pending request on the link is refused');

-- Limits ---------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('lena');
select pg_temp.put('r_l1', app.submit_vendor_intake(pg_temp.t('solo'), pg_temp.g('solo'), null, pg_temp.k('tax_l')), null);
select app.withdraw_vendor_intake(pg_temp.k('r_l1'));
select pg_temp.as_platform();
select ok((select deleted_at is not null from app.tax_forms where id = pg_temp.k('tax_l')),
  'withdrawing with no engagement in the org takes the tax form written for it');
select pg_temp.tax_form('lena', 'tax_l', 'W-9');
select pg_temp.as_user('lena');
select pg_temp.put('r_l2', app.submit_vendor_intake(pg_temp.t('solo'), pg_temp.g('solo'), null, pg_temp.k('tax_l')), null);
select app.withdraw_vendor_intake(pg_temp.k('r_l2'));
select pg_temp.as_platform();
select pg_temp.tax_form('lena', 'tax_l', 'W-9');
select pg_temp.as_user('lena');
select pg_temp.put('r_l3', app.submit_vendor_intake(pg_temp.t('solo'), pg_temp.g('solo'), null, pg_temp.k('tax_l')), null);
select app.withdraw_vendor_intake(pg_temp.k('r_l3'));
select pg_temp.as_platform();
select pg_temp.tax_form('lena', 'tax_l', 'W-9');
select is(pg_temp.try('lena', format($$select app.submit_vendor_intake(%L, %L, null, %L)$$, pg_temp.t('solo'), pg_temp.g('solo'), pg_temp.k('tax_l'))),
  'vendor_intake_rate_limited', 'a fourth request by the person on the link within 24 hours is refused');

select pg_temp.as_user('lena');
select pg_temp.put('r_single', app.submit_vendor_intake(pg_temp.t('single'), pg_temp.g('single'), null, pg_temp.k('tax_l')), null);
select pg_temp.as_platform();
select pg_temp.tax_form('art', 'tax_a', 'W-9');
select is(pg_temp.try('art', format($$select app.submit_vendor_intake(%L, %L, null, %L)$$, pg_temp.t('single'), pg_temp.g('single'), pg_temp.k('tax_a'))),
  'intake_link_full', 'a link at max_requests is full, counted from the requests');
select pg_temp.as_user('lena');
select app.withdraw_vendor_intake(pg_temp.k('r_single'));
select pg_temp.as_platform();
select is(pg_temp.try('art', format($$select app.submit_vendor_intake(%L, %L, null, %L)$$, pg_temp.t('single'), pg_temp.g('single'), pg_temp.k('tax_a'))),
  'ok', 'a withdrawn request frees its slot');

-- Who reads what -------------------------------------------------------------------------------------------------------
select pg_temp.as_user('victor');
select is((select count(*)::int from app.vendor_intake_requests), 0, 'the requester cannot read the table directly');
select is((select count(*)::int from api_external.my_vendor_intake_requests where id = pg_temp.k('r_v')), 1, 'the requester reads their request through the view');
select pg_temp.as_user('fiona');
select is((select count(*)::int from api_external.my_vendor_intake_requests where id = pg_temp.k('r_v')), 1, 'the account''s Finance member reads it');
select pg_temp.as_user('sam');
select is((select count(*)::int from api_external.my_vendor_intake_requests where id = pg_temp.k('r_v')), 0, 'an Account Member does not');
select pg_temp.as_user('quinn');
select is((select count(*)::int from api_external.my_vendor_intake_requests where id = pg_temp.k('r_v')), 0, 'another party does not');
select pg_temp.as_platform();
select is((select array_agg(column_name::text order by column_name::text) from information_schema.columns
  where table_schema = 'api_external' and table_name = 'my_vendor_intake_requests'),
  array['created_at','decision_reason','engagement_id','id','invoice_ready','invoice_used','org_name','project_name','request_state','title'],
  'the view is column-allowlisted');
select is((select count(*)::int from private.column_classifications c
  where c.classification = 'Restricted' and c.table_name in ('app.vendor_intake_links', 'app.vendor_intake_requests', 'app.stakeholder_packs',
    'app.stakeholder_pack_recipients', 'app.stakeholder_pack_items', 'app.stakeholder_pack_events', 'app.form_links')), 0, 'no B2 column is classified Restricted');
select is((select count(*)::int from information_schema.columns c
  where c.table_schema in ('app', 'private') and c.table_name in ('vendor_intake_links', 'vendor_intake_requests', 'vendor_intake_grants', 'stakeholder_packs',
      'stakeholder_pack_recipients', 'stakeholder_pack_items', 'stakeholder_pack_events', 'stakeholder_pack_links', 'stakeholder_pack_grants', 'form_links', 'form_link_grants')
    and c.column_name ~ '(tin|bank|routing|account_number)'), 0, 'no B2 column name holds a tax identifier or bank detail');

-- Party names ----------------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
select is((select requester_name || ' / ' || account_name from app.vendor_intake_request_party(pg_temp.k('r_v'))), 'Victor Osei / Bayside Audio',
  'a member holding opportunities.engagement.read reads the party''s names');
select pg_temp.as_user('quinn');
select is((select count(*)::int from app.vendor_intake_request_party(pg_temp.k('r_v'))), 0, 'someone outside the org gets no row');
select pg_temp.as_user('xavier');
select is((select count(*)::int from app.vendor_intake_request_party(pg_temp.k('r_v'))), 0, 'a member of another org gets no row');
select pg_temp.as_platform();

-- Deciding -------------------------------------------------------------------------------------------------------------
select is(pg_temp.try('dave', format($$select app.decide_vendor_intake(%L, true)$$, pg_temp.k('r_v'))), '42501',
  'a member without opportunities.engagement.write decides nothing');
select pg_temp.as_user('victor');
select app.add_account_member(pg_temp.id('acct_v'), pg_temp.id('bob'), 'Account Member');
select pg_temp.as_user('bob');
select app.accept_account_membership((select m.id from app.account_memberships m where m.org_id = pg_temp.id('acct_v') and m.person_id = pg_temp.id('bob')));
select pg_temp.as_platform();
select is(pg_temp.try('bob', format($$select app.decide_vendor_intake(%L, true)$$, pg_temp.k('r_v'))), 'sod_vendor_intake_self',
  'anyone with a role in the vendor account cannot decide it');
select is((select count(*)::int from private.separation_of_duties_rules where code = 'sod_vendor_intake_self'), 1, 'the separation of duties rule is registered');
select is(pg_temp.try('carol', format($$select app.decide_vendor_intake(%L, false, 'too short')$$, pg_temp.k('r_v'))), 'vendor_intake_decline_reason',
  'a decline needs a reason of at least 10 characters');

select pg_temp.as_user('carol');
select pg_temp.put('eng_v', app.decide_vendor_intake(pg_temp.k('r_v'), true), null);
select throws_like(format($$select app.decide_vendor_intake(%L, true)$$, pg_temp.k('r_v')), 'vendor_intake_not_pending:%', 'a decided request cannot be decided again');
select pg_temp.as_platform();
select is((select engagement_state::text || '/' || role_type::text || '/' || role_code || '/' || worker_classification || '/' || pay_basis || '/' || arrangement || '/' || start_date::text || '/' || end_date::text
  from app.engagements where id = pg_temp.k('eng_v')), 'Onboarding/Vendor/9000.50.02/VENDOR_SUPPLIED/Day Rate/Per Engagement/2027-06-01/2027-06-30',
  'approval makes an Onboarding engagement on the link''s terms');
select is((select counterparty_id from app.engagements where id = pg_temp.k('eng_v')), pg_temp.id('cp_v_a'), 'the org''s live counterparty for the account is reused');
select is((select count(*)::int from app.onboarding_items i join app.onboarding_requirements q on q.id = i.onboarding_requirement_id
  where i.engagement_id = pg_temp.k('eng_v') and q.item_kind in ('Tax Form', 'Payout Details') and i.submitted_at is not null), 2,
  'its Tax Form and Payout Details items are submitted');
select is((select count(*)::int from app.onboarding_verifications v join app.onboarding_items i on i.id = v.onboarding_item_id
  where i.engagement_id = pg_temp.k('eng_v')), 0, 'nothing is verified for the reviewer');
select is(pg_temp.try('carol', format($$select app.transition_engagement(%L, 'Onboarding', 'Active', 'Go.')$$, pg_temp.k('eng_v'))), 'onboarding_incomplete',
  'the engagement cannot become Active until a reviewer verifies');
select is((select document_state::text from app.engagement_documents where engagement_id = pg_temp.k('eng_v')), 'Signed', 'the agreement is Signed');
select ok((select t.reason ~ '^Signed at intake by Victor Osei on \d{4}-\d{2}-\d{2} \d{2}:\d{2} \S+, version 1$' from app.engagement_document_state_transitions t
    join app.engagement_documents d on d.id = t.engagement_document_id
    where d.engagement_id = pg_temp.k('eng_v') and t.to_state = 'Signed'), 'the ledger reason names the signer, the time in the project''s zone and the version');

-- A newer version stays Sent; a new account gets a counterparty; a decline takes the rows written for it -----------------------
select pg_temp.as_user('nora');
select pg_temp.put('payout_n', app.add_intake_payout_reference(pg_temp.t('vendor'), pg_temp.g('vendor'), 'SW-204', pg_temp.id('acct_n')), null);
select pg_temp.put('r_n', app.submit_vendor_intake(pg_temp.t('vendor'), pg_temp.g('vendor'), pg_temp.id('acct_n'), pg_temp.k('tax_n'), pg_temp.k('payout_n'), 'Nora Quist'), null);
select pg_temp.as_user('carol');
select app.decide_vendor_intake(pg_temp.k('r_n'), false, 'We already have this crew booked.');
select pg_temp.as_platform();
select ok((select deleted_at is not null from app.tax_forms where id = pg_temp.k('tax_n'))
  and (select deleted_at is not null from app.payout_accounts where id = pg_temp.k('payout_n')),
  'a decline with no engagement takes the tax form and payout reference written for it');

select pg_temp.tax_form('nora', 'tax_n2', 'W-9', 'acct_n');
select pg_temp.as_user('carol');
insert into app.document_versions (document_id, storage_uri, checksum_sha256) values (pg_temp.k('msa'), 'docs/msa-v2.pdf', repeat('e', 64));
select pg_temp.as_user('nora');
select pg_temp.put('payout_n2', app.add_intake_payout_reference(pg_temp.t('vendor'), pg_temp.g('vendor'), 'SW-205', pg_temp.id('acct_n')), null);
select pg_temp.put('r_n2', app.submit_vendor_intake(pg_temp.t('vendor'), pg_temp.g('vendor'), pg_temp.id('acct_n'), pg_temp.k('tax_n2'), pg_temp.k('payout_n2'), 'Nora Quist', pg_temp.draft()), null);
-- 0730's grant lets the payee change the reference after submit, into a bank number.
update app.payout_accounts set provider_account_reference = '445566778899' where id = pg_temp.k('payout_n2');
select pg_temp.as_user('carol');
select pg_temp.put('eng_n', app.decide_vendor_intake(pg_temp.k('r_n2'), true), null);
select pg_temp.as_platform();
select is((select o.organization_id from app.engagements e join app.counterparties o on o.id = e.counterparty_id where e.id = pg_temp.k('eng_n')), pg_temp.id('acct_n'),
  'an account the org has no counterparty for gets one');
select is((select document_state::text from app.engagement_documents where engagement_id = pg_temp.k('eng_n')), 'Sent',
  'the agreement stays Sent when the document has a newer version than the one signed');
select is((select count(*)::int from app.onboarding_items i join app.onboarding_requirements q on q.id = i.onboarding_requirement_id
  where i.engagement_id = pg_temp.k('eng_n') and q.item_kind = 'Payout Details' and i.submitted_at is not null), 0,
  'a reference laundered into a bank number after submit leaves its item unsubmitted');

-- The first invoice ----------------------------------------------------------------------------------------------------
select is(pg_temp.try('victor', format($$select app.submit_intake_invoice(%L)$$, pg_temp.k('r_v'))), '42501', 'the money area is closed during onboarding');
select pg_temp.as_user('carol');
insert into app.onboarding_verifications (onboarding_item_id, outcome)
select i.id, 'Passed' from app.onboarding_items i where i.engagement_id = pg_temp.k('eng_v') and i.deleted_at is null;
select app.transition_engagement(pg_temp.k('eng_v'), 'Onboarding', 'Active', 'Onboarded.');
select pg_temp.as_user('victor');
select pg_temp.put('inv', app.submit_intake_invoice(pg_temp.k('r_v')), null);
select pg_temp.as_platform();
select is((select invoice_state::text || '/' || currency_code from app.invoices where id = pg_temp.k('inv')), 'Proposed/USD', 'after Active the draft becomes one Proposed invoice in its currency');
select is(pg_temp.try('victor', format($$select app.submit_intake_invoice(%L)$$, pg_temp.k('r_v'))), 'intake_invoice_used', 'a second call answers intake_invoice_used');

-- A plan limit refusal surfaces its own code and changes nothing --------------------------------------------------------
select pg_temp.as_user('xavier');
select pg_temp.put('harbor', l.vendor_intake_link_id, l.token || ' ' || l.access_code)
from app.create_vendor_intake_link(pg_temp.id('prj_b'), 'Harbor crew', 'Contractor', '5000.51.02', 'INDEPENDENT_CONTRACTOR', 'Day Rate', 'Per Engagement',
  '2027-08-01', now() + interval '30 days', null, null, null, null, null, false, false, false) l;
select pg_temp.as_anon();
select set_config('request.headers', json_build_object('x-forwarded-for', '192.0.2.10')::text, true);
select pg_temp.put('harbor:grant', null, api_public.open_vendor_intake(split_part(pg_temp.v('harbor'), ' ', 1), split_part(pg_temp.v('harbor'), ' ', 2), '198.51.100.71') ->> 'grant');
select pg_temp.as_user('lena');
select pg_temp.put('r_h', app.submit_vendor_intake(split_part(pg_temp.v('harbor'), ' ', 1), pg_temp.v('harbor:grant')), null);
select pg_temp.as_user('xavier');
insert into app.engagements (project_id, person_id, role_type, role_code, worker_classification, pay_basis, arrangement, start_date)
select pg_temp.id('prj_b'), pg_temp.id('quinn'), 'Crew', '5000.51.02', 'INDEPENDENT_CONTRACTOR', 'Day Rate', 'Per Engagement', '2027-08-01'
from generate_series(1, 25 - (select count(*)::int from app.engagements e where e.org_id = pg_temp.id('org_b')));
select throws_like(format($$select app.decide_vendor_intake(%L, true)$$, pg_temp.k('r_h')), 'plan_limit_exceeded:%', 'the plan limit surfaces its own code on approve');
select pg_temp.as_platform();
select is((select request_state::text from app.vendor_intake_requests where id = pg_temp.k('r_h')), 'Pending', 'and the request stays Pending');

-- Deleting the org takes every B2 row (1351): a file-item pack with a recipient, link, grant and ticket, an intake link with
-- a grant and request, and a form link with a grant and response. The file item alone: P1's own private tables are
-- recorded for the orchestrator (ADR 0141), so this fixture holds no live link.
select pg_temp.new_user('oona', 'oona@purge.test', 'Oona Reyes');
select pg_temp.as_user('oona');
select pg_temp.put('org_del', o.org_id, null) from (select app.create_organization('Short Lived Events', 'short-lived-events') as org_id) o;
insert into world values ('org_del', pg_temp.k('org_del'));
select pg_temp.put('prj_del', app.create_project(pg_temp.k('org_del'), 'Closing show', 'CLS'), null);
select pg_temp.as_user('oona');
select pg_temp.put('ver_del', u.attachment_version_id, u.object_name)
from app.begin_attachment_upload('app.projects', pg_temp.k('prj_del'), 'site.pdf', 'application/pdf', 1200) u;
insert into storage.objects (bucket_id, name, metadata) values ('attachments', pg_temp.v('ver_del'), '{"size": 1200}');
select app.complete_attachment_upload(pg_temp.k('ver_del'), repeat('ab', 32));
select pg_temp.as_platform();
select app.record_attachment_scan(pg_temp.k('ver_del'), true);
select pg_temp.put('att_del', (select v.attachment_id from app.attachment_versions v where v.id = pg_temp.k('ver_del')), null);
select pg_temp.as_user('oona');
select pg_temp.put('pack_del', app.create_stakeholder_pack(pg_temp.k('prj_del'), 'Closing pack', now() + interval '20 days'), null);
select app.add_stakeholder_pack_item(pg_temp.k('pack_del'), null, pg_temp.k('att_del'), 'Site map');
select pg_temp.put('rec_del', r.recipient_id, r.access_code) from app.add_stakeholder_pack_recipient(pg_temp.k('pack_del'), 'Cleo Client', 'cleo@client.test') r;
select app.send_stakeholder_pack(pg_temp.k('pack_del'));
select pg_temp.as_platform();
select pg_temp.put('tok_del', null, m.token) from app.mint_stakeholder_pack_link((select d.id from app.stakeholder_pack_deliveries d where d.recipient_id = pg_temp.k('rec_del'))) m;
select pg_temp.as_anon();
select set_config('request.headers', json_build_object('x-forwarded-for', '192.0.2.10')::text, true);
select pg_temp.put('grant_del', null, api_public.open_stakeholder_pack(pg_temp.v('tok_del'), pg_temp.v('rec_del'), '198.51.100.72') ->> 'grant');
select pg_temp.put('ticket_del', null, (select f.ticket from api_public.stakeholder_pack_file(pg_temp.v('tok_del'), array[pg_temp.v('grant_del')],
  (select i.id from app.stakeholder_pack_items i where i.stakeholder_pack_id = pg_temp.k('pack_del')), '198.51.100.72') f));
select pg_temp.as_user('oona');
select pg_temp.put('intake_del', l.vendor_intake_link_id, l.token || ' ' || l.access_code)
from app.create_vendor_intake_link(pg_temp.k('prj_del'), 'Closing crew', 'Contractor', '5000.51.02', 'INDEPENDENT_CONTRACTOR', 'Day Rate', 'Per Engagement',
  '2027-08-01', now() + interval '30 days', null, null, null, null, null, false, false, false) l;
insert into app.form_templates (org_id, name, record_kind, fields) values (pg_temp.k('org_del'), 'Exit survey', 'Document', '[{"key": "notes", "label": "Notes", "kind": "text"}]');
select app.publish_form_template((select t.id from app.form_templates t where t.org_id = pg_temp.k('org_del') and t.name = 'Exit survey'));
select pg_temp.put('form_del', l.form_link_id, l.token || ' ' || l.access_code)
from app.create_form_link((select t.id from app.form_templates t where t.org_id = pg_temp.k('org_del') and t.name = 'Exit survey'), now() + interval '30 days') l;
select pg_temp.as_anon();
select set_config('request.headers', json_build_object('x-forwarded-for', '192.0.2.10')::text, true);
select pg_temp.put('intake_del:grant', null, api_public.open_vendor_intake(split_part(pg_temp.v('intake_del'), ' ', 1), split_part(pg_temp.v('intake_del'), ' ', 2), '198.51.100.73') ->> 'grant');
select pg_temp.put('form_del:grant', null, api_public.open_form_link(split_part(pg_temp.v('form_del'), ' ', 1), split_part(pg_temp.v('form_del'), ' ', 2), '198.51.100.74') ->> 'grant');
select pg_temp.as_user('lena');
select app.submit_vendor_intake(split_part(pg_temp.v('intake_del'), ' ', 1), pg_temp.v('intake_del:grant'));
select pg_temp.as_platform();
update private.form_link_grants set issued_at = now() - interval '1 minute' where form_link_id = pg_temp.k('form_del');
select pg_temp.as_anon();
select set_config('request.headers', json_build_object('x-forwarded-for', '192.0.2.10')::text, true);
select is(api_public.submit_public_form(split_part(pg_temp.v('form_del'), ' ', 1), pg_temp.v('form_del:grant'), 'Rae Ortiz', 'rae@guest.test', '{"notes": "Fine."}', null, '198.51.100.74') ->> 'status', 'ok',
  'the fixture holds a form response');
select pg_temp.as_platform();
delete from storage.objects where bucket_id = 'attachments' and name = pg_temp.v('ver_del');
select pg_temp.put('cert_del', private.write_deletion_certificate(pg_temp.k('org_del'), 'cancellation', now(), now(), null), null);
update app.deletion_certificates set storage_cleared_at = now() where id = pg_temp.k('cert_del');
select private.purge_organization(pg_temp.k('cert_del'));
select ok((select purged_at is not null and blocked_reason is null from app.deletion_certificates where id = pg_temp.k('cert_del')),
  'an org holding packs, intake links and form links purges, nothing outside the org blocking it');
select is((select count(*)::int from app.stakeholder_packs where org_id = pg_temp.k('org_del'))
  + (select count(*)::int from private.stakeholder_pack_links where org_id = pg_temp.k('org_del'))
  + (select count(*)::int from private.stakeholder_pack_grants where org_id = pg_temp.k('org_del'))
  + (select count(*)::int from private.vendor_intake_grants where org_id = pg_temp.k('org_del'))
  + (select count(*)::int from private.form_link_grants where org_id = pg_temp.k('org_del'))
  + (select count(*)::int from private.file_download_tickets where org_id = pg_temp.k('org_del')), 0, 'and every private row went with it');

select * from finish();
rollback;

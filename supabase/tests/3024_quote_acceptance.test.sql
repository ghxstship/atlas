-- pgTAP: 3024, quote acceptance and the client-facing views (B13, RRR-237, S14.5-01, S4.4-12, ADR 0152). Signing a
-- Quote document through a link accepts the version with the typed name; signing in Gateway accepts it with that person;
-- an expired quote is refused; the acceptance lock; the exact column allowlists of api_external.quote_versions and
-- quote_version_lines; another engagement's caller and a Draft are never visible; api_public.token_quote counts wrong
-- codes; quote.accepted reaches the sender; Gateway bulk signing skips a quote.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

select * from no_plan();

create temporary table tok (key text primary key, token_id uuid, token text, access_code text);
grant select, insert, update on tok to public;

select pg_temp.new_user('cleo', 'cleo@coral-group.test', 'Cleo Marsh');
select pg_temp.as_user('cleo');
insert into world values ('acct_c', app.create_external_account('Coral Group', 'coral-group'));
select pg_temp.as_user('alice');
insert into world values ('cp_c_a', app.create_counterparty(pg_temp.id('org_a'), null, null, pg_temp.id('acct_c')));
with e as (insert into app.engagements (project_id, person_id, counterparty_id, role_type, start_date)
  values (pg_temp.id('prj_a'), pg_temp.id('cleo'), pg_temp.id('cp_c_a'), 'Client', '2027-06-01') returning id) insert into world select 'eng_client', id from e;
with b as (insert into app.budgets (project_id, name, currency_code, default_markup_bp) values (pg_temp.id('prj_a'), 'Quote Budget', 'USD', 2500) returning id)
  insert into world select 'bud', id from b;
insert into app.budget_lines (budget_id, line_number, description, urid, quantity, unit_price_minor, xyz, xyz_basis)
  values (pg_temp.id('bud'), 1, 'Stage deck.', '5000.04.02', 2, 10000, 'X', 'Declared');
insert into app.budget_lines (budget_id, line_number, description, urid, quantity, unit_price_minor, excluded_from_quote, xyz, xyz_basis)
  values (pg_temp.id('bud'), 2, 'Contingency.', '5000.01.01', 1, 5000, true, 'X', 'Declared');
select pg_temp.as_platform();
select pg_temp.move_engagement('eng_client', 'Onboarding', 'Active');

-- Two quotes: one accepted by link, one signed in Gateway.
select pg_temp.as_user('carol');
insert into world select 'q1', app.create_quote(pg_temp.id('bud'), 'Main stage', pg_temp.id('eng_client'));
insert into world select 'q1v1', (select id from app.quote_versions where quote_id = pg_temp.id('q1'));
insert into world select 'q2', app.create_quote(pg_temp.id('bud'), 'Second stage', pg_temp.id('eng_client'));
insert into world select 'q2v1', (select id from app.quote_versions where quote_id = pg_temp.id('q2'));

-- A Draft is never visible to the client.
select pg_temp.as_user('cleo');
select is_empty($$select 1 from api_external.quote_versions$$, 'a Draft never reaches Gateway');

select pg_temp.as_user('carol');
insert into world select 'doc1', s.engagement_document_id from app.send_quote_version(pg_temp.id('q1v1'), 'Sent.') s;
insert into world select 'doc2', s.engagement_document_id from app.send_quote_version(pg_temp.id('q2v1'), 'Sent.') s;
insert into tok select 'a', t.token_id, t.token, t.access_code from app.issue_engagement_document_token(pg_temp.id('doc1'), 'cleo@coral-group.test') t;
insert into world select 'q1v2', app.create_quote_version(pg_temp.id('q1'));

-- Client-facing views -------------------------------------------------------------------------------------------------------
select pg_temp.as_platform();
select is(
  (select array_agg(column_name::text order by ordinal_position) from information_schema.columns
   where table_schema = 'api_external' and table_name = 'quote_versions'),
  array['id', 'quote_id', 'quote_key', 'title', 'project_id', 'project_name', 'version_number', 'quote_version_state',
        'valid_until', 'terms', 'currency_code', 'total_minor', 'content_sha256', 'sent_at', 'accepted_at', 'accepted_name',
        'accepted_email', 'engagement_document_id', 'org_id', 'org_name', 'client_name', 'project_time_zone', 'legal_entity_name',
        'brand_accent_hex', 'brand_logo_path'],
  'api_external.quote_versions exposes exactly the client-facing columns');
select is(
  (select array_agg(column_name::text order by ordinal_position) from information_schema.columns
   where table_schema = 'api_external' and table_name = 'quote_version_lines'),
  array['id', 'quote_version_id', 'line_number', 'description', 'quantity', 'unit_basis', 'unit_price_minor', 'amount_minor'],
  'api_external.quote_version_lines exposes exactly the client-facing columns: no cost, markup, margin, URID or budget coding');

select pg_temp.as_user('cleo');
select is((select count(*)::int from api_external.quote_versions), 2, 'the client sees both sent versions');
select is((select total_minor from api_external.quote_versions where id = pg_temp.id('q1v1')), 25000::bigint,
  'with the client total (2 x 125.00)');
select is((select count(*)::int from api_external.quote_version_lines where quote_version_id = pg_temp.id('q1v1')), 1,
  'and only the lines on the quote, never the internal contingency');
select is((select unit_price_minor from api_external.quote_version_lines where quote_version_id = pg_temp.id('q1v1')), 12500::bigint,
  'at the client price');
select pg_temp.as_user('ivy');
select is_empty($$select 1 from api_external.quote_versions$$, 'another engagement''s caller sees nothing');
select is_empty($$select 1 from api_external.quote_version_lines$$, 'nor its lines');
select pg_temp.as_user('xavier');
select is_empty($$select 1 from api_external.quote_versions$$, 'cross tenant: nothing');

-- The token reader ---------------------------------------------------------------------------------------------------------
select pg_temp.as_anon();
select is((select reason from api_public.token_quote((select token from tok where key = 'a'), '000000x')), 'document_access_code',
  'a wrong code is refused');
select is((select (quote ->> 'total_minor')::bigint from api_public.token_quote((select token from tok where key = 'a'),
  (select access_code from tok where key = 'a'))), 25000::bigint, 'the right code returns the quote with its total');
select is((select jsonb_array_length(quote -> 'lines') from api_public.token_quote((select token from tok where key = 'a'),
  (select access_code from tok where key = 'a'))), 1, 'and its client lines');
select ok(not ((select quote from api_public.token_quote((select token from tok where key = 'a'),
  (select access_code from tok where key = 'a'))) ?| array['unit_cost_minor', 'margin_minor', 'markup_bp', 'urid', 'budget_id']),
  'the token reader carries no cost, margin, markup, URID or budget id');
select pg_temp.as_platform();
select is((select failed_attempts::int from app.engagement_document_tokens where id = (select token_id from tok where key = 'a')), 1,
  'the wrong code was counted toward the lock');

-- Token acceptance ---------------------------------------------------------------------------------------------------------
select pg_temp.as_anon();
select is((select refusal from api_public.token_sign_document((select token from tok where key = 'a'),
  (select access_code from tok where key = 'a'), 'Cleo M. Marsh')), null::text, 'the client signs through the link');
select pg_temp.as_platform();
select is((select quote_version_state::text from app.quote_versions where id = pg_temp.id('q1v1')), 'Accepted', 'the version is Accepted');
select is((select accepted_name from app.quote_versions where id = pg_temp.id('q1v1')), 'Cleo M. Marsh', 'with the typed name');
select is((select engagement_document_state::text from app.engagement_documents where id = pg_temp.id('doc1')), 'Executed',
  'the document moves Signed to Executed: no countersignature on a quote');
select is((select reason from app.engagement_document_state_transitions where engagement_document_id = pg_temp.id('doc1') and to_state = 'Executed'),
  'Accepted quote: no countersignature.', 'with its reason');
select ok((select reason like '%through a signing link.' from app.engagement_document_state_transitions
           where engagement_document_id = pg_temp.id('doc1') and to_state = 'Signed'),
  '0769 words a link signature with the fixed ending the acceptance trigger reads');
select pg_temp.as_user('cleo');
select is((select accepted_email from api_external.quote_versions where id = pg_temp.id('q1v1')), 'cleo@coral-group.test',
  'the view reads the email the link went to from the used token');
select ok(pg_temp.id('doc1') not in (select private.my_profile_engagement_document_ids()), 'an accepted quote is off the Compass Profile');
select pg_temp.as_user('carol');
select is((select accepted_email from app.quote_acceptance(pg_temp.id('q1v1'))), 'cleo@coral-group.test',
  'app.quote_acceptance gives a budget reader the same email');
select pg_temp.as_user('frank');
select throws_ok(format($$select * from app.quote_acceptance('%s')$$, pg_temp.id('q1v1')), '42501', null,
  'app.quote_acceptance needs finance.budget.read');
select pg_temp.as_platform();
select ok((select accepted_at is not null and accepted_by is null from app.quote_versions where id = pg_temp.id('q1v1')),
  'accepted_at is set; nobody was signed in');
select ok((select deleted_at is not null from app.quote_versions where id = pg_temp.id('q1v2')),
  'the live Draft of the accepted quote is deleted');
select is((select count(*)::int from app.notifications where kind = 'quote.accepted' and subject_id = pg_temp.id('q1v1')
           and recipient_person_id = pg_temp.id('carol')), 1, 'quote.accepted reaches the sender');
select is((select count(*)::int from app.domain_events where event_type = 'quote.accepted' and subject_id = pg_temp.id('q1v1')), 1,
  'and quote.accepted is emitted');

-- The acceptance lock ------------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
select throws_ok(format($$select app.create_quote_version('%s')$$, pg_temp.id('q1')), 'XR001',
  'quote_accepted_locked: This quote was accepted, so it can''t change. Record changes as a change order.', 'no new version once accepted');
select throws_ok(format($$select app.withdraw_quote_version('%s', 'No.')$$, pg_temp.id('q1v1')), 'XR001', null, 'no withdraw');
select throws_ok(format($$select app.decline_quote_version('%s', 'No.')$$, pg_temp.id('q1v1')), 'XR001', null, 'no decline');
select throws_ok(format($$update app.quotes set title = 'Renamed' where id = '%s'$$, pg_temp.id('q1')), 'XR001', null,
  'no title change (quote_accepted_locked)');
select throws_ok(format($$update app.quote_versions set terms = 'New terms.' where id = '%s'$$, pg_temp.id('q1v1')), 'XR001', null,
  'no edit of the accepted version');
select is((select display_state from app.quote_statuses where quote_id = pg_temp.id('q1')), 'Accepted', 'the status is Accepted');

-- Signed-in acceptance ---------------------------------------------------------------------------------------------------
select pg_temp.as_user('cleo');
select is((app.bulk_update_my_engagement_documents(jsonb_build_array(jsonb_build_object('id', pg_temp.id('doc2'),
    'set', jsonb_build_object('engagement_document_state', 'Signed'))), false) ->> 'changed')::int,
  0, 'Gateway bulk signing skips a quote');
select pg_temp.as_platform();
select is((select engagement_document_state::text from app.engagement_documents where id = pg_temp.id('doc2')), 'Sent', 'it stays unsigned');
select pg_temp.as_user('cleo');
select lives_ok(format($$select app.sign_engagement_document('%s', 'Signed in Gateway.')$$, pg_temp.id('doc2')),
  'the client signs the second quote signed in');
select pg_temp.as_platform();
select is((select accepted_by from app.quote_versions where id = pg_temp.id('q2v1')), pg_temp.id('cleo'), 'accepted_by is that person');
select is((select accepted_name from app.quote_versions where id = pg_temp.id('q2v1')), 'Cleo Marsh', 'with their name');
select pg_temp.as_user('cleo');
select is((select accepted_email from api_external.quote_versions where id = pg_temp.id('q2v1')), null::text, 'and no email: signed in');
select pg_temp.as_platform();
select is((select count(*)::int from app.notifications where kind = 'quote.accepted' and subject_id = pg_temp.id('q2v1')
           and recipient_person_id = pg_temp.id('carol')), 1, 'quote.accepted reaches the sender once');
select is((select engagement_document_state::text from app.engagement_documents where id = pg_temp.id('doc2')), 'Executed', 'the document is Executed');
select is((select coalesce(sum(v.documents_in_flight), 0)::int from (select count(*) filter (where d.engagement_document_state in ('Sent', 'Signed')) as documents_in_flight
           from app.engagement_documents d where d.id in (pg_temp.id('doc1'), pg_temp.id('doc2'))) v), 0, 'accepted quotes are out of documents in flight');

-- A signature through a link from a browser with a session (C10): the typed name wins and the sender is told once.
select pg_temp.as_user('carol');
insert into world select 'q4', app.create_quote(pg_temp.id('bud'), 'Fourth stage', pg_temp.id('eng_client'));
insert into world select 'doc4', s.engagement_document_id
  from app.send_quote_version((select id from app.quote_versions where quote_id = pg_temp.id('q4')), 'Sent.') s;
insert into tok select 'd', t.token_id, t.token, t.access_code from app.issue_engagement_document_token(pg_temp.id('doc4'), 'other@coral-group.test') t;
select pg_temp.as_user('ivy');
select is((select refusal from api_public.token_sign_document((select token from tok where key = 'd'),
  (select access_code from tok where key = 'd'), 'Typed Person')), null::text, 'a signed-in browser signs through the link');
select pg_temp.as_platform();
select is((select accepted_name || '/' || coalesce(accepted_by::text, 'none') from app.quote_versions where quote_id = pg_temp.id('q4')),
  'Typed Person/none', 'accepted_name is the typed name and accepted_by is cleared');
select is((select count(*)::int from app.notifications n where n.kind = 'quote.accepted' and n.recipient_person_id = pg_temp.id('carol')
           and n.subject_id = (select id from app.quote_versions where quote_id = pg_temp.id('q4'))), 1, 'the sender is told once');

-- Expiry -----------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
insert into world select 'q3', app.create_quote(pg_temp.id('bud'), 'Third stage', pg_temp.id('eng_client'));
insert into world select 'doc3', s.engagement_document_id
  from app.send_quote_version((select id from app.quote_versions where quote_id = pg_temp.id('q3')), 'Sent.') s;
select pg_temp.as_platform();
alter table app.quote_versions disable trigger t40_guard_quote_version;
update app.quote_versions set valid_until = current_date - 400 where quote_id = pg_temp.id('q3');
alter table app.quote_versions enable trigger t40_guard_quote_version;
select pg_temp.as_user('carol');
select is((select display_state from app.quote_statuses where quote_id = pg_temp.id('q3')), 'Expired', 'a Sent quote past valid until shows Expired');
select pg_temp.as_user('cleo');
select throws_ok(format($$select app.sign_engagement_document('%s', 'Too late.')$$, pg_temp.id('doc3')), 'XR001',
  'quote_expired: This quote expired, so it can no longer be accepted. Ask for a new version.', 'an expired quote is refused');
select pg_temp.as_platform();
select is((select engagement_document_state::text from app.engagement_documents where id = pg_temp.id('doc3')), 'Sent',
  'and the refusal leaves the document unsigned');

-- A closed engagement refuses acceptance (C13).
select pg_temp.as_user('carol');
insert into world select 'q5', app.create_quote(pg_temp.id('bud'), 'Fifth stage', pg_temp.id('eng_client'));
insert into world select 'doc5', s.engagement_document_id
  from app.send_quote_version((select id from app.quote_versions where quote_id = pg_temp.id('q5')), 'Sent.') s;
select pg_temp.as_platform();
update app.engagements set deleted_at = now() where id = pg_temp.id('eng_client');
select throws_ok(format($$select private.transition_lifecycle('engagement_document', 'app.engagement_documents', 'engagement_document_state',
    'app.engagement_document_state_transitions', 'engagement_document_id', '%s', 'Sent', 'Signed', 'Signed.')$$, pg_temp.id('doc5')),
  'XR001', 'quote_client_engagement: This quote''s client engagement is closed, so it can no longer be accepted.',
  'a deleted engagement refuses acceptance');
update app.engagements set deleted_at = null where id = pg_temp.id('eng_client');

select * from finish();
rollback;

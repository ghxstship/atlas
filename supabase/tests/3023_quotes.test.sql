-- pgTAP: 3023, quotes and quote versions (B13, RRR-237, gap G-188 phase 1, ADR 0152). Every refusal code of the quote
-- RPCs and guards, the send (Quote budget version, fingerprint equal to a recomputation, Quote document Sent with expiry),
-- supersede (earlier document Canceled and its links revoked), the Quote document lock, the acceptance lock and Trash.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

select * from no_plan();

create temporary table tok (key text primary key, token_id uuid, token text, access_code text);
grant select, insert, update on tok to public;

-- Fixture: Coral Group as Northwind's Client on prj_a, a budget priced for a quote -------------------------------------
select pg_temp.new_user('cleo', 'cleo@coral-group.test', 'Cleo Marsh');
select pg_temp.as_user('cleo');
insert into world values ('acct_c', app.create_external_account('Coral Group', 'coral-group'));
select pg_temp.as_user('alice');
insert into world values ('cp_c_a', app.create_counterparty(pg_temp.id('org_a'), null, null, pg_temp.id('acct_c')));
with e as (insert into app.engagements (project_id, person_id, counterparty_id, role_type, start_date)
  values (pg_temp.id('prj_a'), pg_temp.id('cleo'), pg_temp.id('cp_c_a'), 'Client', '2027-06-01') returning id) insert into world select 'eng_client', id from e;
with b as (insert into app.budgets (project_id, name, currency_code, default_markup_bp) values (pg_temp.id('prj_a'), 'Quote Budget', 'USD', 2500) returning id)
  insert into world select 'bud', id from b;
with b as (insert into app.budgets (project_id, name, currency_code) values (pg_temp.id('prj_a2'), 'Winter Budget', 'USD') returning id)
  insert into world select 'bud_a2', id from b;
with x as (insert into app.budget_lines (budget_id, line_number, description, urid, quantity, unit_price_minor, xyz, xyz_basis)
  values (pg_temp.id('bud'), 1, 'Stage deck.', '5000.04.02', 2, 10000, 'X', 'Declared') returning id) insert into world select 'l1', id from x;
with x as (insert into app.budget_lines (budget_id, line_number, description, urid, quantity, unit_price_minor, xyz, xyz_basis)
  values (pg_temp.id('bud'), 2, 'Sound.', '5000.01.01', 1, null, 'X', 'Declared') returning id) insert into world select 'l2', id from x;
with x as (insert into app.budget_lines (budget_id, line_number, description, urid, quantity, unit_price_minor, excluded_from_quote, xyz, xyz_basis)
  values (pg_temp.id('bud'), 3, 'Contingency.', '5000.01.01', 1, 5000, true, 'X', 'Declared') returning id) insert into world select 'l3', id from x;
select pg_temp.as_platform();
select pg_temp.move_engagement('eng_client', 'Onboarding', 'Active');

-- Create -------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('gina');
select throws_ok(format($$select app.create_quote('%s', 'Viewer quote')$$, pg_temp.id('bud')), '42501', null,
  'a Viewer cannot create a quote');
select pg_temp.as_user('alice');
select throws_ok(format($$select app.create_quote('%s', 'Wrong project', '%s')$$, pg_temp.id('bud_a2'), pg_temp.id('eng_client')),
  'XR001', 'quote_budget_project: The client engagement is on the budget''s project.', 'the engagement is on the budget''s project');
select pg_temp.as_user('carol');
select throws_ok(format($$select app.create_quote('%s', 'Crew quote', '%s')$$, pg_temp.id('bud'), pg_temp.id('eng_ivy_a')),
  'XR001', 'quote_client_engagement: A quote goes to a Client engagement of the project.', 'a quote goes to a Client engagement');
insert into world select 'q', app.create_quote(pg_temp.id('bud'), 'Summer Series production', pg_temp.id('eng_client'), null, 'Half on signature.');
insert into world select 'qv1', (select id from app.quote_versions where quote_id = pg_temp.id('q'));
select is((select quote_key from app.quote_statuses where quote_id = pg_temp.id('q')),
  (select project_key from app.projects where id = pg_temp.id('prj_a')) || '-Q-' || (select quote_number from app.quotes where id = pg_temp.id('q')),
  'the key is <project>-Q-<n>');
select is((select quote_version_state::text || '/' || version_number from app.quote_versions where id = pg_temp.id('qv1')), 'Draft/1',
  'version 1 starts as a Draft');
select is((select valid_until from app.quote_versions where id = pg_temp.id('qv1')), private_today.d + 30,
  'valid until defaults to 30 days from today on the project''s calendar')
  from (select (now() at time zone (select time_zone from app.projects where id = pg_temp.id('prj_a')))::date as d) private_today;
select is((select display_state from app.quote_statuses where quote_id = pg_temp.id('q')), 'Draft', 'the status is Draft');
select is((select client_name from app.quote_statuses where quote_id = pg_temp.id('q')), 'Cleo Marsh', 'the client is the engagement''s person');
select throws_ok(format($$select app.create_quote_version('%s')$$, pg_temp.id('q')), 'XR001', null,
  'a second Draft is refused (quote_draft_exists)');
select throws_ok(format($$update app.quote_versions set content_sha256 = repeat('a', 64) where id = '%s'$$, pg_temp.id('qv1')), '42501', null,
  'frozen columns are not writable');

-- Send refusals ------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('dave');
select throws_ok(format($$select * from app.send_quote_version('%s', 'Sent.')$$, pg_temp.id('qv1')), '42501', null,
  'sending needs finance.budget.approve');
select pg_temp.as_user('carol');
select throws_ok(format($$select * from app.send_quote_version('%s', 'Sent.')$$, pg_temp.id('qv1')), 'XR001',
  'quote_unpriced_lines: Every line on the quote needs a client price: set a markup or a client unit price.',
  'an included line without a client price refuses quote_unpriced_lines');
update app.budget_lines set client_unit_price_minor = 30000 where id = pg_temp.id('l2');
update app.quote_versions set valid_until = current_date - 400 where id = pg_temp.id('qv1');
select throws_ok(format($$select * from app.send_quote_version('%s', 'Sent.')$$, pg_temp.id('qv1')), 'XR001',
  'quote_valid_until: Valid until is in the past; choose a later day.', 'a past valid until refuses quote_valid_until');
update app.quote_versions set valid_until = current_date + 60 where id = pg_temp.id('qv1');
update app.quotes set engagement_id = null where id = pg_temp.id('q');
select throws_ok(format($$select * from app.send_quote_version('%s', 'Sent.')$$, pg_temp.id('qv1')), 'XR001',
  'quote_client_engagement: Choose an open Client engagement of the project to send the quote to.',
  'no client engagement refuses quote_client_engagement');
update app.quotes set engagement_id = pg_temp.id('eng_client') where id = pg_temp.id('q');
update app.budget_lines set excluded_from_quote = true where id in (pg_temp.id('l1'), pg_temp.id('l2'));
select throws_ok(format($$select * from app.send_quote_version('%s', 'Sent.')$$, pg_temp.id('qv1')), 'XR001',
  'quote_no_lines: The budget has no line on the quote.', 'no included line refuses quote_no_lines');
update app.budget_lines set excluded_from_quote = false where id in (pg_temp.id('l1'), pg_temp.id('l2'));

-- Send -----------------------------------------------------------------------------------------------------------------------
insert into world select 'doc1', s.engagement_document_id from app.send_quote_version(pg_temp.id('qv1'), 'Sent to Coral.') s;
select is((select quote_version_state::text from app.quote_versions where id = pg_temp.id('qv1')), 'Sent', 'the version is Sent');
select is((select v.purpose::text from app.budget_versions v join app.quote_versions q on q.budget_version_id = v.id
           where q.id = pg_temp.id('qv1')), 'Quote', 'it points at a Quote budget version');
select is((select count(*)::int from app.budget_version_lines l join app.quote_versions q on q.budget_version_id = l.budget_version_id
           where q.id = pg_temp.id('qv1') and not l.excluded_from_quote), 2, 'whose lines on the quote are frozen');
select is((select engagement_document_state::text || '/' || document_kind::text from app.engagement_documents where id = pg_temp.id('doc1')),
  'Sent/Quote', 'a Quote engagement document is Sent');
select is((select d.expires_on from app.engagement_documents d where d.id = pg_temp.id('doc1')),
  (select valid_until from app.quote_versions where id = pg_temp.id('qv1')), 'and expires on valid until');
select is((select sent_by from app.quote_versions where id = pg_temp.id('qv1')), pg_temp.id('carol'), 'the sender comes from the session');
select pg_temp.as_platform();
select is((select content_sha256 from app.quote_versions where id = pg_temp.id('qv1')),
  encode(extensions.digest(private.quote_canonical_content(pg_temp.id('qv1'),
    (select budget_version_id from app.quote_versions where id = pg_temp.id('qv1'))), 'sha256'), 'hex'),
  'the fingerprint equals a recomputation over the frozen capture');
select ok((select private.quote_canonical_content(pg_temp.id('qv1'), budget_version_id)::jsonb
           from app.quote_versions where id = pg_temp.id('qv1')) @> '{"client": "Cleo Marsh", "total_minor": 55000}'::jsonb,
  'the canonical content names the client and the total of the lines on the quote (2 x 125.00 + 300.00)');
select pg_temp.as_user('carol');
update app.budget_lines set unit_price_minor = 99999 where id = pg_temp.id('l1');
select is((select client_total_minor from app.quote_statuses where quote_id = pg_temp.id('q')), 55000::bigint,
  'a sent quote''s total comes from its capture, not the live budget');
select throws_ok(format($$update app.quote_versions set terms = 'Changed.' where id = '%s'$$, pg_temp.id('qv1')), 'XR001', null,
  'a sent version''s terms are fixed (quote_not_draft)');
select throws_ok(format($$update app.quote_versions set deleted_at = now() where id = '%s'$$, pg_temp.id('qv1')), 'XR001', null,
  'a sent version is never deleted');
select throws_ok(format($$update app.quotes set deleted_at = now() where id = '%s'$$, pg_temp.id('q')), 'XR001', null,
  'a sent quote is never deleted (quote_sent_permanent)');
select throws_ok(format($$update app.quotes set engagement_id = null where id = '%s'$$, pg_temp.id('q')), 'XR001', null,
  'the client is fixed once sent (quote_sent_parties)');

-- The Quote document is locked ------------------------------------------------------------------------------------------------
select throws_ok(format($$insert into app.engagement_documents (engagement_id, document_kind, title) values ('%s', 'Quote', 'By hand')$$,
  pg_temp.id('eng_client')), 'XR001', 'quote_kind_send_only: A Quote document is created by sending a quote version.',
  'a Quote document is never created by hand');
with d as (insert into app.engagement_documents (engagement_id, document_kind, title) values (pg_temp.id('eng_client'), 'Rider', 'Client rider') returning id)
  insert into world select 'rider', id from d;
select pg_temp.as_platform();
select throws_ok(format($$update app.engagement_documents set document_kind = 'Quote' where id = '%s'$$, pg_temp.id('rider')), 'XR001', null,
  'no document becomes a Quote');
select pg_temp.as_user('carol');
select throws_ok(format($$select app.transition_engagement_document('%s', 'Sent', 'Canceled', 'Canceled by hand.')$$, pg_temp.id('doc1')),
  'XR001', 'quote_document_locked: A Quote document follows its quote; change the quote instead.', 'a Quote document is not canceled by hand');
select throws_ok(format($$select app.transition_engagement_document('%s', 'Sent', 'Proposed', 'Back.')$$, pg_temp.id('doc1')),
  'XR001', null, 'nor returned to Proposed');
select throws_ok(format($$update app.engagement_documents set title = 'Renamed' where id = '%s'$$, pg_temp.id('doc1')),
  'XR001', null, 'nor renamed');
select throws_ok(format($$update app.engagement_documents set deleted_at = now() where id = '%s'$$, pg_temp.id('doc1')),
  'XR001', null, 'nor deleted');

-- Supersede ------------------------------------------------------------------------------------------------------------------
insert into tok select 'v1', t.token_id, t.token, t.access_code from app.issue_engagement_document_token(pg_temp.id('doc1'), 'cleo@coral-group.test') t;
insert into world select 'qv2', app.create_quote_version(pg_temp.id('q'));
select is((select terms from app.quote_versions where id = pg_temp.id('qv2')), 'Half on signature.', 'a new version copies the terms');
update app.budget_lines set unit_price_minor = 10000 where id = pg_temp.id('l1');
insert into world select 'doc2', s.engagement_document_id from app.send_quote_version(pg_temp.id('qv2'), 'Revised.') s;
select is((select quote_version_state::text from app.quote_versions where id = pg_temp.id('qv1')), 'Superseded',
  'sending version 2 supersedes version 1');
select is((select engagement_document_state::text from app.engagement_documents where id = pg_temp.id('doc1')), 'Canceled',
  'its document is canceled');
select pg_temp.as_platform();
select ok((select revoked_at is not null from app.engagement_document_tokens where id = (select token_id from tok where key = 'v1')),
  'and its signing link revoked');
select pg_temp.as_user('carol');
select is((select current_version_number from app.quote_statuses where quote_id = pg_temp.id('q')), 2, 'the status follows version 2');

-- Withdraw and decline -----------------------------------------------------------------------------------------------------
select throws_ok(format($$select app.withdraw_quote_version('%s', 'Gone.')$$, pg_temp.id('qv1')), 'XR001', null,
  'only a Sent version is withdrawn (quote_not_sent)');
insert into world select 'qv3', app.create_quote_version(pg_temp.id('q'));
select lives_ok(format($$update app.quote_versions set deleted_at = now() where id = '%s'$$, pg_temp.id('qv3')),
  'a Draft can be deleted');
select is((select deleted_at is null from app.quotes where id = pg_temp.id('q')), true,
  'deleting a Draft of a quote that was sent keeps the quote');

-- A quote never sent goes to Trash with its only Draft ---------------------------------------------------------------------
insert into world select 'q_draft', app.create_quote(pg_temp.id('bud'), 'Option B', pg_temp.id('eng_client'));
update app.quote_versions set deleted_at = now() where quote_id = pg_temp.id('q_draft');
select pg_temp.as_platform();
select ok((select deleted_at is not null from app.quotes where id = pg_temp.id('q_draft')),
  'deleting the only Draft of a quote never sent deletes the quote');
select ok(exists (select 1 from private.trash_tables where table_name = 'quotes' and title_column = 'title'), 'quotes are in Trash');
select ok(not exists (select 1 from private.trash_tables where table_name = 'quote_versions'), 'quote versions are not');
select pg_temp.as_user('carol');
update app.quotes set deleted_at = null where id = pg_temp.id('q_draft');
select is((select count(*)::int from app.quote_versions where quote_id = pg_temp.id('q_draft') and deleted_at is null), 1,
  'restoring the quote restores its Draft');

-- Withdraw, then the acceptance lock is in 3024 -----------------------------------------------------------------------------
select lives_ok(format($$select app.withdraw_quote_version('%s', 'Scope changed.')$$, pg_temp.id('qv2')), 'a Sent version is withdrawn');
select is((select engagement_document_state::text from app.engagement_documents where id = pg_temp.id('doc2')), 'Canceled',
  'withdrawing cancels its document');
select is((select display_state from app.quote_statuses where quote_id = pg_temp.id('q')), 'Withdrawn', 'the status is Withdrawn');

-- RLS ------------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('frank');
select is_empty($$select 1 from app.quotes$$, 'no quotes without finance.budget.read');
select is_empty($$select 1 from app.quote_statuses$$, 'nor statuses');
select pg_temp.as_user('xavier');
select is_empty($$select 1 from app.quote_versions$$, 'cross tenant: none');
select pg_temp.as_user('cleo');
select is_empty($$select 1 from app.quotes$$, 'the client never reads the org''s quotes table');
select pg_temp.as_platform();
select ok(not exists (select 1 from pg_roles where rolname = 'xos_backup')
  or not has_table_privilege('xos_backup', 'app.quote_statuses', 'select'), 'the backup login has no SELECT on quote statuses');

select * from finish();
rollback;

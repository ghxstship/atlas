-- pgTAP: migration 1326, the Numbering and General settings the database applies (A76, RRR-121, A65-001). A new
-- receivable invoice without a number takes org.invoice_number_prefix and the next invoice number padded to
-- numbering.document_number_padding; numbered and payable invoices keep theirs. Training certificates take the same
-- padding. A new membership joins org.default_workspace when it names a live workspace of the org.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(11);

select pg_temp.as_user('alice');
insert into world values ('cp_client', app.create_counterparty(pg_temp.id('org_a'), 'Lakeshore Brands', null));
insert into world values ('cp_vendor', app.create_counterparty(pg_temp.id('org_a'), 'Pier Rigging Co', 'Rigging Engineering'));
select pg_temp.as_platform();

-- Invoice numbers ------------------------------------------------------------------------------------------------
with x as (insert into app.invoices (project_id, direction, counterparty_id, currency_code) values (pg_temp.id('prj_a'), 'Receivable', pg_temp.id('cp_client'), 'USD') returning id)
insert into world select 'inv1', id from x;
select is((select invoice_number from app.invoices where id = pg_temp.id('inv1')), 'INV-0001', 'a receivable invoice without a number gets INV- and four digits by default');

select pg_temp.as_user('alice');
select app.set_setting(pg_temp.id('org_a'), 'org.invoice_number_prefix', 'Organization', pg_temp.id('org_a'), p_value_text => 'NWL-');
select app.set_setting(pg_temp.id('org_a'), 'numbering.document_number_padding', 'Organization', pg_temp.id('org_a'), p_value_integer => 6);
select pg_temp.as_platform();
with x as (insert into app.invoices (project_id, direction, counterparty_id, currency_code) values (pg_temp.id('prj_a'), 'Receivable', pg_temp.id('cp_client'), 'USD') returning id)
insert into world select 'inv2', id from x;
select is((select invoice_number from app.invoices where id = pg_temp.id('inv2')), 'NWL-000002', 'the org''s prefix and padding number the next one');

with x as (insert into app.invoices (project_id, direction, counterparty_id, invoice_number, currency_code) values (pg_temp.id('prj_a'), 'Receivable', pg_temp.id('cp_client'), 'SPECIAL-7', 'USD') returning id)
insert into world select 'inv3', id from x;
select is((select invoice_number from app.invoices where id = pg_temp.id('inv3')), 'SPECIAL-7', 'an invoice that carries its own number keeps it');
with x as (insert into app.invoices (project_id, direction, counterparty_id, currency_code) values (pg_temp.id('prj_a'), 'Payable', pg_temp.id('cp_vendor'), 'USD') returning id)
insert into world select 'inv4', id from x;
select is((select invoice_number from app.invoices where id = pg_temp.id('inv4')), null, 'a payable invoice keeps the vendor''s number, here none');

select pg_temp.as_user('xavier');
select pg_temp.as_platform();
select is(private.document_number(pg_temp.id('org_b'), 'INV-', 'invoice'), 'INV-0001', 'another org keeps its own sequence and padding');

-- Document padding ------------------------------------------------------------------------------------------------------
select is(private.document_number(pg_temp.id('org_a'), 'TRN-', 'training_certificate'), 'TRN-000001', 'certificates use the org''s padding');
select pg_temp.as_user('alice');
select app.set_setting(pg_temp.id('org_a'), 'numbering.document_number_padding', 'Organization', pg_temp.id('org_a'), p_value_integer => 1);
select pg_temp.as_platform();
select is(private.document_number(pg_temp.id('org_a'), 'TRN-', 'training_certificate'), 'TRN-2', 'a padding of 1 keeps the number as it is');
select ok(position('private.document_number' in pg_get_functiondef('app.complete_training(uuid, jsonb)'::regprocedure)) > 0,
  'a passed course numbers its certificate through the org''s padding');

-- Default workspace ------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('alice');
select app.set_setting(pg_temp.id('org_a'), 'org.default_workspace', 'Organization', pg_temp.id('org_a'), p_value_text => pg_temp.id('ws_a')::text);
select pg_temp.join_org('bob', 'org_a', 'nina', 'member');
select ok(exists (select 1 from app.workspace_members wm where wm.workspace_id = pg_temp.id('ws_a') and wm.membership_id = pg_temp.id('nina@org_a') and wm.deleted_at is null),
  'a new member starts in the org''s default workspace');
select is((select count(*)::int from app.workspace_members wm where wm.membership_id = pg_temp.id('nina@org_a')), 1, 'and only there');

select pg_temp.as_user('xavier');
select app.set_setting(pg_temp.id('org_b'), 'org.default_workspace', 'Organization', pg_temp.id('org_b'), p_value_text => pg_temp.id('ws_a')::text);
select pg_temp.join_org('xavier', 'org_b', 'nina', 'viewer');
select is((select count(*)::int from app.workspace_members wm where wm.membership_id = pg_temp.id('nina@org_b')), 0,
  'a default workspace of another org is ignored');

select * from finish();
rollback;

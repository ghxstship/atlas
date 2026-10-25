-- pgTAP: migration 2010, vendor bank account and routing numbers encrypted at rest (A100, RRR-145, S9-12). The table
-- holds only ciphertext under the Vault key xos_vendor_bank_account_key; holders of data.restricted.read.banking read
-- the numbers through app.vendor_bank_accounts_masked and everyone else sees the mask; app.set_vendor_bank_account is
-- the only writer and refuses callers without vendors.bank_details.write; the last four is derived and still checked.
-- private.encrypt_column_in_place, which encrypted the rows that existed when the migration ran, is proven on a probe
-- table: every value survives, NULL stays NULL, and no trigger sees an edit.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(43);

-- Key and shape --------------------------------------------------------------------------------------------------------
select is((select count(*)::integer from vault.secrets where name = 'xos_vendor_bank_account_key'), 1,
  'the migration created the Vault key xos_vendor_bank_account_key');
select ok(not has_function_privilege('authenticated', 'private.vendor_bank_account_key()', 'execute'),
  'signed-in callers cannot read the key');
select results_eq($$select a.attname::text collate "default", format_type(a.atttypid, a.atttypmod), a.attnotnull from pg_attribute a
  where a.attrelid = 'app.vendor_bank_accounts'::regclass and a.attname in ('account_number', 'routing_number') order by a.attname$$,
  $$values ('account_number'::text, 'bytea'::text, true), ('routing_number', 'bytea', false)$$,
  'both numbers are bytea ciphertext; the account number stays required');
select ok(not has_column_privilege('authenticated', 'app.vendor_bank_accounts', 'account_number', 'SELECT')
  and not has_column_privilege('authenticated', 'app.vendor_bank_accounts', 'routing_number', 'SELECT'),
  'signed-in callers cannot select the ciphertext');
select ok(not has_table_privilege('authenticated', 'app.vendor_bank_accounts', 'INSERT')
  and not has_column_privilege('authenticated', 'app.vendor_bank_accounts', 'account_number', 'UPDATE')
  and not has_column_privilege('authenticated', 'app.vendor_bank_accounts', 'account_last4', 'UPDATE'),
  'nor insert rows or write the numbers and the last four');
select is((select count(*)::integer from app.column_classifications
           where table_name = 'app.vendor_bank_accounts' and classification = 'Restricted' and read_capability = 'data.restricted.read.banking'), 2,
  'both numbers stay classified Restricted under data.restricted.read.banking');
select ok(col_description('app.vendor_bank_accounts'::regclass, (select attnum from pg_attribute
  where attrelid = 'app.vendor_bank_accounts'::regclass and attname = 'account_number')) like '%xos_vendor_bank_account_key%',
  'the column comment names the key and the RPC');

-- World ----------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('alice');
insert into world values ('cp_v', app.create_counterparty(pg_temp.id('org_a'), 'Harborline Staging', 'Equipment Rental'));
insert into world values ('cp_v2', app.create_counterparty(pg_temp.id('org_a'), 'Quayside Audio', 'Audio Supply'));
insert into world values ('cp_x', app.create_counterparty(pg_temp.id('org_a'), 'Coral Rigging', 'Equipment Rental'));
select pg_temp.as_user('carol');
with x as (insert into app.vendors (counterparty_id) values (pg_temp.id('cp_v')) returning id) insert into world select 'ven', id from x;
with x as (insert into app.vendors (counterparty_id) values (pg_temp.id('cp_v2')) returning id) insert into world select 'ven2', id from x;
select pg_temp.as_user('alice');
with x as (insert into app.vendors (counterparty_id) values (pg_temp.id('cp_x')) returning id) insert into world select 'ven_x', id from x;

-- The write RPC --------------------------------------------------------------------------------------------------------
select pg_temp.as_user('dave');
select throws_ok($$select app.set_vendor_bank_account((select id from world where key = 'ven'), 'Gulf Coast Bank', 'Harborline Staging', '000123456789')$$,
  '42501', 'vendors.bank_details.write is required', 'a Member without vendors.bank_details.write cannot record bank details');
select pg_temp.as_anon();
select throws_ok($$select app.set_vendor_bank_account('00000000-0000-0000-0000-000000000000', 'B', 'H', '12345678')$$,
  '42501', null, 'anon cannot call the RPC');
select pg_temp.as_user('carol');
insert into world values ('bank', app.set_vendor_bank_account(pg_temp.id('ven'), ' Gulf Coast Bank ', 'Harborline Staging', '0001-2345-6789', '063 100 277'));
select isnt(pg_temp.id('bank'), null, 'a Manager with vendors.bank_details.write records bank details');
select throws_ok($$select app.set_vendor_bank_account((select id from world where key = 'ven'), 'B', 'H', '12-3')$$,
  'XR001', 'bank_account_number_format: An account number has 4 to 34 letters and digits.', 'an account number needs four letters or digits');
select throws_ok($$select app.set_vendor_bank_account((select id from world where key = 'ven'), 'B', 'H', repeat('1', 35))$$,
  'XR001', 'bank_account_number_format: An account number has 4 to 34 letters and digits.', 'and at most 34');
select throws_ok($$select app.set_vendor_bank_account((select id from world where key = 'ven'), 'B', 'H', '12345678', repeat('9', 35))$$,
  'XR001', 'bank_routing_number_format: A routing number has at most 34 letters and digits.', 'a routing number has at most 34');
select throws_ok($$select app.set_vendor_bank_account((select id from world where key = 'ven'), 'B', ' ', '12345678')$$,
  'XR001', null, 'a bank account names its holder');
select throws_ok($$insert into app.vendor_bank_accounts (vendor_id, bank_name, account_holder, account_last4) values ((select id from world where key = 'ven'), 'B', 'H', '1111')$$,
  '42501', null, 'a row is never inserted directly');
select throws_ok($$update app.vendor_bank_accounts set account_last4 = '0000' where id = (select id from world where key = 'bank')$$,
  '42501', null, 'nor its last four written directly');
select lives_ok($$update app.vendor_bank_accounts set account_holder = 'Harborline Staging LLC' where id = (select id from world where key = 'bank')$$,
  'the bank name and holder stay editable directly');

-- No readable plain text at rest ----------------------------------------------------------------------------------------
select pg_temp.as_platform();
select is((select bank_name || ' / ' || account_last4 from app.vendor_bank_accounts where id = pg_temp.id('bank')), 'Gulf Coast Bank / 6789',
  'the RPC trims the bank name and derives the last four from the account number');
select ok((select position(convert_to('000123456789', 'UTF8') in account_number) = 0
             and position(convert_to('0001-2345-6789', 'UTF8') in account_number) = 0
             and position(convert_to('063100277', 'UTF8') in routing_number) = 0
           from app.vendor_bank_accounts where id = pg_temp.id('bank')),
  'neither number appears in the stored bytes');
select is((select extensions.pgp_sym_decrypt(account_number, private.vendor_bank_account_key()) || ' ' ||
                  extensions.pgp_sym_decrypt(routing_number, private.vendor_bank_account_key())
           from app.vendor_bank_accounts where id = pg_temp.id('bank')), '000123456789 063100277',
  'the ciphertext decrypts under the Vault key to the numbers'' letters and digits');
select throws_ok($$select extensions.pgp_sym_decrypt(account_number, 'not the key') from app.vendor_bank_accounts where id = (select id from world where key = 'bank')$$,
  '39000', null, 'and under no other key');
select is((select changed_by from app.vendor_bank_detail_changes where vendor_bank_account_id = pg_temp.id('bank') order by created_at limit 1),
  pg_temp.id('carol'), 'the RPC''s editor is logged for sod_vendor_payment');
select is((select count(*)::integer from app.audit_events a
           where a.subject_table = 'app.vendor_bank_accounts' and a.subject_id = pg_temp.id('bank') and a.action = 'vendor_bank_accounts.insert'
             and not (a.diff -> 'new' ?| array['account_number', 'routing_number'])), 1,
  'the insert is audited, and the audit diff never carries the numbers');
select throws_ok($$update app.vendor_bank_accounts set account_last4 = '0000' where id = (select id from world where key = 'bank')$$,
  'XR001', 'bank_account_rpc_only: Bank account numbers are written only through app.set_vendor_bank_account, which encrypts them.',
  'outside the RPC even the table owner cannot change the last four');
select private.begin_trusted_operation('vendor_bank_account_write');
select throws_ok($$update app.vendor_bank_accounts set account_last4 = '67' where id = (select id from world where key = 'bank')$$,
  '23514', null, 'the last four is still checked: four upper-case letters or digits');
select private.end_trusted_operation('vendor_bank_account_write');

-- Reading through the masked view --------------------------------------------------------------------------------------
select pg_temp.as_user('alice');
select results_eq($$select account_number, routing_number, account_last4, is_masked from app.vendor_bank_accounts_masked
  where id = (select id from world where key = 'bank')$$,
  $$values ('000123456789'::text, '063100277'::text, '6789'::text, false)$$,
  'the holder of data.restricted.read.banking reads both numbers decrypted');
select pg_temp.as_user('dave');
select results_eq($$select account_number, routing_number, account_last4, is_masked from app.vendor_bank_accounts_masked
  where id = (select id from world where key = 'bank')$$,
  $$values (null::text, null::text, '6789'::text, true)$$,
  'a vendor reader without it sees the mask and the last four');
select throws_ok($$select private.vendor_bank_number_plaintext((select org_id from app.vendor_bank_accounts_masked limit 1), '\x00'::bytea)$$,
  '42501', null, 'signed-in callers cannot reach the decrypting helper directly');
select pg_temp.as_user('gina');
select is((select count(*)::integer from app.vendor_bank_accounts_masked), 0, 'a Viewer without vendors.vendor.read sees no bank rows');
select pg_temp.as_user('xavier');
select is((select count(*)::integer from app.vendor_bank_accounts_masked), 0, 'another org sees none');

-- Replacing an account's details ----------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
select is(app.set_vendor_bank_account(pg_temp.id('ven'), 'Gulf Coast Bank', 'Harborline Staging LLC', 'GB29 NWBK 6016 1331 9268 19', null, pg_temp.id('bank')),
  pg_temp.id('bank'), 'the RPC replaces an account''s numbers in place');
select throws_ok(format($$select app.set_vendor_bank_account(%L, 'B', 'H', '12345678', null, %L)$$, pg_temp.id('ven2'), pg_temp.id('bank')),
  'XR001', 'bank_account_vendor_immutable: A bank account stays with its vendor.', 'a bank account never moves to another vendor');
select pg_temp.as_user('alice');
select results_eq($$select account_number, routing_number, account_last4 from app.vendor_bank_accounts_masked where id = (select id from world where key = 'bank')$$,
  $$values ('GB29NWBK60161331926819'::text, null::text, '6819'::text)$$, 'the new number reads back with its last four, the routing number cleared');
select lives_ok(format($$select app.set_vendor_bank_account(%L, 'Reef Bank', 'Coral Rigging', '44443333')$$, pg_temp.id('ven_x')),
  'the Owner records bank details too');

-- Encrypting existing rows in place (the migration's procedure) ----------------------------------------------------------
select pg_temp.as_platform();
select ok(not has_function_privilege('authenticated', 'private.encrypt_column_in_place(regclass, text, text)', 'execute'),
  'signed-in callers cannot run the in-place encryption');
create table app.a100_probe (id integer primary key, secret text not null, extra text, note text, spare text,
  touched_at timestamptz not null default '2026-01-01');
insert into app.a100_probe (id, secret, extra, note) values
  (1, '0001-2345-6789', '063100277', 'hyphenated'), (2, 'GB29 NWBK 6016 1331 9268 19', null, 'spaced'), (3, '', null, 'empty');
create function private.a100_probe_touch() returns trigger language plpgsql set search_path = '' as $$
begin
  new.touched_at := now();
  return new;
end;
$$;
create trigger t50_touch before update on app.a100_probe for each row execute function private.a100_probe_touch();
call private.encrypt_column_in_place('app.a100_probe', 'secret', 'xos_vendor_bank_account_key');
call private.encrypt_column_in_place('app.a100_probe', 'extra', 'xos_vendor_bank_account_key');
select results_eq($$select a.attname::text collate "default", format_type(a.atttypid, a.atttypmod), a.attnotnull from pg_attribute a
  where a.attrelid = 'app.a100_probe'::regclass and a.attname in ('secret', 'extra') and not a.attisdropped order by a.attname$$,
  $$values ('extra'::text, 'bytea'::text, false), ('secret', 'bytea', true)$$, 'the columns keep their names and NOT NULL as bytea');
select results_eq($$select id, extensions.pgp_sym_decrypt(secret, private.vendor_bank_account_key()),
    extensions.pgp_sym_decrypt(extra, private.vendor_bank_account_key()) from app.a100_probe order by id$$,
  $$values (1, '0001-2345-6789'::text, '063100277'::text), (2, 'GB29 NWBK 6016 1331 9268 19', null), (3, '', null)$$,
  'every existing value survives exactly as stored, NULL stays NULL');
select is((select count(*)::integer from app.a100_probe where touched_at <> '2026-01-01'), 0, 'no trigger saw the rewrite as an edit');
select is((select tgenabled::text from pg_trigger where tgrelid = 'app.a100_probe'::regclass and tgname = 't50_touch'), 'O',
  'and the table''s triggers are on again');
alter table app.a100_probe add constraint a100_probe_note check (char_length(note) < 50);
select throws_ok($$call private.encrypt_column_in_place('app.a100_probe', 'note', 'xos_vendor_bank_account_key')$$,
  'XR001', 'encrypt_column_dependents: Drop what depends on app.a100_probe.note before encrypting it.',
  'a column a constraint reads is refused, so no check is dropped silently');
select throws_ok($$call private.encrypt_column_in_place('app.a100_probe', 'secret', 'xos_vendor_bank_account_key')$$,
  'XR001', 'encrypt_column_type: app.a100_probe.secret is bytea; only a text column is encrypted in place.', 'a column already encrypted is refused');
select throws_ok($$call private.encrypt_column_in_place('app.a100_probe', 'spare', 'no_such_key')$$,
  'XR001', 'encrypt_key_missing: No Vault secret is named no_such_key.', 'and so is a missing key');
select throws_ok($$call private.encrypt_column_in_place('app.a100_probe', 'nothing', 'xos_vendor_bank_account_key')$$,
  'XR001', 'encrypt_column_missing: app.a100_probe has no column nothing.', 'and a missing column');

select * from finish();
rollback;

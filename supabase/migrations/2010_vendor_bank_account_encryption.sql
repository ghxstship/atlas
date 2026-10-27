-- 2010_vendor_bank_account_encryption.sql
-- A100 (RRR-145), trace row S9-12. Section 9 asks for field-level pgcrypto encryption of bank details, and Section 8.3
-- classifies a vendor's account and routing numbers as Restricted (data.restricted.read.banking). 0330 masked them in
-- app.vendor_bank_accounts_masked but stored them in plain text. They now follow the org tax identifier pattern of
-- 1200:
--   * both numbers are encrypted with pgp_sym_encrypt under their own Vault key, xos_vendor_bank_account_key, created
--     here like the keys decision 49 keeps (ADR 0033): generated in the project, never leaving Vault
--   * signed-in callers can neither select nor write the ciphertext. app.set_vendor_bank_account adds an account or
--     replaces one's details, with vendors.bank_details.write in the vendor's org; it keeps the numbers' letters and
--     digits, encrypts them and derives account_last4 from the account number, the check 0330's constraint made
--   * app.vendor_bank_accounts_masked decrypts the numbers only for holders of data.restricted.read.banking; everyone
--     else who reads vendors sees NULL with is_masked true and the last four, as before
--   * existing rows are encrypted in place by private.encrypt_column_in_place, which keeps each stored value as it was
--     and does not count as an edit: no bank detail change is logged, no audit event written, updated_at kept
--   * the column names, their classification rows and the view's shape stay, so exports, the AI never-send list and
--     the v1 API (which reads only account_last4 through the view) are unchanged

do $$
begin
  if not exists (select 1 from vault.secrets where name = 'xos_vendor_bank_account_key') then
    perform vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'xos_vendor_bank_account_key',
      'Symmetric key that encrypts vendor bank account and routing numbers on app.vendor_bank_accounts (Sections 8.3 and 9).');
  end if;
end $$;

create or replace function private.vendor_bank_account_key()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select s.decrypted_secret from vault.decrypted_secrets s where s.name = 'xos_vendor_bank_account_key';
$$;

comment on function private.vendor_bank_account_key() is 'The Vault key that encrypts vendor bank account and routing numbers. Never granted to signed-in callers.';
revoke all on function private.vendor_bank_account_key() from public, anon, authenticated;

-- Encrypting a plain-text column in place ------------------------------------------------------------------------------

create or replace procedure private.encrypt_column_in_place(p_table regclass, p_column text, p_key_name text)
language plpgsql
set search_path = ''
as $$
declare
  v_attnum smallint;
  v_type text;
  v_not_null boolean;
  v_key text := (select s.decrypted_secret from vault.decrypted_secrets s where s.name = p_key_name);
  v_staging text := p_column || '_ciphertext';
begin
  select a.attnum, pg_catalog.format_type(a.atttypid, a.atttypmod), a.attnotnull into v_attnum, v_type, v_not_null
  from pg_catalog.pg_attribute a
  where a.attrelid = p_table and a.attname = p_column and a.attnum > 0 and not a.attisdropped;
  if v_attnum is null then
    perform private.refuse('encrypt_column_missing', format('%s has no column %s.', p_table, p_column));
  end if;
  if v_type <> 'text' then
    perform private.refuse('encrypt_column_type', format('%s.%s is %s; only a text column is encrypted in place.', p_table, p_column, v_type));
  end if;
  if v_key is null then
    perform private.refuse('encrypt_key_missing', format('No Vault secret is named %s.', p_key_name));
  end if;
  if exists (select 1 from pg_catalog.pg_attribute a where a.attrelid = p_table and a.attname = v_staging and not a.attisdropped) then
    perform private.refuse('encrypt_column_staging', format('%s already has a column %s.', p_table, v_staging));
  end if;
  -- Dropping the column would silently drop a constraint, index, default or statistics object on it, and a view, policy
  -- or column trigger on it would make the drop fail; the caller drops or restates those deliberately first.
  if exists (select 1 from pg_catalog.pg_constraint c where c.conrelid = p_table and c.contype <> 'n' and v_attnum = any (c.conkey))
     or exists (select 1 from pg_catalog.pg_depend d
                where d.refclassid = 'pg_catalog.pg_class'::regclass and d.refobjid = p_table and d.refobjsubid = v_attnum
                  and d.classid <> 'pg_catalog.pg_constraint'::regclass) then
    perform private.refuse('encrypt_column_dependents', format('Drop what depends on %s.%s before encrypting it.', p_table, p_column));
  end if;

  execute format('alter table %s add column %I bytea', p_table, v_staging);
  -- Encrypting a stored value is not an edit: the table's own triggers (edit logs, audit trail, updated_at, guards) stay
  -- out of it.
  execute format('alter table %s disable trigger user', p_table);
  execute format('update %s set %I = extensions.pgp_sym_encrypt(%I, $1) where %I is not null', p_table, v_staging, p_column, p_column)
    using v_key;
  execute format('alter table %s enable trigger user', p_table);
  execute format('alter table %s drop column %I', p_table, p_column);
  execute format('alter table %s rename column %I to %I', p_table, v_staging, p_column);
  if v_not_null then
    execute format('alter table %s alter column %I set not null', p_table, p_column);
  end if;
end;
$$;

comment on procedure private.encrypt_column_in_place(regclass, text, text) is 'Replaces a text column with its pgp_sym_encrypt ciphertext under the named Vault key, keeping the column name, every stored value (NULL stays NULL) and NOT NULL. The table''s user triggers are off while rows are rewritten, so nothing logs an edit. Refuses a column that is not text, a missing key, and a column that a constraint, index, default, view, policy, trigger or statistics object depends on. The new bytea column carries no comment and no column privileges: the caller restates them.';
revoke all on procedure private.encrypt_column_in_place(regclass, text, text) from public, anon, authenticated;

-- The bank numbers ---------------------------------------------------------------------------------------------------

-- The masked view reads both columns and 0330's check reads the account number; both come back below.
drop view app.vendor_bank_accounts_masked;
alter table app.vendor_bank_accounts drop constraint vendor_bank_accounts_last4_matches;

call private.encrypt_column_in_place('app.vendor_bank_accounts', 'account_number', 'xos_vendor_bank_account_key');
call private.encrypt_column_in_place('app.vendor_bank_accounts', 'routing_number', 'xos_vendor_bank_account_key');

call private.describe('app.vendor_bank_accounts', 'Bank accounts a vendor is paid into. Account and routing numbers are Restricted and encrypted: written only through app.set_vendor_bank_account and read through app.vendor_bank_accounts_masked. Every editor is logged for sod_vendor_payment.', array[
  'account_last4', 'Last four letters or digits of the account number, shown to everyone who reads vendors. Derived by app.set_vendor_bank_account.',
  'account_number', 'Account number encrypted with pgp_sym_encrypt under the Vault key xos_vendor_bank_account_key. Restricted (data.restricted.read.banking): never selectable or writable by signed-in callers; written through app.set_vendor_bank_account and read through app.vendor_bank_accounts_masked.',
  'routing_number', 'Routing or sort code encrypted with pgp_sym_encrypt under the Vault key xos_vendor_bank_account_key; NULL when none is recorded. Restricted (data.restricted.read.banking), written and read like account_number.'
]);

-- Column grants: the ciphertext and the last four are written only by the RPC; the Restricted columns are never
-- selectable (0330 granted select on the other columns only).
revoke insert, update on app.vendor_bank_accounts from authenticated;
grant update (bank_name, account_holder, deleted_at) on app.vendor_bank_accounts to authenticated;

create or replace function private.guard_vendor_bank_account()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (tg_op = 'INSERT'
      or new.account_number is distinct from old.account_number
      or new.routing_number is distinct from old.routing_number
      or new.account_last4 is distinct from old.account_last4)
     and not private.in_trusted_operation('vendor_bank_account_write') then
    perform private.refuse('bank_account_rpc_only', 'Bank account numbers are written only through app.set_vendor_bank_account, which encrypts them.');
  end if;
  return new;
end;
$$;

comment on function private.guard_vendor_bank_account() is 'Vendor bank accounts: a row is added, and its account number, routing number and last four change, only inside app.set_vendor_bank_account, which encrypts the numbers and derives the last four.';
revoke all on function private.guard_vendor_bank_account() from public, anon, authenticated;

create trigger t40_guard_vendor_bank_account before insert or update on app.vendor_bank_accounts
  for each row execute function private.guard_vendor_bank_account();

create or replace function app.set_vendor_bank_account(
  p_vendor_id uuid,
  p_bank_name text,
  p_account_holder text,
  p_account_number text,
  p_routing_number text default null,
  p_vendor_bank_account_id uuid default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_vendor app.vendors;
  v_account app.vendor_bank_accounts;
  v_number text := upper(regexp_replace(coalesce(p_account_number, ''), '[^0-9A-Za-z]', '', 'g'));
  v_routing text := upper(regexp_replace(coalesce(p_routing_number, ''), '[^0-9A-Za-z]', '', 'g'));
  v_key text;
  v_id uuid;
begin
  perform private.require_person();
  select * into v_vendor from app.vendors v where v.id = p_vendor_id and v.deleted_at is null;
  if v_vendor.id is null or not private.has_capability(v_vendor.org_id, 'vendors.bank_details.write') then
    raise exception using errcode = '42501', message = 'vendors.bank_details.write is required';
  end if;
  if p_vendor_bank_account_id is not null then
    select * into v_account from app.vendor_bank_accounts b where b.id = p_vendor_bank_account_id and b.deleted_at is null;
    if v_account.id is null or v_account.vendor_id <> v_vendor.id then
      perform private.refuse('bank_account_vendor_immutable', 'A bank account stays with its vendor.');
    end if;
  end if;
  if char_length(btrim(coalesce(p_bank_name, ''))) not between 1 and 200
     or char_length(btrim(coalesce(p_account_holder, ''))) not between 1 and 200 then
    perform private.refuse('bank_account_details', 'A bank account names its bank and its holder, each in 1 to 200 characters.');
  end if;
  if char_length(v_number) not between 4 and 34 then
    perform private.refuse('bank_account_number_format', 'An account number has 4 to 34 letters and digits.');
  end if;
  if char_length(v_routing) > 34 then
    perform private.refuse('bank_routing_number_format', 'A routing number has at most 34 letters and digits.');
  end if;

  v_key := private.vendor_bank_account_key();
  perform private.begin_trusted_operation('vendor_bank_account_write');
  if v_account.id is null then
    insert into app.vendor_bank_accounts (vendor_id, bank_name, account_holder, account_number, account_last4, routing_number)
    values (v_vendor.id, btrim(p_bank_name), btrim(p_account_holder), extensions.pgp_sym_encrypt(v_number, v_key), right(v_number, 4),
      case when v_routing <> '' then extensions.pgp_sym_encrypt(v_routing, v_key) end)
    returning id into v_id;
  else
    update app.vendor_bank_accounts b set
      bank_name = btrim(p_bank_name),
      account_holder = btrim(p_account_holder),
      account_number = extensions.pgp_sym_encrypt(v_number, v_key),
      account_last4 = right(v_number, 4),
      routing_number = case when v_routing <> '' then extensions.pgp_sym_encrypt(v_routing, v_key) end
    where b.id = v_account.id
    returning b.id into v_id;
  end if;
  perform private.end_trusted_operation('vendor_bank_account_write');
  return v_id;
end;
$$;

comment on function app.set_vendor_bank_account(uuid, text, text, text, text, uuid) is 'Adds a bank account to a vendor, or with p_vendor_bank_account_id replaces one''s details: keeps the numbers'' letters and digits, encrypts them under the Vault key and derives the last four from the account number. A blank routing number is stored as none. Requires vendors.bank_details.write in the vendor''s org; the editor is logged for sod_vendor_payment and the audit diff never carries the numbers. Returns the account id.';
revoke all on function app.set_vendor_bank_account(uuid, text, text, text, text, uuid) from public, anon;
grant execute on function app.set_vendor_bank_account(uuid, text, text, text, text, uuid) to authenticated, service_role;

create or replace function private.vendor_bank_number_plaintext(p_org_id uuid, p_ciphertext bytea)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case when p_ciphertext is not null and private.has_capability(p_org_id, 'data.restricted.read.banking')
    then extensions.pgp_sym_decrypt(p_ciphertext, private.vendor_bank_account_key()) end;
$$;

comment on function private.vendor_bank_number_plaintext(uuid, bytea) is 'Decrypts a vendor bank account or routing number for a holder of data.restricted.read.banking in its org, else NULL. Takes column values and never re-reads the table; signed-in callers cannot select the ciphertext, so they reach it only through app.vendor_bank_accounts_masked.';
revoke all on function private.vendor_bank_number_plaintext(uuid, bytea) from public, anon;
grant execute on function private.vendor_bank_number_plaintext(uuid, bytea) to authenticated, service_role;

create view app.vendor_bank_accounts_masked as
select b.id, b.org_id, b.vendor_id, b.bank_name, b.account_holder, b.account_last4,
  private.vendor_bank_number_plaintext(b.org_id, b.account_number) as account_number,
  private.vendor_bank_number_plaintext(b.org_id, b.routing_number) as routing_number,
  not private.has_capability(b.org_id, 'data.restricted.read.banking') as is_masked
from app.vendor_bank_accounts b
where b.deleted_at is null
  and b.org_id in (select private.orgs_with_capability('vendors.vendor.read'));

call private.describe('app.vendor_bank_accounts_masked', 'Vendor bank accounts with the Restricted numbers decrypted for holders of data.restricted.read.banking and masked (NULL with is_masked true) for everyone else (Section 8.3). Rows are limited to orgs where the caller reads vendors.', array[
  'id', 'Bank account.',
  'org_id', 'Org.',
  'vendor_id', 'Vendor.',
  'bank_name', 'Bank name.',
  'account_holder', 'Name on the account.',
  'account_last4', 'Last four characters of the account number.',
  'account_number', 'Account number in plain text for holders of data.restricted.read.banking; NULL when masked.',
  'routing_number', 'Routing number in plain text for holders of data.restricted.read.banking; NULL when masked or not recorded.',
  'is_masked', 'True when the Restricted numbers are withheld from the caller.'
]);
revoke all on app.vendor_bank_accounts_masked from public, anon;
grant select on app.vendor_bank_accounts_masked to authenticated, service_role;
-- 1650's default privileges grant the backup login SELECT on every new relation, views included; pg_dump never reads
-- a view's rows, and this one decrypts Restricted numbers, so it takes the grant back (pgTAP 1650, test 8).
revoke select on app.vendor_bank_accounts_masked from xos_backup;

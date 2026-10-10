-- 0300_domain_machinery.sql
-- A03 Domain Data (ADR 0004 range 0300 to 0499). Machinery every domain table reuses, on top of
-- A02's platform machinery in 0200:
--   * private.currencies, the one currency reference table (Section 7.1: the exponent comes from it)
--   * private.describe, a table and column comment helper (Section 7.1: comment on everything)
--   * private.install_domain_table, which adds the ADR 0002 audit columns and attaches org_id
--     derivation, the no tenant move and cross-org guards, row level security and grants
--   * private.install_policies, which writes paired read and write policies from expressions
--   * private.lifecycle_transition_rules and private.transition_lifecycle, one compare-and-set
--     transition engine for every lifecycle with a *_state_transitions ledger (Section 3.12)
--   * private.key_sequences and private.next_sequence for display keys (Section 4.5.1)
--
-- Closed lists that are not tenant data live in private tables (no org_id) and are surfaced through
-- app views; tenant tables live in app. Every function pins search_path to '' (invariant 6).

-- Currencies --------------------------------------------------------------------------------------

create table private.currencies (
  currency_code char(3) primary key,
  minor_unit_exponent smallint not null,
  constraint currencies_code_format check (currency_code ~ '^[A-Z]{3}$'),
  constraint currencies_exponent_range check (minor_unit_exponent between 0 and 4)
);

comment on table private.currencies is 'ISO 4217 currencies and their minor unit exponent: the one reference every money column reads (Section 7.1). Money is stored as bigint minor units of the currency.';
comment on column private.currencies.currency_code is 'ISO 4217 alphabetic code.';
comment on column private.currencies.minor_unit_exponent is 'Number of decimal places of the minor unit: 2 for USD (cents), 0 for JPY, 3 for KWD.';

insert into private.currencies (currency_code, minor_unit_exponent) values
  ('AED', 2), ('AFN', 2), ('ALL', 2), ('AMD', 2), ('ANG', 2), ('AOA', 2), ('ARS', 2), ('AUD', 2), ('AWG', 2), ('AZN', 2),
  ('BAM', 2), ('BBD', 2), ('BDT', 2), ('BGN', 2), ('BHD', 3), ('BIF', 0), ('BMD', 2), ('BND', 2), ('BOB', 2), ('BRL', 2),
  ('BSD', 2), ('BTN', 2), ('BWP', 2), ('BYN', 2), ('BZD', 2), ('CAD', 2), ('CDF', 2), ('CHF', 2), ('CLF', 4), ('CLP', 0),
  ('CNY', 2), ('COP', 2), ('CRC', 2), ('CUP', 2), ('CVE', 2), ('CZK', 2), ('DJF', 0), ('DKK', 2), ('DOP', 2), ('DZD', 2),
  ('EGP', 2), ('ERN', 2), ('ETB', 2), ('EUR', 2), ('FJD', 2), ('FKP', 2), ('GBP', 2), ('GEL', 2), ('GHS', 2), ('GIP', 2),
  ('GMD', 2), ('GNF', 0), ('GTQ', 2), ('GYD', 2), ('HKD', 2), ('HNL', 2), ('HTG', 2), ('HUF', 2), ('IDR', 2), ('ILS', 2),
  ('INR', 2), ('IQD', 3), ('IRR', 2), ('ISK', 0), ('JMD', 2), ('JOD', 3), ('JPY', 0), ('KES', 2), ('KGS', 2), ('KHR', 2),
  ('KMF', 0), ('KPW', 2), ('KRW', 0), ('KWD', 3), ('KYD', 2), ('KZT', 2), ('LAK', 2), ('LBP', 2), ('LKR', 2), ('LRD', 2),
  ('LSL', 2), ('LYD', 3), ('MAD', 2), ('MDL', 2), ('MGA', 2), ('MKD', 2), ('MMK', 2), ('MNT', 2), ('MOP', 2), ('MRU', 2),
  ('MUR', 2), ('MVR', 2), ('MWK', 2), ('MXN', 2), ('MYR', 2), ('MZN', 2), ('NAD', 2), ('NGN', 2), ('NIO', 2), ('NOK', 2),
  ('NPR', 2), ('NZD', 2), ('OMR', 3), ('PAB', 2), ('PEN', 2), ('PGK', 2), ('PHP', 2), ('PKR', 2), ('PLN', 2), ('PYG', 0),
  ('QAR', 2), ('RON', 2), ('RSD', 2), ('RUB', 2), ('RWF', 0), ('SAR', 2), ('SBD', 2), ('SCR', 2), ('SDG', 2), ('SEK', 2),
  ('SGD', 2), ('SHP', 2), ('SLE', 2), ('SOS', 2), ('SRD', 2), ('SSP', 2), ('STN', 2), ('SVC', 2), ('SYP', 2), ('SZL', 2),
  ('THB', 2), ('TJS', 2), ('TMT', 2), ('TND', 3), ('TOP', 2), ('TRY', 2), ('TTD', 2), ('TWD', 2), ('TZS', 2), ('UAH', 2),
  ('UGX', 0), ('USD', 2), ('UYI', 0), ('UYU', 2), ('UYW', 4), ('UZS', 2), ('VES', 2), ('VND', 0), ('VUV', 0), ('WST', 2),
  ('XAF', 0), ('XCD', 2), ('XOF', 0), ('XPF', 0), ('YER', 2), ('ZAR', 2), ('ZMW', 2), ('ZWG', 2);

alter table private.currencies enable row level security;
revoke all on private.currencies from public, anon, authenticated;
grant select on private.currencies to service_role;

create view app.currencies as
select c.currency_code, c.minor_unit_exponent from private.currencies c;

comment on view app.currencies is 'ISO 4217 currencies with their minor unit exponent, for rendering money stored in minor units.';
comment on column app.currencies.currency_code is 'ISO 4217 alphabetic code.';
comment on column app.currencies.minor_unit_exponent is 'Decimal places of the minor unit.';

revoke all on app.currencies from public, anon;
grant select on app.currencies to authenticated, service_role;

-- Comment helper ------------------------------------------------------------------------------------

create or replace procedure private.describe(p_relation regclass, p_comment text, p_columns text[] default '{}')
language plpgsql
set search_path = ''
as $$
declare
  v_kind "char" := (select c.relkind from pg_catalog.pg_class c where c.oid = p_relation);
  i integer := 1;
begin
  if v_kind in ('v', 'm') then
    execute format('comment on %s %s is %L', case v_kind when 'v' then 'view' else 'materialized view' end,
      p_relation, p_comment);
  else
    execute format('comment on table %s is %L', p_relation, p_comment);
  end if;
  while i < coalesce(array_length(p_columns, 1), 0) loop
    execute format('comment on column %s.%I is %L', p_relation, p_columns[i], p_columns[i + 1]);
    i := i + 2;
  end loop;
end;
$$;

comment on procedure private.describe(regclass, text, text[]) is 'Comments a table or view and its columns. Columns come as pairs of column name and comment.';

-- Domain table installer -------------------------------------------------------------------------------
-- Adds the ADR 0002 audit columns and soft delete column, comments the standard columns, indexes
-- org_id, attaches A02's audit, org_id derivation, no tenant move and cross-org reference triggers,
-- turns on row level security and sets table privileges. Ledgers get the append-only trigger and no
-- write privilege: only definer RPCs write them.

create or replace procedure private.install_domain_table(
  p_table regclass,
  p_parent_table text default null,
  p_parent_column text default null,
  p_references text[] default '{}',
  p_ledger boolean default false
)
language plpgsql
set search_path = ''
as $$
declare
  v_name text := (select c.relname from pg_catalog.pg_class c where c.oid = p_table);
begin
  execute format('alter table %s add column if not exists created_at timestamptz not null default now()', p_table);
  execute format('alter table %s add column if not exists created_by uuid references app.people (id)', p_table);
  execute format('alter table %s add column if not exists updated_at timestamptz not null default now()', p_table);
  execute format('alter table %s add column if not exists updated_by uuid references app.people (id)', p_table);
  execute format('alter table %s add column if not exists deleted_at timestamptz', p_table);

  if col_description(p_table, (select a.attnum from pg_catalog.pg_attribute a where a.attrelid = p_table and a.attname = 'id')) is null then
    execute format('comment on column %s.id is %L', p_table, 'Primary key, UUID v7.');
  end if;
  if p_parent_table is not null then
    execute format('comment on column %s.org_id is %L', p_table,
      format('Owning org, derived from %s on insert; never accepted from the caller and never changed.', p_parent_table));
  elsif col_description(p_table, (select a.attnum from pg_catalog.pg_attribute a where a.attrelid = p_table and a.attname = 'org_id')) is null then
    execute format('comment on column %s.org_id is %L', p_table, 'Owning org. A row never moves to another org.');
  end if;

  execute format('create index if not exists %I on %s (org_id)', v_name || '_org_id_idx', p_table);
  call private.install_audit_columns(p_table);
  call private.install_tenant_guards(p_table, p_parent_table, p_parent_column, p_references);

  if p_ledger then
    execute format('drop trigger if exists t95_append_only on %s', p_table);
    execute format(
      'create trigger t95_append_only before update or delete on %s for each row execute function private.refuse_ledger_change()',
      p_table);
  end if;

  execute format('alter table %s enable row level security', p_table);
  execute format('revoke all on %s from public, anon, authenticated', p_table);
  execute format('grant select on %s to authenticated', p_table);
  execute format('grant all on %s to service_role', p_table);
end;
$$;

comment on procedure private.install_domain_table(regclass, text, text, text[], boolean) is 'Makes a table an ADR 0002 tenant table: audit and soft delete columns, org_id index, org_id derivation from the parent (when given), no tenant move, cross-org reference refusal (pairs of referenced table and column), row level security, privileges, and the append-only trigger for ledgers.';

-- Policy installer -------------------------------------------------------------------------------------
-- Writes the read policy and the write policies from SQL expressions and grants the matching table
-- privileges, so the read and write halves of a table are declared together and agree (invariant 5).
-- Hard deletes are never granted to authenticated: rows are soft deleted through deleted_at.

create or replace procedure private.install_policies(
  p_table regclass,
  p_read text,
  p_insert text default null,
  p_update text default null
)
language plpgsql
set search_path = ''
as $$
declare
  v_name text := (select c.relname from pg_catalog.pg_class c where c.oid = p_table);
  v_update text := coalesce(p_update, p_insert);
begin
  execute format('drop policy if exists %I on %s', v_name || '_read', p_table);
  execute format('create policy %I on %s for select to authenticated using (%s)', v_name || '_read', p_table, p_read);
  if p_insert is not null then
    execute format('drop policy if exists %I on %s', v_name || '_insert', p_table);
    execute format('create policy %I on %s for insert to authenticated with check (%s)', v_name || '_insert', p_table, p_insert);
    execute format('grant insert on %s to authenticated', p_table);
  end if;
  if v_update is not null then
    execute format('drop policy if exists %I on %s', v_name || '_update', p_table);
    execute format('create policy %I on %s for update to authenticated using (%s) with check (%s)',
      v_name || '_update', p_table, v_update, v_update);
    execute format('grant update on %s to authenticated', p_table);
  end if;
end;
$$;

comment on procedure private.install_policies(regclass, text, text, text) is 'Creates the read, insert and update policies of a table from SQL expressions and grants the matching privileges. The update policy uses one expression for both halves. No delete privilege is granted.';

-- Lifecycle transition rules -----------------------------------------------------------------------------
-- One table holds the allowed transitions of every lifecycle state machine, keyed by lifecycle name.
-- States are the stored values of each lifecycle's enum or canon reference table.

create table private.lifecycle_transition_rules (
  lifecycle text not null,
  from_state text not null,
  to_state text not null,
  primary key (lifecycle, from_state, to_state),
  constraint lifecycle_transition_rules_distinct check (from_state <> to_state),
  constraint lifecycle_transition_rules_lifecycle_format check (lifecycle ~ '^[a-z][a-z_]*$')
);

comment on table private.lifecycle_transition_rules is 'Allowed transitions of every lifecycle state machine (Section 3.12). A transition RPC refuses any move without a row here.';
comment on column private.lifecycle_transition_rules.lifecycle is 'Lifecycle name, for example project, production, record or accounting_period.';
comment on column private.lifecycle_transition_rules.from_state is 'Stored state value being left.';
comment on column private.lifecycle_transition_rules.to_state is 'Stored state value that may follow from_state.';

alter table private.lifecycle_transition_rules enable row level security;
revoke all on private.lifecycle_transition_rules from public, anon, authenticated;
grant select on private.lifecycle_transition_rules to service_role;

create view app.lifecycle_transition_rules as
select r.lifecycle, r.from_state, r.to_state from private.lifecycle_transition_rules r;

comment on view app.lifecycle_transition_rules is 'Allowed transitions of every lifecycle, so interfaces offer only moves the database accepts.';
comment on column app.lifecycle_transition_rules.lifecycle is 'Lifecycle name.';
comment on column app.lifecycle_transition_rules.from_state is 'State being left.';
comment on column app.lifecycle_transition_rules.to_state is 'State that may follow.';

revoke all on app.lifecycle_transition_rules from public, anon;
grant select on app.lifecycle_transition_rules to authenticated, service_role;

-- State column guard ---------------------------------------------------------------------------------------
-- Trigger arguments: state column, lifecycle name, initial state. On insert the state must be the
-- initial state; afterwards only the lifecycle's transition engine (marked by a trusted operation)
-- may change it.

create or replace function private.guard_lifecycle_state()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_column text := tg_argv[0];
  v_lifecycle text := tg_argv[1];
  v_initial text := tg_argv[2];
  v_new text := to_jsonb(new) ->> v_column;
  v_old text;
begin
  if private.in_trusted_operation(v_lifecycle || '_transition') then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if v_new is distinct from v_initial then
      perform private.refuse(v_lifecycle || '_initial_state',
        format('A new %s starts in %s; use its transition RPC to move it.', replace(v_lifecycle, '_', ' '), v_initial));
    end if;
    return new;
  end if;
  v_old := to_jsonb(old) ->> v_column;
  if v_new is distinct from v_old then
    perform private.refuse(v_lifecycle || '_transition_rpc_only',
      format('%s changes only through its transition RPC, which logs the change.', v_column));
  end if;
  return new;
end;
$$;

comment on function private.guard_lifecycle_state() is 'Before insert or update trigger: a lifecycle state column starts in its initial state and changes only through private.transition_lifecycle. Arguments: state column, lifecycle name, initial state.';

-- Creation entry --------------------------------------------------------------------------------------------
-- Trigger arguments: ledger table, subject column of the ledger, state column of the subject.

create or replace function private.log_initial_state()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ledger text := tg_argv[0];
  v_subject_column text := tg_argv[1];
  v_state_column text := tg_argv[2];
  v_state_type text;
begin
  select format_type(a.atttypid, a.atttypmod) into v_state_type
  from pg_catalog.pg_attribute a
  where a.attrelid = v_ledger::regclass and a.attname = 'to_state';
  execute format('insert into %s (%I, from_state, to_state, reason) values ($1, null, ($2)::%s, $3)',
    v_ledger, v_subject_column, v_state_type)
    using new.id, to_jsonb(new) ->> v_state_column, 'Created.';
  return null;
end;
$$;

comment on function private.log_initial_state() is 'After insert trigger: writes the creation entry (from_state null) of a lifecycle ledger. Arguments: ledger table, ledger subject column, subject state column.';

-- Transition engine --------------------------------------------------------------------------------------------

create or replace function private.transition_lifecycle(
  p_lifecycle text,
  p_table regclass,
  p_state_column text,
  p_ledger regclass,
  p_subject_column text,
  p_id uuid,
  p_expected text,
  p_next text,
  p_reason text
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_type text;
  v_org uuid;
  v_ledger_id uuid;
begin
  if p_reason is null or char_length(btrim(p_reason)) = 0 then
    perform private.refuse('transition_reason_required', 'Every state change carries a reason.');
  end if;
  if not exists (
    select 1 from private.lifecycle_transition_rules r
    where r.lifecycle = p_lifecycle and r.from_state = p_expected and r.to_state = p_next
  ) then
    perform private.refuse(p_lifecycle || '_transition_not_allowed',
      format('A %s cannot move from %s to %s.', replace(p_lifecycle, '_', ' '), p_expected, p_next));
  end if;
  select format_type(a.atttypid, a.atttypmod) into v_type
  from pg_catalog.pg_attribute a where a.attrelid = p_table and a.attname = p_state_column;

  perform private.begin_trusted_operation(p_lifecycle || '_transition');
  execute format(
    'update %s set %I = ($1)::%s where id = $2 and %I::text = $3 and deleted_at is null returning org_id',
    p_table, p_state_column, v_type, p_state_column)
    into v_org
    using p_next, p_id, p_expected;
  perform private.end_trusted_operation(p_lifecycle || '_transition');

  if v_org is null then
    perform private.refuse(p_lifecycle || '_state_conflict',
      format('The %s is not in the expected state %s.', replace(p_lifecycle, '_', ' '), p_expected));
  end if;

  execute format('insert into %s (%I, from_state, to_state, reason) values ($1, ($2)::%s, ($3)::%s, $4) returning id',
    p_ledger, p_subject_column, v_type, v_type)
    into v_ledger_id
    using p_id, p_expected, p_next, btrim(p_reason);
  return v_ledger_id;
end;
$$;

comment on function private.transition_lifecycle(text, regclass, text, regclass, text, uuid, text, text, text) is 'The one transition engine: checks the move against private.lifecycle_transition_rules, compare-and-sets the state on the expected current state, and writes the ledger entry. Callers authorize first. Returns the ledger entry id.';

-- Display key sequences ------------------------------------------------------------------------------------------

create table private.key_sequences (
  org_id uuid not null references app.organizations (id),
  sequence_name text not null,
  last_value bigint not null default 0,
  primary key (org_id, sequence_name),
  constraint key_sequences_last_value_nonnegative check (last_value >= 0)
);

comment on table private.key_sequences is 'Counters behind display keys and item IDs (Section 4.5.1): one row per org and sequence name, for example project:{id} for {projectKey}-{sequence}.';
comment on column private.key_sequences.org_id is 'Org the counter belongs to.';
comment on column private.key_sequences.sequence_name is 'Sequence name, such as project:{project id}.';
comment on column private.key_sequences.last_value is 'Last number issued. Numbers are never reused.';

alter table private.key_sequences enable row level security;
revoke all on private.key_sequences from public, anon, authenticated;
grant select on private.key_sequences to service_role;

create or replace function private.next_sequence(p_org_id uuid, p_sequence_name text)
returns bigint
language sql
volatile
security definer
set search_path = ''
as $$
  insert into private.key_sequences as s (org_id, sequence_name, last_value)
  values (p_org_id, p_sequence_name, 1)
  on conflict (org_id, sequence_name) do update set last_value = s.last_value + 1
  returning s.last_value;
$$;

comment on function private.next_sequence(uuid, text) is 'Issues the next number of a display key sequence (Section 4.5.1). Concurrent callers serialize on the counter row, so numbers are unique and gap-free per committed transaction.';

-- Time zones -----------------------------------------------------------------------------------------------------

create or replace function private.assert_time_zone(p_time_zone text)
returns void
language plpgsql
stable
set search_path = ''
as $$
begin
  if p_time_zone is not null and not exists (select 1 from pg_catalog.pg_timezone_names z where z.name = p_time_zone) then
    perform private.refuse('time_zone_unknown', format('%s is not an IANA time zone.', p_time_zone));
  end if;
end;
$$;

comment on function private.assert_time_zone(text) is 'Refuses a time zone name the IANA database does not know (Section 7.1: typed local times keep their IANA zone).';

-- Privileges -------------------------------------------------------------------------------------------------------

revoke all on procedure private.describe(regclass, text, text[]) from public, anon, authenticated;
revoke all on procedure private.install_domain_table(regclass, text, text, text[], boolean) from public, anon, authenticated;
revoke all on procedure private.install_policies(regclass, text, text, text) from public, anon, authenticated;
revoke all on function private.guard_lifecycle_state() from public, anon, authenticated;
revoke all on function private.log_initial_state() from public, anon, authenticated;
revoke all on function private.transition_lifecycle(text, regclass, text, regclass, text, uuid, text, text, text) from public, anon, authenticated;
revoke all on function private.next_sequence(uuid, text) from public, anon, authenticated;
revoke all on function private.assert_time_zone(text) from public, anon, authenticated;

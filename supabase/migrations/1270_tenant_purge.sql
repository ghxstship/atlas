-- 1270_tenant_purge.sql
-- A64 (RRR-109), ADR 0033 decision 1 amendment. The tenant purge: the one sanctioned way to hard-delete every row of
-- an org, used first to remove the demo seed from the project promoted to production
-- (infra/production/remove-demo-data.sql), and the seam Section 14.7's day-90 org deletion will reuse.
--
-- Several guards refuse hard deletes with no exception, because in normal operation nothing may remove those rows:
--   * append-only ledgers (private.refuse_ledger_change) allow only the retention purge job
--   * the audit ledger (private.guard_audit_event) allows no delete at all; expired months leave by partition
--   * the sole Owner rule (private.assert_other_owner, invariant 4)
--   * posted journal lines, locked baselines, locked payroll lines, issued wholesale statements, Canceled records
--     and custom roles are retained
-- When the whole org goes, those rules protect nothing, yet without an exception the org cannot be deleted at all.
--
-- private.begin_tenant_purge(org ids) marks the current transaction as purging exactly those orgs. While the mark
-- stands, each guard above lets a DELETE of a row of a marked org through (updates stay refused), and the audit
-- trigger writes no audit row for a marked org, whose audit rows are being deleted too. Nothing is disabled: every
-- trigger and foreign key stays on, rows of any other org keep every rule, and the mark lives in a private table
-- keyed by transaction id, so it ends with the transaction and cannot be forged by a client (only definer functions
-- write private tables, and the functions are granted to no client role). An org under an active legal hold is
-- refused.

create table private.tenant_purge_scope (
  xact_id xid8 not null default pg_current_xact_id(),
  org_id uuid not null,
  primary key (xact_id, org_id)
);

comment on table private.tenant_purge_scope is 'Orgs the current transaction is purging (private.begin_tenant_purge). Rows are removed by private.end_tenant_purge before the transaction ends.';
comment on column private.tenant_purge_scope.xact_id is 'Transaction that is purging the org.';
comment on column private.tenant_purge_scope.org_id is 'Org being purged.';

alter table private.tenant_purge_scope enable row level security;
revoke all on private.tenant_purge_scope from public, anon, authenticated;

create or replace function private.begin_tenant_purge(p_org_ids uuid[])
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_held text;
  v_count integer;
begin
  if p_org_ids is null or cardinality(p_org_ids) = 0 then
    perform private.refuse('tenant_purge_scope', 'Name at least one org to purge.');
  end if;
  select string_agg(distinct o.slug || ' (' || h.matter || ')', ', ') into v_held
  from app.legal_holds h join app.organizations o on o.id = h.org_id
  where h.org_id = any (p_org_ids) and h.released_at is null and h.deleted_at is null;
  if v_held is not null then
    perform private.refuse('tenant_purge_legal_hold', format('Orgs under an active legal hold cannot be purged: %s.', v_held));
  end if;
  insert into private.tenant_purge_scope (org_id)
  select distinct u.org_id from unnest(p_org_ids) as u (org_id) where u.org_id is not null
  on conflict do nothing;
  select count(*) into v_count from private.tenant_purge_scope s where s.xact_id = pg_current_xact_id();
  return v_count;
end;
$$;

comment on function private.begin_tenant_purge(uuid[]) is 'Marks the current transaction as purging the named orgs: guards that refuse hard deletes let deletes of those orgs'' rows through and the audit trigger skips them. Refuses an org under an active legal hold. Returns how many orgs the transaction is purging. Service role and database owner only.';

create or replace function private.in_tenant_purge(p_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_org_id is not null and exists (
    select 1 from private.tenant_purge_scope s
    where s.xact_id = pg_current_xact_id() and s.org_id = p_org_id
  );
$$;

comment on function private.in_tenant_purge(uuid) is 'True when the current transaction is purging the org (private.begin_tenant_purge).';

create or replace function private.end_tenant_purge()
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  delete from private.tenant_purge_scope s where s.xact_id = pg_current_xact_id();
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

comment on function private.end_tenant_purge() is 'Ends the tenant purge mark of the current transaction. Returns how many orgs it had marked.';

revoke all on function private.begin_tenant_purge(uuid[]) from public, anon, authenticated;
revoke all on function private.in_tenant_purge(uuid) from public, anon, authenticated;
revoke all on function private.end_tenant_purge() from public, anon, authenticated;
grant execute on function private.begin_tenant_purge(uuid[]) to service_role;
grant execute on function private.end_tenant_purge() to service_role;

-- Guards that let a purge delete through ---------------------------------------------------------------------------
-- Each body below is the current definition with one added clause at the top; nothing else changes.

create or replace function private.refuse_ledger_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' and (private.in_trusted_operation('retention_purge')
                           or private.in_tenant_purge((to_jsonb(old) ->> 'org_id')::uuid)) then
    return old;
  end if;
  perform private.refuse('append_only', format('%s is an append-only ledger.', tg_table_name));
  return null;
end;
$$;

comment on function private.refuse_ledger_change() is 'Before update or delete trigger on append-only ledgers: refuses the change, except deletes by the retention purge job once a row is past its retention period and deletes of a purged org''s rows (private.begin_tenant_purge).';

create or replace function private.guard_audit_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' and private.in_tenant_purge(old.org_id) then
    return old;
  end if;
  if private.in_trusted_operation('audit_redaction')
     and tg_op = 'UPDATE'
     and (to_jsonb(new) - array['diff', 'actor_ip', 'user_agent', 'redacted_at', 'updated_at', 'updated_by'])
       = (to_jsonb(old) - array['diff', 'actor_ip', 'user_agent', 'redacted_at', 'updated_at', 'updated_by']) then
    return new;
  end if;
  perform private.refuse('append_only', 'audit_events is an append-only ledger; only redaction changes it.');
  return null;
end;
$$;

comment on function private.guard_audit_event() is 'Before update or delete trigger: the audit ledger is append-only (invariant 23); the redaction job alone may replace personal data. Expired months leave by partition detachment, never by delete; a purged org''s rows leave with the org (private.begin_tenant_purge).';

create or replace function private.audit_row_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_excluded text[] := private.audit_excluded_columns(tg_relid);
  v_old jsonb;
  v_new jsonb;
  v_diff jsonb;
  v_row jsonb;
  v_key text;
begin
  if private.in_trusted_operation('retention_purge') then
    return null;
  end if;
  if tg_op in ('UPDATE', 'DELETE') then
    v_old := to_jsonb(old) - v_excluded;
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    v_new := to_jsonb(new) - v_excluded;
  end if;
  v_row := coalesce(to_jsonb(new), to_jsonb(old));
  if (v_row ->> 'org_id') is null then
    return null;
  end if;
  if private.in_tenant_purge((v_row ->> 'org_id')::uuid) then
    return null;
  end if;
  if tg_op = 'UPDATE' then
    v_diff := jsonb_build_object('old', '{}'::jsonb, 'new', '{}'::jsonb);
    for v_key in select k from jsonb_object_keys(v_new) k loop
      if (v_new -> v_key) is distinct from (v_old -> v_key) then
        v_diff := jsonb_set(v_diff, array['old', v_key], coalesce(v_old -> v_key, 'null'::jsonb));
        v_diff := jsonb_set(v_diff, array['new', v_key], v_new -> v_key);
      end if;
    end loop;
    if v_diff -> 'new' = '{}'::jsonb then
      return null;
    end if;
  elsif tg_op = 'INSERT' then
    v_diff := jsonb_build_object('new', v_new);
  else
    v_diff := jsonb_build_object('old', v_old);
  end if;
  perform private.write_audit_event((v_row ->> 'org_id')::uuid, tg_table_name || '.' || lower(tg_op), tg_table_schema || '.' || tg_table_name,
    (v_row ->> 'id')::uuid, v_diff);
  return null;
end;
$$;

comment on function private.audit_row_change() is 'After insert, update or delete trigger: writes the row change to the audit ledger with a diff that leaves out audit columns, hashes and Restricted columns. Rows without an org, purge deletes and changes to a purged org''s rows (private.begin_tenant_purge) are not audited.';

create or replace function private.assert_other_owner(p_org_id uuid, p_excluding_membership_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if private.in_tenant_purge(p_org_id) then
    return;
  end if;
  perform 1 from app.organizations o where o.id = p_org_id for update;
  if not exists (
    select 1 from app.memberships m
    join app.membership_roles mr on mr.membership_id = m.id and mr.deleted_at is null
    join app.roles r on r.id = mr.role_id and r.org_id is null and r.code = 'owner'
    where m.org_id = p_org_id and m.id <> p_excluding_membership_id
      and m.deleted_at is null and m.valid_from <= now() and m.valid_to is null
  ) then
    perform private.refuse('sole_owner',
      'An org keeps at least one Owner; the sole Owner cannot remove or demote themselves.');
  end if;
end;
$$;

comment on function private.assert_other_owner(uuid, uuid) is 'Section 7.5 invariant 4: refuses a change that would leave an org without an open-ended Owner. Locks the org row so concurrent demotions serialize. An org being purged (private.begin_tenant_purge) keeps no Owner, so the rule does not apply to it.';

create or replace function private.guard_journal_line()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row app.journal_lines := case when tg_op = 'DELETE' then old else new end;
  v_entry app.journal_entries;
begin
  if tg_op = 'DELETE' and private.in_tenant_purge(old.org_id) then
    return old;
  end if;
  select * into v_entry from app.journal_entries e where e.id = v_row.journal_entry_id;
  if v_entry.journal_state <> 'Proposed' then
    perform private.refuse('journal_posted_immutable', 'A posted or canceled journal entry never changes; post a reversing entry.');
  end if;
  perform private.postable_period(v_entry.org_id, v_entry.entry_date);
  if tg_op <> 'DELETE' then
    perform private.assert_urid(new.urid);
    if tg_op = 'UPDATE' and new.journal_entry_id <> old.journal_entry_id then
      perform private.refuse('journal_line_entry_immutable', 'A journal line stays on its entry.');
    end if;
  end if;
  return v_row;
end;
$$;

comment on function private.guard_journal_line() is 'Journal lines change only while their entry is Proposed and its period accepts postings (invariant 13); dimension 2 is a canon URID. A purged org''s lines are deleted with it (private.begin_tenant_purge).';

create or replace function private.guard_baseline_item()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' and private.in_tenant_purge(old.org_id) then
    return old;
  end if;
  if (select b.locked_at from app.schedule_baselines b where b.id = coalesce(new.schedule_baseline_id, old.schedule_baseline_id)) is not null then
    perform private.refuse('baseline_locked', 'A locked baseline never changes.');
  end if;
  if tg_op <> 'DELETE' and (select r.project_id from app.records r where r.id = new.record_id)
     <> (select b.project_id from app.schedule_baselines b where b.id = new.schedule_baseline_id) then
    perform private.refuse('same_project', 'A baseline item names a record of the baseline''s project.');
  end if;
  return coalesce(new, old);
end;
$$;

comment on function private.guard_baseline_item() is 'Baseline items: records of the same project; nothing changes once the baseline is locked, except that a purged org''s items are deleted with it (private.begin_tenant_purge).';

create or replace function private.guard_payroll_line()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row app.payroll_lines := case when tg_op = 'DELETE' then old else new end;
begin
  if tg_op = 'DELETE' and private.in_tenant_purge(old.org_id) then
    return old;
  end if;
  if (select r.payroll_run_state from app.payroll_runs r where r.id = v_row.payroll_run_id) not in ('Draft', 'Calculated') then
    perform private.refuse('payroll_run_locked', 'Payroll lines change only while the run is Draft or Calculated.');
  end if;
  if (select p.pay_period_state from app.pay_periods p join app.payroll_runs r on r.pay_period_id = p.id where r.id = v_row.payroll_run_id) = 'Posted' then
    perform private.refuse('pay_period_posted', 'A posted pay period accepts no payroll changes.');
  end if;
  return v_row;
end;
$$;

comment on function private.guard_payroll_line() is 'Payroll lines change only while the run is Draft or Calculated and its pay period is not Posted. A purged org''s lines are deleted with it (private.begin_tenant_purge).';

create or replace function private.refuse_record_delete()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if private.in_tenant_purge(old.org_id) then
    return old;
  end if;
  if old.record_state = 'Canceled' then
    perform private.refuse('record_retained', 'Canceled records are retained, never deleted.');
  end if;
  return old;
end;
$$;

comment on function private.refuse_record_delete() is 'Before delete trigger: Canceled records are retained, never deleted (Section 3.10), except with their purged org (private.begin_tenant_purge).';

create or replace function private.guard_role()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_platform boolean := auth.uid() is null;
  v_row app.roles := case when tg_op = 'DELETE' then old else new end;
begin
  if v_row.org_id is null then
    if not v_platform then
      perform private.refuse('system_role_immutable', 'Platform system roles change only through the capability registry.');
    end if;
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'DELETE' then
    if private.in_tenant_purge(old.org_id) then
      return old;
    end if;
    perform private.refuse('role_retained', 'Custom roles are removed by setting deleted_at.');
  end if;
  if tg_op = 'UPDATE' and (new.code <> old.code or new.band <> old.band) then
    perform private.refuse('role_definition_immutable', 'A custom role keeps its code and band; create another role instead.');
  end if;
  if tg_op = 'INSERT' then
    if exists (select 1 from app.roles r where r.org_id is null and r.code = new.code) then
      perform private.refuse('role_code_reserved', format('%s is a platform role code.', new.code));
    end if;
    if not private.org_has_feature(new.org_id, 'custom_roles') then
      perform private.refuse('plan_feature_unavailable', 'Custom roles need the Team plan or above.');
    end if;
  end if;
  return new;
end;
$$;

comment on function private.guard_role() is 'System roles are immutable outside the generated seed; custom roles need the custom_roles plan feature, never reuse a system code and keep their code and band, and are deleted only with their purged org (private.begin_tenant_purge).';

create or replace function private.guard_wholesale_statement_totals()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' and private.in_tenant_purge(old.org_id) then
    return old;
  end if;
  if private.in_trusted_operation('wholesale_statement') and old.client_count = 0 and old.list_total_minor = 0 then
    return new;
  end if;
  perform private.refuse('ledger_append_only', 'A wholesale statement never changes once issued.');
  return null;
end;
$$;

comment on function private.guard_wholesale_statement_totals() is 'Wholesale statements are append-only, except the one update of the totals inside app.run_wholesale_billing and deletes with their purged org (private.begin_tenant_purge).';

-- 1610_canon_decision_39.sql
-- WP18 (range 1610 to 1619, ADR 0022 amendment of 2026-10-23; RRR-66). Owner decision 39 (2026-10-23,
-- canon/rulings/decision-39.yaml): the seven canon rulings of finding A56-001 and the declared gaps of finding
-- A65-019. The canon importer applies it and regenerated 0101_xpms_tables.sql and 0150_xpms_canon_seed.sql.
-- Databases that applied those before the regeneration (staging) get the same state from this migration; on a
-- fresh reset every data statement here is a no-op. It also reports the declared gaps in xpms.v_phase_coverage
-- (doctrine 3.4), which 0104 defines by hand.

-- Declared gaps (generated DDL, made idempotent), with the privileges 0199 gives every xpms table: canon is
-- read-only to authenticated users and written only by the migration owner and service_role.
create table if not exists xpms.declared_gap (
  phase_code xpms.canon_code not null references xpms.dim_phase(phase_code),
  reason xpms.canon_text not null,
  decision xpms.canon_code not null,
  ratified_by xpms.canon_text not null,
  ratified_on date not null,
  primary key (phase_code)
);
comment on table xpms.declared_gap is 'Declared gaps (doctrine 3.4): a gated phase with no Active element carries one, ratified by the owner (owner decision 39, 2026-10-23, finding A65-019). xpms.v_phase_coverage reports it.';
comment on column xpms.declared_gap.phase_code is 'Gated phase the gap is declared for.';
comment on column xpms.declared_gap.reason is 'Why the phase has no Active element.';
comment on column xpms.declared_gap.decision is 'Owner decision that declared the gap (D39).';
comment on column xpms.declared_gap.ratified_by is 'Named human ratifier.';
comment on column xpms.declared_gap.ratified_on is 'Date the gap was ratified.';

do $$
begin
  revoke all on table xpms.declared_gap from public, anon, authenticated;
  grant all on table xpms.declared_gap to service_role;
  grant select on table xpms.declared_gap to authenticated;
  alter table xpms.declared_gap enable row level security;
  if not exists (select 1 from pg_catalog.pg_policies where schemaname = 'xpms' and tablename = 'declared_gap' and policyname = 'declared_gap_canon_read') then
    create policy declared_gap_canon_read on xpms.declared_gap for select to authenticated using (true);
  end if;
end;
$$;

insert into xpms.declared_gap (phase_code, reason, decision, ratified_by, ratified_on) values
  ('AMP', 'No Amplify item is Active yet; the Item Catalog proposes every one.', 'D39', 'Julian Clarkson', '2026-10-23'::date),
  ('CLS', 'No Close item is Active yet; the Item Catalog proposes every one.', 'D39', 'Julian Clarkson', '2026-10-23'::date),
  ('ENG', 'No Engage item is Active yet; the Item Catalog proposes every one.', 'D39', 'Julian Clarkson', '2026-10-23'::date),
  ('SCP', 'No Scope item is Active yet; the Item Catalog proposes every one.', 'D39', 'Julian Clarkson', '2026-10-23'::date)
on conflict (phase_code) do nothing;

-- Ruling 1: "Show" means OPR and "Procurement" means PRC. -----------------------------------------------------
-- The Playbook names the same phases in its Procurement Catalog: those cells stay in intake as Canceled, so the
-- Playbook round trip still reproduces them (xpms.pb_overlay). Taken from the Item Catalog rows before they leave
-- Proposed.
insert into xpms.intake (source_file, source_sheet, source_row, source_column, target_table, target_key, target_column,
  proposed_value, canon_value, reason, intake_state)
select 'XOS-4.0_Production-Playbook_2026.xlsx', 'Procurement Catalog', e.source_row, 'DEFAULT PHASE', 'bridge_element_phase',
  e.element_id, 'phase_code', i.proposed_value, r.phase,
  format('Playbook Procurement Catalog differs from the Bible. Owner decision 39 (2026-10-23, RRR-66): "%s" means %s, so canon holds %s; the Playbook''s label stays in intake for the round trip.',
    i.proposed_value, r.phase_code, r.phase),
  'Canceled'
from xpms.intake i
join xpms.elements e on e.element_id = i.target_key
join (values ('Show', 'OPR'), ('Procurement', 'PRC')) as m (label, phase_code) on m.label = i.proposed_value
join xpms.dim_phase r on r.phase_code = m.phase_code
where i.source_file = 'XOS_4.0_Item_Catalog.csv' and i.source_column = 'default_phase' and e.source_row is not null
on conflict (source_file, source_sheet, source_row, source_column) do nothing;

insert into xpms.bridge_element_phase (element_id, phase_code, is_default)
select i.target_key, m.phase_code, true
from xpms.intake i
join (values ('Show', 'OPR'), ('Procurement', 'PRC')) as m (label, phase_code) on m.label = i.proposed_value
where i.source_file = 'XOS_4.0_Item_Catalog.csv' and i.source_column = 'default_phase' and i.intake_state = 'Proposed'
on conflict do nothing;

update xpms.dim_touchpoint t set lifecycle_phase_code = 'OPR'
from xpms.intake i
where i.source_file = 'XOS_4.0_Bible.xlsx' and i.source_column = 'lifecycle_gate' and i.proposed_value = 'Show'
  and i.intake_state = 'Proposed' and i.target_key = t.touchpoint_id and t.lifecycle_phase_code is null;

update xpms.intake i
set intake_state = 'Complete',
    canon_value = m.phase_code,
    reason = format('%s "%s" is not one of the nine gated phases in Bible tab 05. Owner decision 39 (2026-10-23, RRR-66): "%s" means %s. %s',
      case i.source_column when 'default_phase' then 'Default phase' else 'Lifecycle gate' end,
      m.label, m.label, m.phase_code, m.note)
from (values ('Show', 'OPR', 'The show runs in Operate (gate 7).'),
             ('Procurement', 'PRC', 'Procurement is Procure (gate 4).')) as m (label, phase_code, note)
where i.intake_state = 'Proposed' and i.proposed_value = m.label
  and ((i.source_file = 'XOS_4.0_Item_Catalog.csv' and i.source_column = 'default_phase')
    or (i.source_file = 'XOS_4.0_Bible.xlsx' and i.source_column = 'lifecycle_gate'));

-- Ruling 4: the empty statements of tabs 23 and 34 are removed (tabs 24 and 25 were never loaded). -----------
delete from xpms.canon_statement where tab = '23 Silence Rule';
delete from xpms.dim_budget_template_rule where field in ('Estimate', 'Budget', 'Forecast', 'Variance', 'Rate')
  and rule like '=%';

-- Ruling 7: the time unit dimension, so the Standard Library units Hour and Week resolve. -----------------------
insert into xpms.dim_unit_dimension (dimension_code, name) values ('time', 'Time') on conflict (dimension_code) do nothing;
insert into xpms.dim_unit_alias (alias, unit_code, dimension_code) values
  ('hour', 'hour', 'time'),
  ('week', 'week', 'time')
on conflict (alias) do nothing;
update xpms.dim_unit_alias set dimension_code = 'time' where alias in ('day', 'year') and dimension_code is null;

update xpms.label_mapping m
set canon_value = lower(m.playbook_label),
    basis = 'casing-or-punctuation',
    note = format('Owner decision 25: Unit of Measure %s differs from canon %s only in casing or punctuation, so it follows the Bible.',
      m.playbook_label, lower(m.playbook_label))
where m.source_list = 'Enumerations: Unit of Measure' and m.playbook_label in ('Hour', 'Week') and m.basis = 'deferred';

-- Comments the regenerated 0101 carries ---------------------------------------------------------------------------
comment on table xpms.intake is 'Staging for proposed canon additions and changes. Neither source silently wins: a value that disagrees with canon or cannot be resolved waits here as Proposed until the owner decides. A Playbook value an owner decision does not adopt stays here as Canceled, so the Playbook round trip still reproduces the source; an adopted Playbook value leaves intake for canon and xpms.playbook_sourced_value. A Bible or Item Catalog value an owner ruling resolves (decision 39) stays here as Complete, with the canon value it resolved to.';
comment on column xpms.intake.canon_value is 'Value canon currently holds, or for a Complete row the value the ruling resolved it to; NULL when canon is silent.';
comment on column xpms.intake.intake_state is 'State of the proposal: Proposed until the owner decides; Canceled when a decision keeps canon''s value; Complete when an owner ruling resolves it into canon.';
comment on table xpms.dim_role is 'The 61 workforce roles (Bible tab 27) with function name, job title and staffing ratio. Role codes share the URID shape. Tab 27 no longer decides which role codes exist: owner decision 39 (2026-10-23) retires it as their authority in favor of the Roles Library, xpms.role (ruling D12).';
comment on column xpms.dim_gl_account.class_code is 'Department class of a revenue or expense account, derived from the class digit; NULL for balance sheet accounts (decision D13: postings resolve by class, after an explicit item GL default and before a counterparty type''s, as owner decision 39 reads D13).';
comment on column xpms.dim_counterparty_type.default_account_code is 'DEFAULT GL ACCOUNT from the Playbook Counterparty Types sheet: the counterparty GL default ruling D13 allows (owner decision 39), used when the line''s class gives no account of the type.';
comment on column xpms.elements.purchase_account is 'Purchase account: the item''s explicit GL default (ruling D13 as owner decision 39 reads it), which a posting uses before its class''s account.';
comment on column xpms.elements.sales_account is 'Sales account: the item''s explicit GL default on the revenue side (ruling D13 as owner decision 39 reads it).';
comment on column xpms.dim_touchpoint.lifecycle_phase_code is 'Lifecycle gate, relabeled to 4.0; NULL where canon names a value that is not a gated phase (held in xpms.intake). A name an owner ruling reads as a gated phase takes that phase (decision 39: Show is OPR).';
comment on table xpms.dim_unit_dimension is 'Physical dimensions of units (count, length, time and so on). Owner decision 39 (2026-10-23) ratifies time; any other dimension arrives through intake.';
comment on table xpms.dim_unit_alias is 'Unit bases used by canon (the Item Catalog unit_basis values, and hour and week, which owner decision 39 adds with the time dimension). A unit without a dimension refuses arithmetic rather than guessing.';

-- Phase coverage reports the declared gaps (doctrine 3.4) --------------------------------------------------------
create or replace view xpms.v_phase_coverage
with (security_invoker = true)
as
select
  p.phase_code,
  p.gate,
  p.phase,
  count(bp.element_id)::integer as element_count,
  (count(bp.element_id) filter (where e.lifecycle_state = 'Active'))::integer as active_element_count,
  count(distinct e.urid)::integer as category_count,
  coalesce(bool_or(e.lifecycle_state = 'Active'), false) as has_active_element,
  g.phase_code is not null as declared_gap,
  g.reason as declared_gap_reason
from xpms.dim_phase p
left join xpms.bridge_element_phase bp on bp.phase_code = p.phase_code
left join xpms.elements e on e.element_id = bp.element_id
left join xpms.declared_gap g on g.phase_code = p.phase_code
group by p.phase_code, p.gate, p.phase, g.phase_code, g.reason
order by p.gate;

comment on view xpms.v_phase_coverage is
  'Catalog coverage per gated phase. A phase without an Active element carries a declared gap the owner ratified (Section 3.4, xpms.declared_gap).';
comment on column xpms.v_phase_coverage.declared_gap is 'True when the phase carries a declared gap.';
comment on column xpms.v_phase_coverage.declared_gap_reason is 'Why the phase has no Active element, as the declared gap states it; NULL without one.';

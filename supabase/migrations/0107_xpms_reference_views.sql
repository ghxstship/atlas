-- 0107_xpms_reference_views.sql
-- A01 Canon. Views and the function of the owner's canon reference model
-- (design/xos-design-system/export/canon/0100_xpms_canon.sql, decisions D13, D16 and D19),
-- ported to ADR 0002 and Postgres 17. Derived values are read, never stored.

-- Departments as the reference model names them: one home in xpms.dim_department.
create view xpms.department
with (security_invoker = true)
as
select d.dept_code as class_code, d.department as name
  from xpms.dim_department d
 order by d.dept_code;

comment on view xpms.department is 'The ten department classes under the reference model names (class_code, name); rows live in xpms.dim_department.';
comment on column xpms.department.class_code is 'Four-digit class code.';
comment on column xpms.department.name is 'Department label.';

-- GL accounts as the reference model names them. The class is derived from the code (decision D13).
create view xpms.gl_account
with (security_invoker = true)
as
select g.account_code as code, g.account_name as name, g.account_type as type, g.class_code
  from xpms.dim_gl_account g
 order by g.account_code;

comment on view xpms.gl_account is 'The 23-account chart under the reference model names. Each class owns at most one account per type; postings resolve by class (decision D13).';
comment on column xpms.gl_account.code is 'Account code.';
comment on column xpms.gl_account.name is 'Account name.';
comment on column xpms.gl_account.type is 'Account type.';
comment on column xpms.gl_account.class_code is 'Department class of a revenue or expense account; NULL for balance sheet accounts.';

-- Rate cards as every surface reads them. GL posting follows the role's class (decision D13).
create view xpms.rate_card_resolved
with (security_invoker = true)
as
select
  rc.rate_card_id,
  rc.role_code,
  r.job_title,
  d.dept_code as class_code,
  d.department,
  wc.label as worker_classification,
  rc.pay_basis,
  rc.arrangement,
  rc.standard_rate_minor,
  rc.min_grade_rate_minor,
  rc.max_grade_rate_minor,
  rc.per_diem_rate_minor,
  rc.currency_code,
  o.rule_id as overtime_rule_id,
  o.ot_multiplier,
  o.dt_multiplier,
  g.account_code as gl_account,
  g.account_name as gl_account_name
from xpms.rate_card rc
join xpms.role r on r.role_code = rc.role_code
join xpms.dim_department d on d.dept_code = r.class_code
join xpms.worker_classification wc on wc.code = rc.worker_classification
join xpms.overtime_rule o on o.rule_id = rc.overtime_rule_id
left join xpms.dim_gl_account g on g.class_code = r.class_code and g.account_type = 'Expense'
order by rc.rate_card_id;

comment on view xpms.rate_card_resolved is 'Labor rate cards with the role title, department, classification label, overtime multipliers and the derived expense account of the role''s class.';
comment on column xpms.rate_card_resolved.rate_card_id is 'Rate card.';
comment on column xpms.rate_card_resolved.role_code is 'Role priced.';
comment on column xpms.rate_card_resolved.job_title is 'Job title from the Roles Library.';
comment on column xpms.rate_card_resolved.class_code is 'Department class derived from the role code.';
comment on column xpms.rate_card_resolved.department is 'Department label.';
comment on column xpms.rate_card_resolved.worker_classification is 'Classification label.';
comment on column xpms.rate_card_resolved.pay_basis is 'Pay basis.';
comment on column xpms.rate_card_resolved.arrangement is 'Arrangement.';
comment on column xpms.rate_card_resolved.standard_rate_minor is 'Standard rate in minor units.';
comment on column xpms.rate_card_resolved.min_grade_rate_minor is 'Lowest grade rate in minor units.';
comment on column xpms.rate_card_resolved.max_grade_rate_minor is 'Highest grade rate in minor units.';
comment on column xpms.rate_card_resolved.per_diem_rate_minor is 'Per diem in minor units.';
comment on column xpms.rate_card_resolved.currency_code is 'Currency of the amounts.';
comment on column xpms.rate_card_resolved.overtime_rule_id is 'Overtime rule.';
comment on column xpms.rate_card_resolved.ot_multiplier is 'Overtime multiplier.';
comment on column xpms.rate_card_resolved.dt_multiplier is 'Double-time multiplier.';
comment on column xpms.rate_card_resolved.gl_account is 'Expense account of the role''s class.';
comment on column xpms.rate_card_resolved.gl_account_name is 'Name of that account.';

-- Jurisdictions as every surface reads them: Bible tab 11 exactly (decision D19).
create view xpms.jurisdiction_resolved
with (security_invoker = true)
as
with recursive chain as (
  select j.jurisdiction_id as id, j.jurisdiction_id as ancestor, 0 as depth
    from xpms.jurisdiction j
  union all
  select c.id, p.parent, c.depth + 1
    from chain c
    join xpms.jurisdiction p on p.jurisdiction_id = c.ancestor
   where p.parent is not null
)
select
  j.jurisdiction_id,
  j.level,
  j.country,
  j.parent,
  (select a.unit_system from chain c join xpms.jurisdiction a on a.jurisdiction_id = c.ancestor
    where c.id = j.jurisdiction_id and a.unit_system is not null order by c.depth limit 1) as unit_system,
  (select a.currency from chain c join xpms.jurisdiction a on a.jurisdiction_id = c.ancestor
    where c.id = j.jurisdiction_id and a.currency is not null order by c.depth limit 1) as currency,
  (select string_agg(cs.code_set, ', ' order by cs.sort_order) from xpms.jurisdiction_code_set cs
    where cs.jurisdiction_id = j.jurisdiction_id) as primary_code_sets,
  j.status,
  j.note
from xpms.jurisdiction j
order by j.ordinal;

comment on view xpms.jurisdiction_resolved is 'Jurisdictions with inherited unit system and currency resolved and code sets listed in order: Bible tab 11 exactly.';
comment on column xpms.jurisdiction_resolved.jurisdiction_id is 'Jurisdiction.';
comment on column xpms.jurisdiction_resolved.level is 'country, region or ahj.';
comment on column xpms.jurisdiction_resolved.country is 'Country, derived from the ID.';
comment on column xpms.jurisdiction_resolved.parent is 'Enclosing jurisdiction.';
comment on column xpms.jurisdiction_resolved.unit_system is 'Unit system, inherited down the chain.';
comment on column xpms.jurisdiction_resolved.currency is 'Currency, inherited down the chain.';
comment on column xpms.jurisdiction_resolved.primary_code_sets is 'Adopted code sets, comma separated as tab 11 writes them.';
comment on column xpms.jurisdiction_resolved.status is 'populated or declared-unpopulated.';
comment on column xpms.jurisdiction_resolved.note is 'Canon note.';

-- Wage-and-hour chain for a jurisdiction, strictest value first (rule XOS-ENG-5).
create or replace function xpms.min_ot_multiplier(j text)
returns numeric
language sql
stable
set search_path = ''
as $$
  with recursive chain as (
    select x.jurisdiction_id, x.parent from xpms.jurisdiction x where x.jurisdiction_id = j
    union all
    select p.jurisdiction_id, p.parent from xpms.jurisdiction p join chain c on p.jurisdiction_id = c.parent
  )
  select max(w.min_ot_multiplier) from chain c join xpms.wage_hour_rule w on w.jurisdiction_id = c.jurisdiction_id;
$$;

comment on function xpms.min_ot_multiplier(text) is 'The strictest minimum overtime multiplier up the jurisdiction chain; NULL when no rule applies. Used by the engagement compliance rules.';

-- Category postings derived by class (decision D13). Bible tab 31 states the same accounts;
-- the importer verifies every one before the derived form replaces the stored column.
create view xpms.v_category_gl
with (security_invoker = true)
as
select c.cat_urid, g.account_code, g.account_name, cg.default_cost_center
  from xpms.dim_category c
  join xpms.dim_gl_account g on g.class_code = left(c.cat_urid, 4) and g.account_type = 'Expense'
  left join xpms.dim_category_gl cg on cg.cat_urid = c.cat_urid
 order by c.cat_urid;

comment on view xpms.v_category_gl is 'Every category with the expense account of its class (decision D13) and its default cost center (Bible tab 31).';
comment on column xpms.v_category_gl.cat_urid is 'Category.';
comment on column xpms.v_category_gl.account_code is 'Expense account of the category''s class.';
comment on column xpms.v_category_gl.account_name is 'Name of that account.';
comment on column xpms.v_category_gl.default_cost_center is 'Default dimension 1.';

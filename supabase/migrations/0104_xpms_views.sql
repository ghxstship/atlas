-- 0104_xpms_views.sql
-- A01 Canon. Derived canon views (Section 7.2). Derived values are computed, never
-- stored (Section 3.15). Views run with the caller's privileges (security_invoker).

-- The 90 coordinates: 10 department classes by 9 gated phases --------------------------

create view xpms.v_coordinate_matrix
with (security_invoker = true)
as
select
  d.dept_code,
  d.department,
  p.phase_code,
  p.gate,
  p.phase,
  d.dept_code || 'x' || p.phase_code as coordinate,
  count(bp.element_id)::integer as element_count
from xpms.dim_department d
cross join xpms.dim_phase p
left join xpms.elements e on left(e.urid, 4) = d.dept_code
left join xpms.bridge_element_phase bp on bp.element_id = e.element_id and bp.phase_code = p.phase_code
group by d.dept_code, d.department, p.phase_code, p.gate, p.phase
order by d.dept_code, p.gate;

comment on view xpms.v_coordinate_matrix is
  'The 90-coordinate matrix {CLASS}x{PHASE_CODE} (Bible tab 33), computed and never stored, with the number of elements of the class that participate in the phase.';
comment on column xpms.v_coordinate_matrix.dept_code is 'Department class.';
comment on column xpms.v_coordinate_matrix.department is 'Department label.';
comment on column xpms.v_coordinate_matrix.phase_code is 'Gated phase.';
comment on column xpms.v_coordinate_matrix.gate is 'Gate ordinal of the phase.';
comment on column xpms.v_coordinate_matrix.phase is 'Phase label.';
comment on column xpms.v_coordinate_matrix.coordinate is 'Coordinate in canon form, such as 4000xBLD.';
comment on column xpms.v_coordinate_matrix.element_count is 'Elements of the class participating in the phase.';

-- Phase coverage: every gated phase must carry an Active element or a declared gap -----

create view xpms.v_phase_coverage
with (security_invoker = true)
as
select
  p.phase_code,
  p.gate,
  p.phase,
  count(bp.element_id)::integer as element_count,
  (count(bp.element_id) filter (where e.lifecycle_state = 'Active'))::integer as active_element_count,
  count(distinct e.urid)::integer as category_count,
  coalesce(bool_or(e.lifecycle_state = 'Active'), false) as has_active_element
from xpms.dim_phase p
left join xpms.bridge_element_phase bp on bp.phase_code = p.phase_code
left join xpms.elements e on e.element_id = bp.element_id
group by p.phase_code, p.gate, p.phase
order by p.gate;

comment on view xpms.v_phase_coverage is
  'Catalog coverage per gated phase. A phase without an Active element needs a declared gap (Section 3.4).';
comment on column xpms.v_phase_coverage.phase_code is 'Gated phase.';
comment on column xpms.v_phase_coverage.gate is 'Gate ordinal.';
comment on column xpms.v_phase_coverage.phase is 'Phase label.';
comment on column xpms.v_phase_coverage.element_count is 'Elements participating in the phase.';
comment on column xpms.v_phase_coverage.active_element_count is 'Participating elements in the Active state.';
comment on column xpms.v_phase_coverage.category_count is 'Distinct categories among participating elements.';
comment on column xpms.v_phase_coverage.has_active_element is 'True when at least one participating element is Active.';

-- Element economics: one row per element and price grade -------------------------------

create view xpms.v_element_economics
with (security_invoker = true)
as
select
  e.element_id,
  e.item,
  e.urid,
  e.unit_basis,
  g.code as grade_code,
  g.label as grade,
  b.amount_minor,
  b.currency_code,
  b.assertion_word,
  b.valid_from,
  b.valid_to,
  xpms.band_effective_confidence(b.assertion_word, b.valid_from, b.valid_to, current_date) as effective_confidence,
  b.element_id is null as is_unpriced
from xpms.elements e
cross join xpms.grade g
left join xpms.element_price_bands b on b.element_id = e.element_id and b.grade_code = g.code
order by e.element_id, g.sort_order;

comment on view xpms.v_element_economics is
  'Every element at every price grade. A missing band is unpriced (amount NULL, never 0); effective confidence is computed at read time from the staleness policy.';
comment on column xpms.v_element_economics.element_id is 'Element.';
comment on column xpms.v_element_economics.item is 'Item name.';
comment on column xpms.v_element_economics.urid is 'Category URID.';
comment on column xpms.v_element_economics.unit_basis is 'Unit basis of the amount.';
comment on column xpms.v_element_economics.grade_code is 'Price grade code.';
comment on column xpms.v_element_economics.grade is 'Price grade label.';
comment on column xpms.v_element_economics.amount_minor is 'Amount in minor units; NULL means unpriced.';
comment on column xpms.v_element_economics.currency_code is 'Currency of the amount.';
comment on column xpms.v_element_economics.assertion_word is 'Stated economics assertion of the band.';
comment on column xpms.v_element_economics.valid_from is 'Date the band was sourced.';
comment on column xpms.v_element_economics.valid_to is 'Date the band stops applying.';
comment on column xpms.v_element_economics.effective_confidence is 'Confidence after staleness, or a refusal value.';
comment on column xpms.v_element_economics.is_unpriced is 'True when the element has no band at this grade.';

-- Crosswalk coverage per category -------------------------------------------------------

create view xpms.v_crosswalk_coverage
with (security_invoker = true)
as
select
  c.cat_urid,
  c.category,
  count(distinct e.element_id)::integer as element_count,
  (count(distinct e.element_id) filter (where e.unspsc is not null))::integer as unspsc_element_count,
  count(distinct g.element_id)::integer as gtin_element_count,
  count(g.gtin)::integer as gtin_count
from xpms.dim_category c
left join xpms.elements e on e.urid = c.cat_urid
left join xpms.element_gtins g on g.element_id = e.element_id
group by c.cat_urid, c.category
order by c.cat_urid;

comment on view xpms.v_crosswalk_coverage is
  'Identity crosswalk coverage per category (GTIN to GPC brick to UNSPSC to URID): how many elements carry an UNSPSC and how many have confirmed GTINs.';
comment on column xpms.v_crosswalk_coverage.cat_urid is 'Category URID.';
comment on column xpms.v_crosswalk_coverage.category is 'Category label.';
comment on column xpms.v_crosswalk_coverage.element_count is 'Elements in the category.';
comment on column xpms.v_crosswalk_coverage.unspsc_element_count is 'Elements carrying an UNSPSC identifier.';
comment on column xpms.v_crosswalk_coverage.gtin_element_count is 'Elements with at least one confirmed GTIN.';
comment on column xpms.v_crosswalk_coverage.gtin_count is 'Confirmed GTINs bound to elements of the category.';

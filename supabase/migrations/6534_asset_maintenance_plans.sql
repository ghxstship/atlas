-- 6534_asset_maintenance_plans.sql
-- B11 Maintenance schedules (RRR-235, G-95). app.asset_maintenance logs work done, and performed_on is NOT NULL and frozen
-- in v1 assetMaintenanceEvents, so work still to do cannot live there. A plan says what is due and how often, on one
-- unit or on every unit of a class; a log entry names the plan it fulfilled; the due date and status are computed.

create table app.asset_maintenance_plans (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  asset_unit_id uuid references app.asset_units (id),
  asset_class_id uuid references app.asset_classes (id),
  title text not null,
  instructions text,
  first_due_on date not null,
  every_count smallint,
  every_unit app.maintenance_interval_unit,
  deleted_at timestamptz,
  constraint asset_maintenance_plans_one_target check (num_nonnulls(asset_unit_id, asset_class_id) = 1),
  constraint asset_maintenance_plans_title_length check (char_length(btrim(title)) between 1 and 200),
  constraint asset_maintenance_plans_instructions_length check (instructions is null or char_length(btrim(instructions)) between 1 and 1000),
  constraint asset_maintenance_plans_every_range check (every_count is null or every_count between 1 and 999),
  constraint asset_maintenance_plans_every_pair check ((every_count is null) = (every_unit is null))
);
create index asset_maintenance_plans_unit_idx on app.asset_maintenance_plans (asset_unit_id);
create index asset_maintenance_plans_class_idx on app.asset_maintenance_plans (asset_class_id);

call private.install_domain_table('app.asset_maintenance_plans', null, null, array['app.asset_units', 'asset_unit_id', 'app.asset_classes', 'asset_class_id']);
call private.install_policies('app.asset_maintenance_plans',
  $$org_id in (select private.orgs_with_capability('assets.asset.read'))$$,
  $$org_id in (select private.orgs_with_capability('assets.maintenance.write'))$$);
call private.describe('app.asset_maintenance_plans', 'Maintenance to do (B11, G-95), on one unit or on every serviceable unit of a class: first due on a day, then every interval after the last time it was done, or once when the interval is NULL. A deleted plan goes to Trash. Due dates and status are computed (app.asset_maintenance_due).', array[
  'asset_unit_id', 'Unit the plan applies to; exactly one of the unit and the class.',
  'asset_class_id', 'Class whose units the plan applies to; exactly one of the unit and the class.',
  'title', 'What is to be done.',
  'instructions', 'How to do it.',
  'first_due_on', 'Day the work is first due.',
  'every_count', 'How many intervals between doing it; NULL with every_unit for work done once.',
  'every_unit', 'Unit of the interval; NULL with every_count for work done once.'
]);
call private.install_default_retention('app.asset_maintenance_plans');
call private.install_audit_trail('app.asset_maintenance_plans');
insert into private.field_history_subjects (table_name) values ('app.asset_maintenance_plans') on conflict do nothing;
insert into private.field_history_subjects (table_name) values ('app.asset_maintenance') on conflict do nothing;

alter table app.asset_maintenance add column maintenance_plan_id uuid references app.asset_maintenance_plans (id);
create index asset_maintenance_plan_idx on app.asset_maintenance (maintenance_plan_id);
comment on column app.asset_maintenance.maintenance_plan_id is 'Plan this work fulfilled (B11, G-95), on the plan''s unit or a unit of its class; NULL for work done off any plan.';
call private.add_cross_org_references('app.asset_maintenance', array['app.asset_maintenance_plans', 'maintenance_plan_id']);

create or replace function private.guard_asset_maintenance_plan_link()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.maintenance_plan_id is not null and not exists (
    select 1 from app.asset_maintenance_plans p
    join app.asset_units u on u.id = new.asset_unit_id
    where p.id = new.maintenance_plan_id and p.deleted_at is null
      and (p.asset_unit_id = u.id or p.asset_class_id = u.asset_class_id)) then
    perform private.refuse('maintenance_plan_unit', 'This plan does not cover this unit.');
  end if;
  return new;
end;
$$;
comment on function private.guard_asset_maintenance_plan_link() is 'Maintenance logged against a plan: a live plan on the unit or on the unit''s class (maintenance_plan_unit).';
revoke all on function private.guard_asset_maintenance_plan_link() from public, anon, authenticated;
create trigger t40_guard_asset_maintenance_plan_link before insert or update of maintenance_plan_id, asset_unit_id on app.asset_maintenance
  for each row execute function private.guard_asset_maintenance_plan_link();

create or replace function private.asset_unit_on_hire(p_asset_unit_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from app.asset_units u
    join app.receipt_lines rl on rl.id = u.receipt_line_id
    join app.po_lines pl on pl.id = rl.po_line_id
    where u.id = p_asset_unit_id and pl.acquisition_kind = 'Rental');
$$;
comment on function private.asset_unit_on_hire(uuid) is 'True when a unit arrived on a rental line, so it is the vendor''s. Says nothing of the order. Granted to signed-in callers because app.asset_maintenance_due, a security_invoker view, reads it for readers without procurement.po.read.';
revoke all on function private.asset_unit_on_hire(uuid) from public, anon;
grant execute on function private.asset_unit_on_hire(uuid) to authenticated, service_role;

create view app.asset_maintenance_due with (security_invoker = true) as
select x.plan_id, x.org_id, x.asset_unit_id, x.asset_tag, x.asset_class_id, x.class_name, x.title, x.instructions, x.first_due_on,
  x.every_count, x.every_unit, x.last_performed_on, x.due_on,
  case when x.due_on is null then 'Completed'
       when x.due_on < private.org_today(x.org_id) then 'Overdue'
       else 'Pending' end as due_status
from (
  select p.id as plan_id, p.org_id, u.id as asset_unit_id, u.asset_tag, u.asset_class_id, c.name as class_name, p.title, p.instructions,
    p.first_due_on, p.every_count, p.every_unit, d.last_performed_on,
    case when d.last_performed_on is null then p.first_due_on
         when p.every_count is null then null
         else (d.last_performed_on::timestamp + case p.every_unit
                when 'Day' then make_interval(days => p.every_count)
                when 'Week' then make_interval(weeks => p.every_count)
                when 'Month' then make_interval(months => p.every_count)
                else make_interval(years => p.every_count) end)::date end as due_on
  from app.asset_maintenance_plans p
  join app.asset_units u on u.deleted_at is null and (
    u.id = p.asset_unit_id
    or (u.asset_class_id = p.asset_class_id and u.asset_state not in ('Proposed', 'Lost', 'Retired', 'Returned')
        and not private.asset_unit_on_hire(u.id)))
  join app.asset_classes c on c.id = u.asset_class_id
  left join lateral (
    select max(m.performed_on) as last_performed_on from app.asset_maintenance m
    where m.maintenance_plan_id = p.id and m.asset_unit_id = u.id and m.deleted_at is null
  ) d on true
  where p.deleted_at is null
) x;

call private.describe('app.asset_maintenance_due', 'Maintenance due (B11, G-95): one row per plan and unit, a class plan expanding to its live units that are not Proposed, Lost, Retired or Returned and did not arrive on a rental line. Computed, never stored, and it runs as the reader.', array[
  'plan_id', 'Plan.',
  'org_id', 'Org.',
  'asset_unit_id', 'Unit.',
  'asset_tag', 'Unit''s asset tag.',
  'asset_class_id', 'Unit''s class.',
  'class_name', 'Name of the class.',
  'title', 'What is to be done.',
  'instructions', 'How to do it.',
  'first_due_on', 'Day the work is first due.',
  'every_count', 'How many intervals between doing it; NULL for work done once.',
  'every_unit', 'Unit of the interval; NULL for work done once.',
  'last_performed_on', 'Latest log entry of this plan on this unit.',
  'due_on', 'First due with no entry; last performed plus the interval when recurring; NULL when work done once is done.',
  'due_status', 'Completed (work done once is done), Overdue (before today on the org''s calendar) or Pending. A recurring plan never reads Completed: done work is the log.'
]);
revoke all on app.asset_maintenance_due from public, anon;
grant select on app.asset_maintenance_due to authenticated, service_role;
revoke select on app.asset_maintenance_due from xos_backup;

insert into private.comment_subjects (table_name) values ('app.asset_maintenance_plans') on conflict do nothing;

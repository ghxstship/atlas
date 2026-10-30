-- 2904_signs.sql
-- B1 Places depth on image plans (RRR-225; gap G-24; ADR 0140 D6 and D7). The signage register.
--
--   * A sign is its own record rather than a Supply record of subtype "Signage & Wayfinding" (0150): each one has a
--     place (a pin on a site plan of its project, or words), its artwork, its own production steps and a line on the
--     build sheet. It may name a canon category: Signage Panels, Directional Signage or Digital Signage.
--   * A sign stores only the facts signage owns (ADRs 0103 and 0104): Mark ordered (only without a purchase order
--     line), Mark printed and Mark placed, stamped by app.mark_sign_step. Whether it was ordered or received through
--     procurement is read from procurement's own rows in app.sign_production (2905), never copied here.
--   * No new capability (D7): signs follow the project, read with places.venue.read and written with
--     places.site_plan.write. Linking a purchase order line also needs procurement.po.read on the project, so a sign
--     writer cannot probe order lines. With a line linked, the printer is the order's vendor, shown to procurement
--     readers from the order, so a sign names its own printer only when no line is linked.

create type app.sign_type as enum ('Directional', 'Identification', 'Regulatory', 'Informational', 'Sponsor', 'Menu', 'Digital');
comment on type app.sign_type is 'What a sign does: Directional, Identification, Regulatory, Informational, Sponsor, Menu or Digital.';

create type app.sign_step as enum ('Ordered', 'Printed', 'Placed');
comment on type app.sign_step is 'A production step a person marks on a sign through app.mark_sign_step.';

create type app.sign_production_state as enum ('To Order', 'Ordered', 'Printed', 'Placed');
comment on type app.sign_production_state is 'Where a sign stands, computed in app.sign_production from the sign''s marks and procurement''s facts; never stored.';

insert into private.domain_event_types (code, subject, description) values
  ('sign.created', 'signs', 'A sign was added to a project''s signage register.'),
  ('sign.changed', 'signs', 'A sign''s text, type, size, quantity or place changed.'),
  ('sign.step_marked', 'signs', 'A sign was marked ordered, printed or placed, or a mark was undone.')
on conflict (code) do nothing;

create table app.signs (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  project_id uuid not null references app.projects (id),
  sign_number bigint not null default 0,
  title text not null,
  sign_type app.sign_type not null,
  urid text references xpms.dim_category (cat_urid),
  message text,
  quantity integer not null default 1,
  width_in numeric,
  height_in numeric,
  substrate text,
  double_sided boolean not null default false,
  site_plan_pin_id uuid references app.site_plan_pins (id),
  location_text text,
  printer_vendor_id uuid references app.vendors (id),
  po_line_id uuid references app.po_lines (id),
  artwork_version_id uuid references app.attachment_versions (id),
  needed_by date,
  ordered_at timestamptz,
  printed_at timestamptz,
  placed_at timestamptz,
  placed_by uuid references app.people (id),
  deleted_at timestamptz,
  constraint signs_title_length check (char_length(btrim(title)) between 1 and 200 and title = btrim(title)),
  constraint signs_message_length check (message is null or char_length(message) <= 2000),
  constraint signs_quantity_range check (quantity between 1 and 10000),
  constraint signs_size_range check ((width_in is null or (width_in > 0 and width_in <= 1200)) and (height_in is null or (height_in > 0 and height_in <= 1200))),
  constraint signs_substrate_length check (substrate is null or char_length(btrim(substrate)) between 1 and 100),
  constraint signs_location_length check (location_text is null or char_length(btrim(location_text)) between 1 and 300),
  constraint signs_urid_signage check (urid is null or urid in ('4000.05.01', '4000.05.02', '9000.09.01')),
  constraint signs_placed_pair check ((placed_at is null) = (placed_by is null)),
  constraint signs_placed_located check (placed_at is null or site_plan_pin_id is not null or location_text is not null),
  constraint signs_ordered_without_po check (ordered_at is null or po_line_id is null),
  constraint signs_printer_without_po check (po_line_id is null or printer_vendor_id is null)
);

create unique index signs_project_number_key on app.signs (project_id, sign_number);
create index signs_site_plan_pin_id_idx on app.signs (site_plan_pin_id);
create index signs_printer_vendor_id_idx on app.signs (printer_vendor_id);
create index signs_po_line_id_idx on app.signs (po_line_id);
create index signs_artwork_version_id_idx on app.signs (artwork_version_id);
create index signs_placed_by_idx on app.signs (placed_by);
create index signs_urid_idx on app.signs (urid);

call private.install_project_table('app.signs', 'places.venue.read', 'places.site_plan.write',
  array['app.site_plan_pins', 'site_plan_pin_id', 'app.vendors', 'printer_vendor_id', 'app.po_lines', 'po_line_id',
        'app.attachment_versions', 'artwork_version_id']);
call private.describe('app.signs', 'The signage register of a project (G-24, ADR 0140 D6): what each sign says, its size and material, where it goes and its production marks. Whether it is ordered, printed or placed is computed in app.sign_production; procurement''s facts are never copied here.', array[
  'project_id', 'Project. Never changes.',
  'sign_number', 'Sequence number within the project, issued on insert. The display key is {project_key}-SGN-{number}, read through app.sign_display_key.',
  'title', 'What the sign is, for example "Main entrance arrow".',
  'sign_type', 'Directional, Identification, Regulatory, Informational, Sponsor, Menu or Digital.',
  'urid', 'Canon category of the sign: 4000.05.01 Signage Panels, 4000.05.02 Directional Signage or 9000.09.01 Digital Signage.',
  'message', 'The text printed on the sign.',
  'quantity', 'How many identical signs this line is, 1 to 10000.',
  'width_in', 'Width in inches.',
  'height_in', 'Height in inches.',
  'substrate', 'Material it is printed on.',
  'double_sided', 'True when it is printed on both sides.',
  'site_plan_pin_id', 'Pin on a site plan of the same project where the sign goes.',
  'location_text', 'Where the sign goes, in words, when no pin says it.',
  'printer_vendor_id', 'Vendor that prints the sign, when no purchase order line is linked; with a line, the printer is the order''s vendor.',
  'po_line_id', 'Purchase order line of the same project the sign is ordered on; linking it needs procurement.po.read. A reference only.',
  'artwork_version_id', 'Artwork file: a version of an attachment on this sign.',
  'needed_by', 'The day the sign is needed in place.',
  'ordered_at', 'When a person marked the sign ordered, only when no purchase order line is linked. Set only by app.mark_sign_step.',
  'printed_at', 'When a person marked the sign printed. Set only by app.mark_sign_step.',
  'placed_at', 'When a person marked the sign placed. Set only by app.mark_sign_step.',
  'placed_by', 'Who marked the sign placed, from the session.'
]);
call private.install_default_retention('app.signs');
call private.install_audit_trail('app.signs');

insert into private.comment_subjects (table_name) values ('app.signs') on conflict do nothing;
insert into private.custom_field_targets (table_name) values ('app.signs') on conflict do nothing;

create or replace function private.guard_sign()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_other uuid;
  v_order app.purchase_orders;
begin
  if tg_op = 'UPDATE' then
    if new.project_id <> old.project_id then
      perform private.refuse('sign_project_immutable', 'A sign stays in its project.');
    end if;
    if new.sign_number <> old.sign_number then
      perform private.refuse('sign_number_immutable', 'A sign keeps its number.');
    end if;
  else
    new.sign_number := private.next_sequence(new.org_id, 'sign:' || new.project_id::text);
  end if;
  if not private.in_trusted_operation('sign_step') and (
    (tg_op = 'INSERT' and num_nonnulls(new.ordered_at, new.printed_at, new.placed_at, new.placed_by) > 0)
    or (tg_op = 'UPDATE' and (new.ordered_at, new.printed_at, new.placed_at, new.placed_by)
        is distinct from (old.ordered_at, old.printed_at, old.placed_at, old.placed_by))) then
    perform private.refuse('sign_step_rpc_only', 'Mark a sign ordered, printed or placed with its step actions.');
  end if;
  if new.site_plan_pin_id is not null and (tg_op = 'INSERT' or new.site_plan_pin_id is distinct from old.site_plan_pin_id) then
    select p.project_id into v_other from app.site_plan_pins pin join app.site_plans p on p.id = pin.site_plan_id
    where pin.id = new.site_plan_pin_id and pin.deleted_at is null and p.deleted_at is null;
    if v_other is distinct from new.project_id then
      perform private.refuse('sign_pin_project', 'Place the sign on a pin of a site plan of its own project.');
    end if;
  end if;
  -- The order line is checked when it is linked or changed, so a sign whose order is later canceled stays editable.
  if new.po_line_id is not null and (tg_op = 'INSERT' or new.po_line_id is distinct from old.po_line_id) then
    if new.ordered_at is not null then
      perform private.refuse('sign_ordered_manually', 'This sign is marked ordered. Undo Mark ordered first, then link the order line.');
    end if;
    if not private.can_on_project(new.project_id, 'procurement.po.read') then
      perform private.refuse('sign_po_line_read', 'Linking a purchase order line needs access to the project''s purchase orders.');
    end if;
    select po.* into v_order from app.po_lines l join app.purchase_orders po on po.id = l.purchase_order_id
    where l.id = new.po_line_id and l.deleted_at is null and po.deleted_at is null;
    if v_order.id is null or v_order.project_id <> new.project_id or v_order.po_state = 'Canceled' then
      perform private.refuse('sign_po_line_project', 'Link a line of a purchase order of this project that is not canceled.');
    end if;
  end if;
  if new.artwork_version_id is not null and (tg_op = 'INSERT' or new.artwork_version_id is distinct from old.artwork_version_id) then
    if not exists (
      select 1 from app.attachment_versions v join app.attachments a on a.id = v.attachment_id
      where v.id = new.artwork_version_id and v.deleted_at is null and a.deleted_at is null
        and a.subject_table = 'app.signs' and a.subject_id = new.id) then
      perform private.refuse('sign_artwork_subject', 'The artwork is a file attached to this sign.');
    end if;
  end if;
  return new;
end;
$$;

comment on function private.guard_sign() is 'Signs: number issued on insert, project and number immutable, step stamps only through app.mark_sign_step (sign_step_rpc_only), the pin on a plan of the same project (sign_pin_project), a linked order line on a live, uncanceled order of the same project and linked only by a reader of its orders and never over a manual order mark (sign_po_line_project, sign_po_line_read, sign_ordered_manually), and the artwork a file on the sign (sign_artwork_subject).';
revoke all on function private.guard_sign() from public, anon, authenticated;
create trigger t40_guard_sign before insert or update on app.signs
  for each row execute function private.guard_sign();

create trigger t90_emit_sign_created after insert on app.signs
  for each row execute function private.emit_row_event('sign.created', 'project_id', 'sign_number', 'title', 'sign_type');
create trigger t90_emit_sign_changed after update on app.signs
  for each row when (old.deleted_at is not distinct from new.deleted_at
    and (old.title, old.sign_type, old.message, old.quantity, old.width_in, old.height_in, old.substrate, old.site_plan_pin_id, old.location_text)
      is distinct from (new.title, new.sign_type, new.message, new.quantity, new.width_in, new.height_in, new.substrate, new.site_plan_pin_id, new.location_text))
  execute function private.emit_row_event('sign.changed', 'project_id', 'sign_number', 'title');

-- RPCs ---------------------------------------------------------------------------------------------------------------------

create or replace function app.mark_sign_step(p_sign_id uuid, p_step app.sign_step, p_done boolean default true)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_sign app.signs;
  v_person uuid;
begin
  v_person := private.require_person();
  select * into v_sign from app.signs s where s.id = p_sign_id and s.deleted_at is null;
  if v_sign.id is null or not private.can_on_project(v_sign.project_id, 'places.site_plan.write') then
    raise exception using errcode = '42501', message = 'places.site_plan.write is required on the sign';
  end if;
  if p_step = 'Ordered' and v_sign.po_line_id is not null then
    perform private.refuse('sign_ordered_by_po', 'This sign is ordered through its purchase order line.');
  end if;
  if p_step = 'Placed' and coalesce(p_done, true) and v_sign.location_text is null and not exists (
    select 1 from app.site_plan_pins pin join app.site_plans p on p.id = pin.site_plan_id
    where pin.id = v_sign.site_plan_pin_id and pin.deleted_at is null and p.deleted_at is null) then
    perform private.refuse('sign_placed_needs_location', 'Give the sign a pin or a location before you mark it placed.');
  end if;
  perform private.begin_trusted_operation('sign_step');
  update app.signs s set
    ordered_at = case when p_step = 'Ordered' then case when coalesce(p_done, true) then coalesce(s.ordered_at, now()) end else s.ordered_at end,
    printed_at = case when p_step = 'Printed' then case when coalesce(p_done, true) then coalesce(s.printed_at, now()) end else s.printed_at end,
    placed_at = case when p_step = 'Placed' then case when coalesce(p_done, true) then coalesce(s.placed_at, now()) end else s.placed_at end,
    placed_by = case when p_step = 'Placed' then case when coalesce(p_done, true) then coalesce(s.placed_by, v_person) end else s.placed_by end
  where s.id = p_sign_id;
  perform private.end_trusted_operation('sign_step');
  perform private.emit_event(v_sign.org_id, 'sign.step_marked', 'signs', p_sign_id, v_sign.project_id,
    jsonb_build_object('step', p_step, 'done', coalesce(p_done, true)));
  return p_sign_id;
end;
$$;

comment on function app.mark_sign_step(uuid, app.sign_step, boolean) is 'Marks a sign ordered, printed or placed with the database time (placed also with the session person), or undoes the mark when p_done is false. Mark ordered is refused once a purchase order line is linked (sign_ordered_by_po); Mark placed needs a live pin or a location (sign_placed_needs_location). Needs places.site_plan.write on the project. Returns the sign id.';
revoke all on function app.mark_sign_step(uuid, app.sign_step, boolean) from public, anon;
grant execute on function app.mark_sign_step(uuid, app.sign_step, boolean) to authenticated, service_role;

create or replace function app.sign_display_key(p_sign app.signs)
returns text
language sql
stable
security invoker
set search_path = ''
as $$
  select p.project_key || '-SGN-' || p_sign.sign_number::text from app.projects p where p.id = p_sign.project_id;
$$;

comment on function app.sign_display_key(app.signs) is 'Computed field: the sign''s display key {project_key}-SGN-{number}. Runs with the caller''s rights.';
revoke all on function app.sign_display_key(app.signs) from public, anon;
grant execute on function app.sign_display_key(app.signs) to authenticated, service_role;

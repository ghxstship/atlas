-- 0970_dock_slot_engagements.sql
-- A11 Logistics late slot (0970 to 0974, broadcast 1 section 6): a dock slot may name the vendor
-- engagement it serves, so Compass and Gateway can show a vendor its own load-in and load-out windows
-- (Section 4.5.7). Lives after 0700 because app.engagements is created there.

alter table app.dock_slots add column engagement_id uuid references app.engagements (id);
create index dock_slots_engagement_id_idx on app.dock_slots (engagement_id);
comment on column app.dock_slots.engagement_id is 'Vendor engagement of the same project the slot serves, when one does.';

-- The cross-org reference guard now covers the engagement as well as the zone and shipment.
drop trigger if exists t30_refuse_cross_org_reference on app.dock_slots;
create trigger t30_refuse_cross_org_reference before insert or update on app.dock_slots
  for each row execute function private.refuse_cross_org_reference(
    'app.zones', 'zone_id', 'app.shipments', 'shipment_id', 'app.engagements', 'engagement_id');

create trigger t39_dock_slot_engagement_project before insert or update on app.dock_slots
  for each row execute function private.assert_same_project('app.engagements', 'engagement_id');

drop trigger if exists t90_emit_dock_slot_booked on app.dock_slots;
create trigger t90_emit_dock_slot_booked after insert on app.dock_slots
  for each row execute function private.emit_row_event('dock_slot.booked', 'project_id', 'zone_id', 'shipment_id', 'engagement_id', 'starts_at', 'ends_at');
drop trigger if exists t90_emit_dock_slot_checked_in on app.dock_slots;
create trigger t90_emit_dock_slot_checked_in after update of checked_in_at on app.dock_slots
  for each row when (old.checked_in_at is null and new.checked_in_at is not null)
  execute function private.emit_subject_event('dock_slot.checked_in', 'dock_slots', 'id', 'zone_id', 'shipment_id', 'engagement_id', 'checked_in_at');

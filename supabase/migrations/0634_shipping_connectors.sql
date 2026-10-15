-- 0634_shipping_connectors.sql
-- A19 Integrations. Carrier tracking (Section 17: UPS, FedEx and DHL on shipments), the interface A11's logistics
-- pages read:
--   * app.shipment_trackers: a shipment followed through one carrier connection, with its latest normalized status,
--     estimated delivery and delivery time. Logistics writers start and stop tracking; only the runner writes status.
--   * app.shipment_tracking_events: the append-only scan history the carrier reported, normalized
--   * app.record_tracking_update: the runner's idempotent write of a carrier response
-- Rows follow the shipment's project under invariant 2 (logistics.shipment.read and logistics.shipment.write).

create type app.tracking_status as enum ('Label Created', 'In Transit', 'Out for Delivery', 'Delivered', 'Exception', 'Returned', 'Unknown');
comment on type app.tracking_status is 'Carrier tracking status normalized across UPS, FedEx and DHL (a delivery status, ADR 0002).';

insert into private.domain_event_types (code, subject, description) values
  ('shipment.delivered', 'shipment_trackers', 'A carrier reported a tracked shipment delivered.'),
  ('shipment.tracking_exception', 'shipment_trackers', 'A carrier reported an exception on a tracked shipment.');

create table app.shipment_trackers (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  shipment_id uuid not null references app.shipments (id),
  integration_connection_id uuid not null references app.integration_connections (id),
  tracking_number text not null,
  tracking_status app.tracking_status not null default 'Unknown',
  carrier_status_text text,
  estimated_delivery_at timestamptz,
  delivered_at timestamptz,
  last_checked_at timestamptz,
  deleted_at timestamptz,
  constraint shipment_trackers_number_format check (tracking_number ~ '^[A-Za-z0-9]{6,40}$'),
  constraint shipment_trackers_status_text_length check (carrier_status_text is null or char_length(carrier_status_text) <= 500),
  constraint shipment_trackers_delivered check ((tracking_status = 'Delivered') = (delivered_at is not null))
);

create index shipment_trackers_shipment_id_idx on app.shipment_trackers (shipment_id);
create index shipment_trackers_connection_idx on app.shipment_trackers (integration_connection_id);
create unique index shipment_trackers_shipment_key on app.shipment_trackers (shipment_id) where deleted_at is null;

call private.install_domain_table('app.shipment_trackers', 'app.shipments', 'shipment_id', array['app.integration_connections', 'integration_connection_id']);
call private.describe('app.shipment_trackers', 'A shipment followed through one carrier connection (UPS, FedEx or DHL): the latest normalized status, estimated delivery and delivery time. One live tracker per shipment. Logistics writers start and stop tracking; only the integration runner writes status.', array[
  'shipment_id', 'Shipment tracked.',
  'integration_connection_id', 'Carrier connection that reports it.',
  'tracking_number', 'Carrier tracking number, from the shipment unless given.',
  'tracking_status', 'Latest normalized status. Written by the runner.',
  'carrier_status_text', 'Latest status as the carrier words it. Written by the runner.',
  'estimated_delivery_at', 'Carrier''s estimated delivery. Written by the runner.',
  'delivered_at', 'When the carrier reported delivery. Written by the runner.',
  'last_checked_at', 'When the runner last asked the carrier.'
]);

call private.install_policies('app.shipment_trackers',
  $$exists (select 1 from app.shipments s where s.id = shipment_id
     and s.project_id = any (array(select private.project_ids_with('logistics.shipment.read'))))$$,
  $$exists (select 1 from app.shipments s where s.id = shipment_id
     and s.project_id = any (array(select private.project_ids_with('logistics.shipment.write'))))$$);

create or replace function private.guard_shipment_tracker()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.tracking_number is null then
      new.tracking_number := (select s.tracking_identifier from app.shipments s where s.id = new.shipment_id);
      if new.tracking_number is null then
        perform private.refuse('tracking_number_required', 'Add the carrier tracking number to the shipment before tracking it.');
      end if;
    end if;
    if (select c.connection_state from app.integration_connections c where c.id = new.integration_connection_id) <> 'Connected' then
      perform private.refuse('integration_not_connected', 'Track shipments through a Connected carrier connection.');
    end if;
  elsif new.shipment_id <> old.shipment_id or new.integration_connection_id <> old.integration_connection_id or new.tracking_number <> old.tracking_number then
    perform private.refuse('shipment_tracker_fixed', 'A tracker keeps its shipment, carrier and number; stop it and start another.');
  end if;
  if not private.in_trusted_operation('integration_tracking')
     and (tg_op = 'INSERT' or new.tracking_status is distinct from old.tracking_status or new.carrier_status_text is distinct from old.carrier_status_text
       or new.estimated_delivery_at is distinct from old.estimated_delivery_at or new.delivered_at is distinct from old.delivered_at
       or new.last_checked_at is distinct from old.last_checked_at) then
    if tg_op = 'INSERT' then
      new.tracking_status := 'Unknown';
      new.carrier_status_text := null;
      new.estimated_delivery_at := null;
      new.delivered_at := null;
      new.last_checked_at := null;
    else
      perform private.refuse('tracking_runner_only', 'Tracking status is written only by the carrier connection.');
    end if;
  end if;
  return new;
end;
$$;

comment on function private.guard_shipment_tracker() is 'Trackers: the number defaults to the shipment''s, a Connected carrier connection is required, shipment, carrier and number are fixed, and only the runner writes status.';

create trigger t40_guard_shipment_tracker before insert or update on app.shipment_trackers
  for each row execute function private.guard_shipment_tracker();
create trigger t41_guard_shipment_tracker_category before insert or update of integration_connection_id on app.shipment_trackers
  for each row execute function private.guard_integration_category('Shipping');

create table app.shipment_tracking_events (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  shipment_tracker_id uuid not null references app.shipment_trackers (id),
  tracking_status app.tracking_status not null,
  carrier_status_code text not null,
  description text not null,
  location_text text,
  occurred_at timestamptz not null,
  constraint shipment_tracking_events_code_length check (char_length(carrier_status_code) between 1 and 50),
  constraint shipment_tracking_events_description_length check (char_length(btrim(description)) between 1 and 500),
  constraint shipment_tracking_events_location_length check (location_text is null or char_length(location_text) <= 200)
);

create unique index shipment_tracking_events_scan_key on app.shipment_tracking_events (shipment_tracker_id, occurred_at, carrier_status_code);

call private.install_domain_table('app.shipment_tracking_events', 'app.shipment_trackers', 'shipment_tracker_id', '{}', true);
call private.describe('app.shipment_tracking_events', 'Append-only carrier scan history of a tracked shipment, normalized. A scan is recorded once.', array[
  'shipment_tracker_id', 'Tracker the scan belongs to.',
  'tracking_status', 'Normalized status of the scan.',
  'carrier_status_code', 'Carrier''s own status code.',
  'description', 'Scan description as the carrier words it.',
  'location_text', 'Where the scan happened.',
  'occurred_at', 'When the scan happened.'
]);

call private.install_policies('app.shipment_tracking_events',
  $$exists (select 1 from app.shipment_trackers t join app.shipments s on s.id = t.shipment_id
     where t.id = shipment_tracker_id and s.project_id = any (array(select private.project_ids_with('logistics.shipment.read'))))$$);

create or replace function app.record_tracking_update(
  p_tracker_id uuid,
  p_status app.tracking_status,
  p_status_text text,
  p_estimated_delivery_at timestamptz,
  p_delivered_at timestamptz,
  p_events jsonb
)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_tracker app.shipment_trackers;
  v_added integer;
begin
  select * into v_tracker from app.shipment_trackers t where t.id = p_tracker_id and t.deleted_at is null for update;
  if v_tracker.id is null then
    perform private.refuse('shipment_tracker_unknown', 'The tracker does not exist or was stopped.');
  end if;
  if jsonb_typeof(coalesce(p_events, '[]'::jsonb)) <> 'array' then
    perform private.refuse('tracking_events_malformed', 'Tracking events arrive as a list.');
  end if;
  with incoming as (
    select (e ->> 'status')::app.tracking_status as status, left(e ->> 'code', 50) as code, left(e ->> 'description', 500) as description,
      left(e ->> 'location', 200) as location, (e ->> 'occurred_at')::timestamptz as occurred_at
    from jsonb_array_elements(coalesce(p_events, '[]'::jsonb)) e
  ), inserted as (
    insert into app.shipment_tracking_events (shipment_tracker_id, tracking_status, carrier_status_code, description, location_text, occurred_at)
    select p_tracker_id, i.status, i.code, coalesce(nullif(btrim(i.description), ''), i.code), i.location, i.occurred_at from incoming i
    on conflict (shipment_tracker_id, occurred_at, carrier_status_code) do nothing
    returning 1
  )
  select count(*) into v_added from inserted;
  perform private.begin_trusted_operation('integration_tracking');
  update app.shipment_trackers
  set tracking_status = p_status, carrier_status_text = left(p_status_text, 500), estimated_delivery_at = p_estimated_delivery_at,
      delivered_at = case when p_status = 'Delivered' then coalesce(p_delivered_at, delivered_at, now()) end, last_checked_at = now()
  where id = p_tracker_id;
  perform private.end_trusted_operation('integration_tracking');
  if p_status is distinct from v_tracker.tracking_status and p_status in ('Delivered', 'Exception') then
    perform private.emit_event(v_tracker.org_id, case when p_status = 'Delivered' then 'shipment.delivered' else 'shipment.tracking_exception' end,
      'shipment_trackers', v_tracker.id, (select s.project_id from app.shipments s where s.id = v_tracker.shipment_id),
      jsonb_build_object('shipment_id', v_tracker.shipment_id, 'tracking_status', p_status));
  end if;
  return v_added;
end;
$$;

comment on function app.record_tracking_update(uuid, app.tracking_status, text, timestamptz, timestamptz, jsonb) is 'Runner: records a carrier response: new scans once each (a provider payload list of status, code, description, location and occurred_at), the latest status, estimate and delivery time, and a domain event when the shipment is delivered or hits an exception. Returns the number of new scans. Service role only.';

revoke all on function private.guard_shipment_tracker() from public, anon, authenticated;
revoke all on function app.record_tracking_update(uuid, app.tracking_status, text, timestamptz, timestamptz, jsonb) from public, anon, authenticated;
grant execute on function app.record_tracking_update(uuid, app.tracking_status, text, timestamptz, timestamptz, jsonb) to service_role;

call private.install_default_retention('app.shipment_trackers');
call private.install_default_retention('app.shipment_tracking_events');

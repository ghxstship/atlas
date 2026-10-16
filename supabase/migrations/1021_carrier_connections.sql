-- 1021_carrier_connections.sql
-- A32 Gateway and Compass follow-up (RRR-76), late slot. Atlas's shipment record starts carrier tracking (A19 0634)
-- through a Connected UPS, FedEx or DHL connection, but app.integration_connections is readable only with
-- org.integrations.manage. A logistics writer who may track a shipment needs to choose the carrier, so
-- app.carrier_connections lists just the id, provider and display name of the org's Connected Shipping connections
-- to people who manage integrations or write shipments on a project of the org. Credentials, settings and every
-- other connection never appear.

create or replace function app.carrier_connections(p_org_id uuid)
returns table (id uuid, provider_code text, display_name text)
language sql
stable
security definer
set search_path = ''
as $$
  select c.id, c.provider_code, c.display_name
  from app.integration_connections c
  join private.integration_providers p on p.provider_code = c.provider_code
  where c.org_id = p_org_id and c.deleted_at is null and c.connection_state = 'Connected' and p.category = 'Shipping'
    and (private.has_capability(p_org_id, 'org.integrations.manage')
      or exists (select 1 from private.project_ids_with('logistics.shipment.write') x
                 join app.projects pr on pr.id = x where pr.org_id = p_org_id))
  order by p.sort_order, c.display_name, c.id;
$$;

comment on function app.carrier_connections(uuid) is 'The org''s Connected carrier connections (Shipping category: UPS, FedEx, DHL) as id, provider and display name, for choosing the carrier that tracks a shipment. Empty unless the caller manages integrations or writes shipments on a project of the org.';

revoke all on function app.carrier_connections(uuid) from public, anon;
grant execute on function app.carrier_connections(uuid) to authenticated, service_role;

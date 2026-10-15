-- 0632_payroll_handoff.sql
-- A19 Integrations. Payroll handoff (Section 17: Gusto, ADP and Rippling) over A13's payroll export (0461):
--   * a person with crew.payroll.export, data.export.restricted and step-up authentication produces the export of an
--     Approved run for a provider (app.produce_payroll_export); that act authorizes handing that file to that provider
--   * app.payroll_export_for_handoff gives the runner the file of the run's latest export for the connection's provider,
--     re-rendered and checked against its checksum, so the provider receives exactly the bytes the person exported
--   * the run is queued as a Payroll Export sync run whose subject is the payroll run; the handoff is recorded in the
--     external identifier map with the file checksum, so the same file is never pushed twice
-- Employees and earning codes map through app.integration_external_ids (Membership and Earning Code).

create or replace function app.payroll_export_for_handoff(p_connection_id uuid, p_payroll_run_id uuid)
returns table (payroll_export_id uuid, provider text, checksum_sha256 text, content text, pay_period_start date, pay_period_end date)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_connection app.integration_connections;
  v_category app.integration_category;
  v_run app.payroll_runs;
  v_export app.payroll_exports;
  v_content text;
  v_period app.pay_periods;
begin
  select * into v_connection from app.integration_connections c where c.id = p_connection_id and c.deleted_at is null;
  if v_connection.id is null or v_connection.connection_state <> 'Connected' then
    perform private.refuse('integration_not_connected', 'Only a Connected connection can sync.');
  end if;
  select p.category into v_category from private.integration_providers p where p.provider_code = v_connection.provider_code;
  if v_category <> 'Payroll' then
    perform private.refuse('integration_category_mismatch', 'Payroll exports go only to a payroll connection.');
  end if;
  select * into v_run from app.payroll_runs r where r.id = p_payroll_run_id and r.deleted_at is null;
  if v_run.id is null or v_run.org_id <> v_connection.org_id then
    raise exception using errcode = '42501', message = 'payroll run not found';
  end if;
  if v_run.payroll_run_state not in ('Exported', 'Accepted') then
    perform private.refuse('payroll_run_not_exported', 'Produce the payroll export for this provider before handing it off.');
  end if;
  perform private.assert_payroll_export_plan(v_run.org_id);
  select * into v_export from app.payroll_exports x
  where x.payroll_run_id = p_payroll_run_id and x.deleted_at is null and lower(x.provider) = v_connection.provider_code
  order by x.created_at desc limit 1;
  if v_export.id is null then
    perform private.refuse('payroll_export_missing', format('No export of this run was produced for %s.', v_connection.provider_code));
  end if;
  v_content := private.render_payroll_export(p_payroll_run_id);
  if encode(extensions.digest(v_content, 'sha256'), 'hex') <> v_export.checksum_sha256 then
    perform private.refuse('payroll_export_changed', 'The payroll lines changed since this file was produced; produce a new export.');
  end if;
  select * into v_period from app.pay_periods p where p.id = v_run.pay_period_id;
  return query select v_export.id, v_export.provider, v_export.checksum_sha256, v_content, v_period.starts_on, v_period.ends_on;
end;
$$;

comment on function app.payroll_export_for_handoff(uuid, uuid) is 'Runner: the latest export of an Exported payroll run produced for the connection''s provider, re-rendered and checked against its checksum. The person who produced it authorized the handoff (crew.payroll.export, restricted export, step-up). Service role only.';

revoke all on function app.payroll_export_for_handoff(uuid, uuid) from public, anon, authenticated;
grant execute on function app.payroll_export_for_handoff(uuid, uuid) to service_role;

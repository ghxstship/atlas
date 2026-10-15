-- 0992_shared_reports_self_billing.sql
-- A15 Finance and Reports, late slot (ADR 0022: both features reference A28's engagements and A18's report
-- runs). Two features external parties reach through Gateway:
--   * shared reports (Section 4.5.8 Client tab Reports, A28b group 8): the org shares a finished report run
--     with one engagement until it expires or is revoked. Rows are written only through the RPCs; the
--     api_external projection belongs to A28's 1000s range and builds on private.shared_report_open.
--   * self-billing (Section 4.4.5): the org generates a payable invoice on the party's behalf from the
--     engagement's approved timesheets, only while the org (or project) enables it and the party holds a live
--     self_billing_agreements row (A28b, 0774). Each timesheet is billed once unless its invoice is canceled.

insert into private.domain_event_types (code, subject, description) values
  ('report.shared', 'shared_reports', 'A report run was shared with an engagement.'),
  ('report.share_revoked', 'shared_reports', 'A shared report was revoked.'),
  ('invoice.self_billed', 'invoices', 'A payable invoice was generated from approved timesheets under a self-billing agreement.');

-- Shared reports -------------------------------------------------------------------------------------------

create table app.shared_reports (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  engagement_id uuid not null references app.engagements (id),
  project_id uuid not null references app.projects (id),
  report_run_id uuid not null references app.report_runs (id),
  title text not null,
  expires_at timestamptz,
  revoked_at timestamptz,
  revoked_by uuid references app.people (id),
  deleted_at timestamptz,
  constraint shared_reports_title_length check (char_length(btrim(title)) between 1 and 200),
  constraint shared_reports_revoke_pair check ((revoked_at is null) = (revoked_by is null))
);

create index shared_reports_engagement_id_idx on app.shared_reports (engagement_id);
create index shared_reports_project_id_idx on app.shared_reports (project_id);
create index shared_reports_report_run_id_idx on app.shared_reports (report_run_id);
create index shared_reports_revoked_by_idx on app.shared_reports (revoked_by);
create unique index shared_reports_live_key on app.shared_reports (report_run_id, engagement_id) where revoked_at is null and deleted_at is null;

call private.install_domain_table('app.shared_reports', 'app.engagements', 'engagement_id', array['app.projects', 'project_id', 'app.report_runs', 'report_run_id']);
call private.describe('app.shared_reports', 'Report runs shared with one engagement (Section 4.5.8 Client Reports). Written only by app.share_report and app.revoke_shared_report; a revoked or expired share stays as evidence and no longer opens.', array[
  'engagement_id', 'Engagement the report is shared with.',
  'project_id', 'Project of the engagement.',
  'report_run_id', 'Finished report run shared; its file is what the party sees.',
  'title', 'Title the party sees.',
  'expires_at', 'When the share stops opening; NULL while open-ended.',
  'revoked_at', 'When the org revoked the share.',
  'revoked_by', 'Person who revoked it.'
]);

create or replace function private.shared_report_open(p_engagement_id uuid, p_expires_at timestamptz, p_revoked_at timestamptz, p_deleted_at timestamptz)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_revoked_at is null and p_deleted_at is null and (p_expires_at is null or p_expires_at > now())
    and p_engagement_id in (select private.my_engagement_ids('engagement'));
$$;

comment on function private.shared_report_open(uuid, timestamptz, timestamptz, timestamptz) is 'Section 8.7: true when the signed-in person reaches the engagement area of the share''s engagement and the share is neither revoked, expired nor deleted. Takes the row''s column values (ADR 0016).';
revoke all on function private.shared_report_open(uuid, timestamptz, timestamptz, timestamptz) from public, anon;
grant execute on function private.shared_report_open(uuid, timestamptz, timestamptz, timestamptz) to authenticated, service_role;

call private.install_policies('app.shared_reports',
  $$org_id in (select private.orgs_with_capability('reports.report.read'))
    or private.shared_report_open(engagement_id, expires_at, revoked_at, deleted_at)$$);

create or replace function app.share_report(p_report_run_id uuid, p_engagement_id uuid, p_title text, p_expires_at timestamptz default null)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_run app.report_runs;
  v_engagement app.engagements;
  v_id uuid;
begin
  perform private.require_person();
  select r.* into v_run from app.report_runs r where r.id = p_report_run_id and r.deleted_at is null;
  select e.* into v_engagement from app.engagements e where e.id = p_engagement_id and e.deleted_at is null;
  if v_run.id is null or v_engagement.id is null or v_run.org_id <> v_engagement.org_id
     or not private.has_capability(v_run.org_id, 'reports.report.export')
     or v_run.run_for_membership_id not in (select private.my_membership_ids()) then
    raise exception using errcode = '42501', message = 'reports.report.export and a run of your own are required';
  end if;
  if v_run.run_status <> 'Succeeded' then
    perform private.refuse('report_run_unfinished', 'Only a finished report run can be shared; wait for the run to succeed.');
  end if;
  if p_expires_at is not null and p_expires_at <= now() then
    perform private.refuse('share_expiry_past', 'A share expires in the future; choose a later date or none.');
  end if;
  insert into app.shared_reports (org_id, engagement_id, project_id, report_run_id, title, expires_at)
  values (v_engagement.org_id, v_engagement.id, v_engagement.project_id, v_run.id, btrim(p_title), p_expires_at)
  returning id into v_id;
  perform private.emit_event(v_engagement.org_id, 'report.shared', 'shared_reports', v_id, v_engagement.project_id,
    jsonb_build_object('engagement_id', v_engagement.id, 'report_run_id', v_run.id, 'title', btrim(p_title)));
  return v_id;
end;
$$;

comment on function app.share_report(uuid, uuid, text, timestamptz) is 'Shares a finished report run the caller ran with one engagement of the same org. Needs reports.report.export. A run uses its runner''s access, so only the runner shares it. Returns the share id.';

create or replace function app.revoke_shared_report(p_shared_report_id uuid)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_share app.shared_reports;
begin
  perform private.require_person();
  select s.* into v_share from app.shared_reports s where s.id = p_shared_report_id and s.deleted_at is null for update;
  if v_share.id is null or not private.has_capability(v_share.org_id, 'reports.report.export') then
    raise exception using errcode = '42501', message = 'reports.report.export is required';
  end if;
  if v_share.revoked_at is not null then
    perform private.refuse('share_already_revoked', 'This report is no longer shared.');
  end if;
  update app.shared_reports set revoked_at = now(), revoked_by = private.current_person_id() where id = p_shared_report_id;
  perform private.emit_event(v_share.org_id, 'report.share_revoked', 'shared_reports', v_share.id, v_share.project_id,
    jsonb_build_object('engagement_id', v_share.engagement_id));
  return v_share.id;
end;
$$;

comment on function app.revoke_shared_report(uuid) is 'Stops a shared report from opening for its engagement. Needs reports.report.export. The row stays as evidence.';

-- Self-billing ---------------------------------------------------------------------------------------------

create table app.self_billed_timesheets (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  invoice_line_id uuid not null references app.invoice_lines (id),
  timesheet_id uuid not null references app.timesheets (id),
  constraint self_billed_timesheets_line_key unique (invoice_line_id)
);

create index self_billed_timesheets_timesheet_id_idx on app.self_billed_timesheets (timesheet_id);

call private.install_domain_table('app.self_billed_timesheets', 'app.invoice_lines', 'invoice_line_id', array['app.timesheets', 'timesheet_id'], true);
call private.describe('app.self_billed_timesheets', 'Append-only link from each self-billed invoice line to the approved timesheet it bills, so a timesheet is billed once while its invoice stands.', array[
  'invoice_line_id', 'Invoice line generated for the timesheet.',
  'timesheet_id', 'Approved timesheet billed.'
]);

call private.install_policies('app.self_billed_timesheets',
  $$exists (select 1 from app.invoice_lines l join app.invoices i on i.id = l.invoice_id
      where l.id = invoice_line_id and i.project_id in (select private.project_ids_with('finance.invoice.read')))$$);

create or replace function app.generate_self_billed_invoice(p_engagement_id uuid, p_period_start date, p_period_end date)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_engagement app.engagements;
  v_enabled boolean;
  v_invoice uuid;
  v_line uuid;
  v_number integer := 0;
  v_urid text;
  v_currency text;
  r record;
begin
  perform private.require_person();
  select e.* into v_engagement from app.engagements e where e.id = p_engagement_id and e.deleted_at is null;
  if v_engagement.id is null or not private.can_on_project(v_engagement.project_id, 'finance.invoice.write') then
    raise exception using errcode = '42501', message = 'finance.invoice.write is required on the project';
  end if;
  select s.value_boolean into v_enabled
  from app.resolve_settings(v_engagement.org_id, v_engagement.project_id) s where s.setting_key = 'finance.self_billing_enabled';
  if v_enabled is not true then
    perform private.refuse('self_billing_disabled', 'Self-billing is off for this project; turn it on in Legal Entities and Fiscal settings first.');
  end if;
  if not exists (select 1 from app.self_billing_agreements a
                 where a.engagement_id = p_engagement_id and a.revoked_at is null and a.deleted_at is null) then
    perform private.refuse('self_billing_not_agreed', 'The party has not agreed to self-billing on this engagement; they agree in Gateway.');
  end if;
  if v_engagement.counterparty_id is null then
    perform private.refuse('invoice_needs_account', 'Self-billed invoices bill an external account; the engagement has none.');
  end if;
  if p_period_start is null or p_period_end is null or p_period_end < p_period_start then
    perform private.refuse('self_billing_period', 'Choose a period whose end is on or after its start.');
  end if;
  v_currency := coalesce(v_engagement.currency_code,
    (select s.value_text from app.resolve_settings(v_engagement.org_id) s where s.setting_key = 'org.base_currency'));
  if v_currency is null then
    perform private.refuse('self_billing_currency', 'The engagement has no currency; set its rate and currency first.');
  end if;
  select d.disc_code into v_urid from xpms.role ro join xpms.dim_discipline d on d.disc_code = left(ro.role_code, 7)
  where ro.role_code = v_engagement.role_code;

  for r in
    select t.id, t.period_start, t.period_end, h.worked_minutes,
      (select count(distinct (te.clock_in at time zone p.time_zone)::date) from app.time_entries te
       where te.engagement_id = t.engagement_id and te.deleted_at is null and te.clock_out is not null
         and (te.clock_in at time zone p.time_zone)::date between t.period_start and t.period_end) as worked_days
    from app.timesheets t
    join app.projects p on p.id = t.project_id
    join app.timesheet_hours h on h.timesheet_id = t.id
    where t.engagement_id = p_engagement_id and t.deleted_at is null and t.timesheet_state = 'Approved'
      and t.period_start >= p_period_start and t.period_end <= p_period_end
      and not exists (
        select 1 from app.self_billed_timesheets b
        join app.invoice_lines l on l.id = b.invoice_line_id
        join app.invoices i on i.id = l.invoice_id
        where b.timesheet_id = t.id and l.deleted_at is null and i.deleted_at is null and i.invoice_state <> 'Canceled')
    order by t.period_start
  loop
    if v_invoice is null then
      insert into app.invoices (org_id, project_id, direction, counterparty_id, invoice_number, issued_on, currency_code)
      values (v_engagement.org_id, v_engagement.project_id, 'Payable', v_engagement.counterparty_id,
              format('SB-%s-%s', to_char(p_period_end, 'YYYYMMDD'), left(replace(p_engagement_id::text, '-', ''), 8)),
              current_date, v_currency)
      returning id into v_invoice;
    end if;
    v_number := v_number + 1;
    insert into app.invoice_lines (org_id, invoice_id, line_number, description, quantity, unit_price_minor, urid)
    values (v_engagement.org_id, v_invoice, v_number,
            format('Approved timesheet %s to %s.', r.period_start, r.period_end),
            case when v_engagement.pay_basis = 'Day Rate' then r.worked_days
                 else round(coalesce(r.worked_minutes, 0)::numeric / 60, 2) end,
            case when v_engagement.pay_basis in ('Hourly', 'Day Rate') then v_engagement.agreed_rate_minor end,
            v_urid)
    returning id into v_line;
    insert into app.self_billed_timesheets (org_id, invoice_line_id, timesheet_id) values (v_engagement.org_id, v_line, r.id);
  end loop;

  if v_invoice is null then
    perform private.refuse('self_billing_nothing_to_bill', 'No approved timesheets in this period are waiting to be billed.');
  end if;
  perform private.emit_event(v_engagement.org_id, 'invoice.self_billed', 'invoices', v_invoice, v_engagement.project_id,
    jsonb_build_object('engagement_id', p_engagement_id, 'line_count', v_number));
  return v_invoice;
end;
$$;

comment on function app.generate_self_billed_invoice(uuid, date, date) is 'Section 4.4.5 self-billing: generates a Proposed payable invoice for the engagement''s account with one line per approved timesheet in the period not already billed. Needs finance.invoice.write on the project, the finance.self_billing_enabled setting and a live self_billing_agreements row. Hourly engagements bill worked hours and Day Rate engagements bill worked days at the agreed rate; other pay bases bill hours unpriced for the org to price before approval (Section 3.7). Returns the invoice id.';

call private.install_default_retention('app.shared_reports');
call private.install_default_retention('app.self_billed_timesheets');
call private.install_audit_trail('app.shared_reports');
call private.install_audit_trail('app.self_billed_timesheets');

revoke all on function app.share_report(uuid, uuid, text, timestamptz) from public, anon;
revoke all on function app.revoke_shared_report(uuid) from public, anon;
revoke all on function app.generate_self_billed_invoice(uuid, date, date) from public, anon;
grant execute on function app.share_report(uuid, uuid, text, timestamptz) to authenticated, service_role;
grant execute on function app.revoke_shared_report(uuid) to authenticated, service_role;
grant execute on function app.generate_self_billed_invoice(uuid, date, date) to authenticated, service_role;

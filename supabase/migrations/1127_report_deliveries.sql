-- 1127_report_deliveries.sql
-- A43 (RRR-87), finding A38-004. Scheduled report email (Section 4.6.4, journey 29): nothing turned a due
-- schedule into a run or an email. On A18's job queue (0510):
--   1. app.queue_due_report_schedules (pg_cron, every five minutes, and the worker before each pass) takes
--      every due, unpaused schedule; for each recipient it queues a report run as that member (their own
--      access, never more), records an app.report_deliveries row, and moves next_run_at to the next slot.
--   2. The report.run worker renders the file (1126). When the run finishes, a trigger queues a
--      report.deliver job for each delivery waiting on it; a failed run fails its deliveries with the reason.
--   3. The report.deliver worker (packages/data report-deliveries, the report-run Edge Function) reads the
--      delivery through app.report_delivery, downloads the file and emails it to the recipient as an
--      attachment, then records the outcome with app.finish_report_delivery. Locally the mail goes to the
--      stack's Inbucket (Mailpit); elsewhere through the configured email transport and its allow-list.
-- Recipients are memberships of the schedule's org (0550), so a report never leaves the org.

insert into private.job_kinds (code, subject_table, max_attempts, description) values
  ('report.deliver', 'app.report_deliveries', 5, 'Emails a scheduled report''s finished file to one recipient.')
on conflict (code) do nothing;

insert into private.domain_event_types (code, subject, description) values
  ('report.delivered', 'report_deliveries', 'A scheduled report was emailed to a recipient.')
on conflict (code) do nothing;

create table app.report_deliveries (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  report_schedule_id uuid not null references app.report_schedules (id),
  membership_id uuid not null references app.memberships (id),
  report_run_id uuid not null references app.report_runs (id),
  scheduled_for timestamptz not null,
  delivery_status text not null default 'Queued',
  sent_at timestamptz,
  provider_message_id text,
  last_error text,
  deleted_at timestamptz,
  constraint report_deliveries_status check (delivery_status in ('Queued', 'Sent', 'Failed')),
  constraint report_deliveries_sent check ((delivery_status = 'Sent') = (sent_at is not null)),
  constraint report_deliveries_error_length check (last_error is null or char_length(last_error) <= 2000),
  constraint report_deliveries_message_id_length check (provider_message_id is null or char_length(provider_message_id) <= 200)
);

create index report_deliveries_schedule_idx on app.report_deliveries (report_schedule_id);
create index report_deliveries_membership_idx on app.report_deliveries (membership_id);
create index report_deliveries_run_idx on app.report_deliveries (report_run_id);
create unique index report_deliveries_once on app.report_deliveries (report_schedule_id, membership_id, scheduled_for) where deleted_at is null;

call private.install_domain_table('app.report_deliveries', 'app.report_schedules', 'report_schedule_id',
  array['app.memberships', 'membership_id', 'app.report_runs', 'report_run_id']);
call private.describe('app.report_deliveries', 'One email of a scheduled report to one recipient (Section 4.6.4): the run made as that member for the slot, and whether the email went out. Written only by the scheduler and the delivery worker.', array[
  'report_schedule_id', 'Schedule delivered.',
  'membership_id', 'Recipient member; the run uses their access.',
  'report_run_id', 'Run whose file is attached.',
  'scheduled_for', 'The schedule slot this delivery is for.',
  'delivery_status', 'Queued, Sent or Failed.',
  'sent_at', 'When the email was handed to the transport.',
  'provider_message_id', 'Message id from the email transport.',
  'last_error', 'Why the delivery failed.'
]);

call private.install_policies('app.report_deliveries',
  $$report_schedule_id in (select private.my_schedule_ids()) or membership_id in (select private.my_membership_ids())$$);
revoke insert, update, delete on app.report_deliveries from authenticated;

call private.install_default_retention('app.report_deliveries');
call private.install_audit_trail('app.report_deliveries');

-- 1. Scheduler ------------------------------------------------------------------------------------------------

create or replace function app.queue_due_report_schedules(p_limit integer default 100)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_schedule app.report_schedules;
  v_recipient record;
  v_run uuid;
  v_count integer := 0;
begin
  for v_schedule in
    select s.* from app.report_schedules s
    join app.report_definitions d on d.id = s.report_definition_id and d.deleted_at is null
    where s.deleted_at is null and s.paused_at is null and s.next_run_at <= now()
    order by s.next_run_at
    limit greatest(coalesce(p_limit, 100), 1)
    for update of s skip locked
  loop
    for v_recipient in
      select r.membership_id from app.report_schedule_recipients r
      join app.memberships m on m.id = r.membership_id
      where r.report_schedule_id = v_schedule.id and r.deleted_at is null
        and m.deleted_at is null and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now())
    loop
      insert into app.report_runs (report_definition_id, run_for_membership_id, export_format)
      values (v_schedule.report_definition_id, v_recipient.membership_id, v_schedule.export_format)
      returning id into v_run;
      perform private.enqueue_job(v_schedule.org_id, 'report.run', v_run);
      insert into app.report_deliveries (report_schedule_id, membership_id, report_run_id, scheduled_for)
      values (v_schedule.id, v_recipient.membership_id, v_run, v_schedule.next_run_at)
      on conflict do nothing;
      v_count := v_count + 1;
    end loop;
    update app.report_schedules
    set next_run_at = private.next_schedule_run(cadence, local_hour, weekday, month_day, time_zone, greatest(now(), v_schedule.next_run_at))
    where id = v_schedule.id;
  end loop;
  return v_count;
end;
$$;

comment on function app.queue_due_report_schedules(integer) is 'Scheduler (service role, pg_cron): for each due, unpaused schedule queues a report run per current recipient, as that member, records the delivery and moves next_run_at to the next slot. Returns the deliveries queued.';
revoke all on function app.queue_due_report_schedules(integer) from public, anon, authenticated;
grant execute on function app.queue_due_report_schedules(integer) to service_role;

select cron.schedule('xos_queue_due_report_schedules', '*/5 * * * *', 'select app.queue_due_report_schedules()');

-- 2. A finished run releases its deliveries ---------------------------------------------------------------------

create or replace function private.release_report_deliveries()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_delivery record;
begin
  if new.run_status = 'Succeeded' then
    for v_delivery in
      select d.id from app.report_deliveries d
      where d.report_run_id = new.id and d.delivery_status = 'Queued' and d.deleted_at is null
    loop
      perform private.enqueue_job(new.org_id, 'report.deliver', v_delivery.id);
    end loop;
  elsif new.run_status = 'Failed' then
    update app.report_deliveries
    set delivery_status = 'Failed', last_error = left('The report run failed: ' || coalesce(new.last_error, 'no reason recorded.'), 2000)
    where report_run_id = new.id and delivery_status = 'Queued' and deleted_at is null;
  end if;
  return new;
end;
$$;

comment on function private.release_report_deliveries() is 'When a report run succeeds, queues report.deliver for each delivery waiting on it; when it fails, fails them with the run''s reason.';
revoke all on function private.release_report_deliveries() from public, anon, authenticated;

create trigger t90_release_report_deliveries after update of run_status on app.report_runs
  for each row when (new.run_status in ('Succeeded', 'Failed') and old.run_status is distinct from new.run_status)
  execute function private.release_report_deliveries();

-- 3. Delivery worker API ---------------------------------------------------------------------------------------

create or replace function app.report_delivery(p_delivery_id uuid)
returns table (
  delivery_id uuid,
  org_id uuid,
  org_name text,
  report_name text,
  export_format app.export_format,
  storage_object_path text,
  row_count integer,
  unpriced_count integer,
  recipient_email text,
  recipient_name text,
  delivery_status text,
  scheduled_for timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select d.id, d.org_id, o.name, def.name, r.export_format, r.storage_object_path, r.row_count, r.unpriced_count,
    u.email::text, p.full_name, d.delivery_status, d.scheduled_for
  from app.report_deliveries d
  join app.organizations o on o.id = d.org_id
  join app.report_runs r on r.id = d.report_run_id
  join app.report_definitions def on def.id = r.report_definition_id
  join app.memberships m on m.id = d.membership_id
  join app.people p on p.id = m.person_id
  left join auth.users u on u.id = p.user_id
  where d.id = p_delivery_id and d.deleted_at is null;
$$;

comment on function app.report_delivery(uuid) is 'Worker API (service role): what the delivery worker needs to email one scheduled report: the run''s file, the report and org names, and the recipient''s address.';
revoke all on function app.report_delivery(uuid) from public, anon, authenticated;
grant execute on function app.report_delivery(uuid) to service_role;

create or replace function app.finish_report_delivery(p_delivery_id uuid, p_sent boolean, p_provider_message_id text default null, p_error text default null)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_delivery app.report_deliveries;
begin
  select d.* into v_delivery from app.report_deliveries d where d.id = p_delivery_id and d.deleted_at is null for update;
  if v_delivery.id is null then
    perform private.refuse('report_delivery_missing', 'The report delivery does not exist.');
  end if;
  if v_delivery.delivery_status <> 'Queued' then
    perform private.refuse('report_delivery_finished', 'This report delivery has already finished.');
  end if;
  if p_sent then
    update app.report_deliveries set delivery_status = 'Sent', sent_at = now(),
      provider_message_id = left(p_provider_message_id, 200), last_error = null
    where id = p_delivery_id;
    perform private.emit_event(v_delivery.org_id, 'report.delivered', 'report_deliveries', v_delivery.id, null,
      jsonb_build_object('report_schedule_id', v_delivery.report_schedule_id, 'report_run_id', v_delivery.report_run_id));
  else
    if p_error is null or btrim(p_error) = '' then
      perform private.refuse('report_delivery_error', 'A failed delivery records why it failed.');
    end if;
    update app.report_deliveries set delivery_status = 'Failed', last_error = left(p_error, 2000) where id = p_delivery_id;
  end if;
end;
$$;

comment on function app.finish_report_delivery(uuid, boolean, text, text) is 'Worker API (service role): records that a scheduled report email went out (with the transport''s message id) or failed (with the reason).';
revoke all on function app.finish_report_delivery(uuid, boolean, text, text) from public, anon, authenticated;
grant execute on function app.finish_report_delivery(uuid, boolean, text, text) to service_role;

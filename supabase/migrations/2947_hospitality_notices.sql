-- 2947_hospitality_notices.sql
-- B5 Travel, lodging, ground transport and local contacts (RRR-229, ADR 0144 decision 8; parity gaps G-66 and G-33).
-- Two notifications, sent through A80's queue so preferences and quiet hours apply:
--
--   accommodation_block.release_due  before a block's release date, while it still has a free room-night: at 14, 7 and 1
--                                    days on the project's calendar (private.block_release_thresholds), the smallest
--                                    threshold the days left have reached, once each (private.block_release_reminders_sent,
--                                    claimed before the notification is queued, as 1463 does). Recipients are the block's
--                                    creator and last editor, each only while they hold hospitality.accommodation.write on
--                                    the project (private.project_member_people_with, 0806). A new release date starts the
--                                    reminders again. An hourly pg_cron job sends them, at minute 53 (23 is the org
--                                    lifecycle job, 1350).
--   transfer.assigned                to the driver when a transfer's driver is set or changed. A driver who is not an active
--                                    member of the org gets a Gateway link to their engagement on the project (their own,
--                                    else the engagement of their operational roster entry); a member's opens Atlas. A
--                                    failure to queue is a warning and never blocks the write (as 2655).

-- Release reminders ------------------------------------------------------------------------------------------------------

create table private.block_release_thresholds (
  days smallint primary key,
  constraint block_release_thresholds_days check (days between 0 and 365)
);

comment on table private.block_release_thresholds is 'Days before an accommodation block''s release date a reminder goes out (B5): 14, 7 and 1.';
comment on column private.block_release_thresholds.days is 'Days left before the release date when a reminder is due.';

alter table private.block_release_thresholds enable row level security;
revoke all on private.block_release_thresholds from public, anon, authenticated;
grant select on private.block_release_thresholds to service_role;

insert into private.block_release_thresholds (days) values (14), (7), (1);

create table private.block_release_reminders_sent (
  accommodation_block_id uuid not null references app.accommodation_blocks (id),
  recipient_person_id uuid not null references app.people (id),
  release_on date not null,
  threshold_days smallint not null,
  org_id uuid not null references app.organizations (id),
  notification_id uuid,
  sent_at timestamptz not null default now(),
  primary key (accommodation_block_id, recipient_person_id, release_on, threshold_days)
);

create index block_release_reminders_sent_recipient_idx on private.block_release_reminders_sent (recipient_person_id);
create index block_release_reminders_sent_org_idx on private.block_release_reminders_sent (org_id);

comment on table private.block_release_reminders_sent is 'Every release reminder threshold already sent, per block, recipient and release date (B5). Written before the notification is queued, so private.send_block_release_reminders never sends a threshold twice.';
comment on column private.block_release_reminders_sent.accommodation_block_id is 'Block reminded about.';
comment on column private.block_release_reminders_sent.recipient_person_id is 'Person reminded.';
comment on column private.block_release_reminders_sent.release_on is 'Release date the reminder was for; a block with a new date is reminded again.';
comment on column private.block_release_reminders_sent.threshold_days is 'Threshold reminded, in days before the release date.';
comment on column private.block_release_reminders_sent.org_id is 'Org the reminder was sent through.';
comment on column private.block_release_reminders_sent.notification_id is 'Notification queued; NULL when the queue reached nobody.';
comment on column private.block_release_reminders_sent.sent_at is 'When the threshold was reminded.';

alter table private.block_release_reminders_sent enable row level security;
revoke all on private.block_release_reminders_sent from public, anon, authenticated;
grant select on private.block_release_reminders_sent to service_role;

create or replace function private.send_block_release_reminders()
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_row record;
  v_threshold smallint;
  v_person uuid;
  v_claimed boolean;
  v_notification uuid;
  v_sent integer := 0;
begin
  for v_row in
    select b.id, b.org_id, b.project_id, b.title, b.release_on, b.created_by, b.updated_by, p.name as project_name,
      p.project_key || '-' || b.block_number::text as block_key,
      b.release_on - private.zone_date(now(), p.time_zone) as days_left,
      (select sum(b.rooms_held - (select count(*) from app.accommodation_assignments a
                                  where a.accommodation_block_id = b.id and a.deleted_at is null
                                    and a.check_in_on <= d::date and a.check_out_on > d::date))
       from pg_catalog.generate_series(b.check_in_on, b.check_out_on - 1, interval '1 day') d)::integer as free_room_nights
    from app.accommodation_blocks b
    join app.projects p on p.id = b.project_id and p.deleted_at is null and p.archived_at is null
    where b.deleted_at is null and b.release_on is not null
      and b.release_on - private.zone_date(now(), p.time_zone) between 0 and 14
  loop
    if v_row.free_room_nights <= 0 then
      continue;
    end if;
    select min(t.days) into v_threshold from private.block_release_thresholds t where t.days >= v_row.days_left;
    if v_threshold is null then
      continue;
    end if;
    for v_person in
      select distinct w.person_id from (values (v_row.created_by), (v_row.updated_by)) w (person_id)
      where w.person_id is not null
        and w.person_id in (select private.project_member_people_with(v_row.project_id, 'hospitality.accommodation.write'))
    loop
      insert into private.block_release_reminders_sent (accommodation_block_id, recipient_person_id, release_on, threshold_days, org_id)
      values (v_row.id, v_person, v_row.release_on, v_threshold, v_row.org_id)
      on conflict do nothing
      returning true into v_claimed;
      if not coalesce(v_claimed, false) then
        continue;
      end if;
      v_claimed := false;
      v_notification := private.notify(v_row.org_id, v_person, 'accommodation_block.release_due', 'accommodation_blocks', v_row.id,
        v_row.project_id, jsonb_build_object('blockKey', v_row.block_key, 'blockTitle', v_row.title,
          'releaseOn', v_row.release_on::text, 'days', v_row.days_left, 'freeRoomNights', v_row.free_room_nights,
          'projectName', v_row.project_name));
      update private.block_release_reminders_sent set notification_id = v_notification
      where accommodation_block_id = v_row.id and recipient_person_id = v_person and release_on = v_row.release_on
        and threshold_days = v_threshold;
      if v_notification is not null then
        v_sent := v_sent + 1;
      end if;
    end loop;
  end loop;
  return v_sent;
end;
$$;

comment on function private.send_block_release_reminders() is 'The release reminder job (B5, G-66), run hourly by pg_cron: for each live block of a live, unarchived project whose release date is 0 to 14 days away on the project''s calendar and which still has a free room-night, sends accommodation_block.release_due once per threshold (the smallest of 14, 7 and 1 at or above the days left) to its creator and last editor who still hold hospitality.accommodation.write on the project, with the block key and title, the release date, the days left, the free room-nights and the project name. Returns how many notifications it queued.';
revoke all on function private.send_block_release_reminders() from public, anon, authenticated;

select cron.schedule('xos_send_block_release_reminders', '53 * * * *', 'select private.send_block_release_reminders()');

-- Driver assigned ---------------------------------------------------------------------------------------------------------

create or replace function private.notify_transfer_driver()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_args jsonb;
  v_engagement uuid;
begin
  if new.deleted_at is not null or new.driver_person_id is null
     or (tg_op = 'UPDATE' and new.driver_person_id is not distinct from old.driver_person_id) then
    return null;
  end if;
  begin
    v_args := jsonb_build_object(
      'transferKey', (select p.project_key || '-' || new.transfer_number::text from app.projects p where p.id = new.project_id),
      'pickupAt', new.pickup_at,
      'pickupTimeZone', new.pickup_time_zone,
      'pickupPlace', new.pickup_place,
      'dropoffPlace', new.dropoff_place,
      'passengerCount', (select count(*) from app.transfer_passengers q where q.transfer_id = new.id and q.deleted_at is null));
    if not exists (select 1 from app.memberships m where m.org_id = new.org_id and m.person_id = new.driver_person_id
                   and m.deleted_at is null and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now())) then
      v_engagement := coalesce(
        (select e.id from app.engagements e
         where e.project_id = new.project_id and e.person_id = new.driver_person_id and e.deleted_at is null
         order by (e.engagement_state = 'Active') desc, e.start_date desc, e.id limit 1),
        (select e.id from app.engagement_roster_entries r
         join app.engagements e on e.id = r.engagement_id and e.deleted_at is null
         join private.roster_people rp on rp.roster_entry_id = r.id
         where e.project_id = new.project_id and rp.person_id = new.driver_person_id and r.deleted_at is null
           and r.entry_state = 'Accepted' and r.person_response = 'Accepted'
         order by (e.engagement_state = 'Active') desc, e.start_date desc, e.id limit 1));
      if v_engagement is not null then
        v_args := v_args || jsonb_build_object('gatewayPath', '/work/engagements/' || private.gateway_display_key('ENG', v_engagement));
      end if;
    end if;
    perform private.notify(new.org_id, new.driver_person_id, 'transfer.assigned', 'transfers', new.id, new.project_id, v_args);
  exception when others then
    raise warning 'transfer.assigned was not sent for transfer %: %', new.id, sqlerrm;
  end;
  return null;
end;
$$;

comment on function private.notify_transfer_driver() is 'After a live transfer is created with a driver or its driver changes: sends transfer.assigned to the new driver with the transfer key, pickup time, zone and place, drop-off place and passenger count. A driver who is not an active member of the org gets a Gateway link to their engagement on the project (their own, else their operational roster entry''s); a member''s opens Atlas. A failure is a warning and never blocks the write (as 2655).';
revoke all on function private.notify_transfer_driver() from public, anon, authenticated;
create trigger t91_notify_transfer_driver after insert or update of driver_person_id on app.transfers
  for each row execute function private.notify_transfer_driver();

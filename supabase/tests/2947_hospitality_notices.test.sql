-- pgTAP: migration 2947 (B5, G-66 and G-33), hospitality notices. accommodation_block.release_due goes once per
-- threshold (14, 7 and 1 days on the project calendar) while the block has a free room-night, only to its creator and
-- last editor who hold hospitality.accommodation.write on the project (not an 'assigned' holder off the project, nor an
-- editor without the capability); a second run sends nothing; the cron job runs hourly at minute 53. transfer.assigned
-- goes to the new driver once, with a Gateway link for a driver outside the org, and a failure to queue never blocks
-- the write.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql
\ir 2654_project_facts_world.psql
\ir 2691_allocation_world.psql
\ir 2940_travel_world.psql

select no_plan();

create function pg_temp.sent(p_who text, p_kind text, p_subject text) returns integer
language sql as $$
  select count(*)::int from app.notifications n
  where n.recipient_person_id = pg_temp.id(p_who) and n.kind = p_kind and n.subject_id = pg_temp.id(p_subject)
$$;

-- roomer holds hospitality.accommodation.write with assigned reach and is not on prj_a.
select pg_temp.producer('roomer', 'hospitality.accommodation.write');
update app.role_capabilities set reach = 'assigned'
where role_id = (select r.id from app.roles r where r.org_id = pg_temp.id('org_a') and r.code = 'roomer_only');
update app.project_members set deleted_at = now() where membership_id = (select m.id from app.memberships m
  where m.org_id = pg_temp.id('org_a') and m.person_id = pg_temp.id('roomer'));

-- Release reminders -----------------------------------------------------------------------------------------------------------------
select is((select count(*)::int from cron.job where jobname = 'xos_send_block_release_reminders' and schedule = '53 * * * *'), 1,
  'the reminder job runs hourly at minute 53');
select is((select array_agg(days order by days) from private.block_release_thresholds), array[1, 7, 14]::smallint[], 'at 14, 7 and 1 days');

update app.accommodation_blocks set release_on = private.zone_today('America/New_York') + 10 where id = pg_temp.id('blk');
update app.accommodation_blocks set updated_by = pg_temp.id('roomer') where id = pg_temp.id('blk');
select private.send_block_release_reminders();
select is(pg_temp.sent('alice', 'accommodation_block.release_due', 'blk'), 1, 'the creator is reminded at 14 days');
select is(pg_temp.sent('roomer', 'accommodation_block.release_due', 'blk'), 0,
  'an editor holding the capability only for assigned projects, off this one, is not');
select is((select n.message_args ->> 'days' from app.notifications n where n.kind = 'accommodation_block.release_due'
  and n.subject_id = pg_temp.id('blk')), '10', 'with the days left');
select is((select (n.message_args ->> 'freeRoomNights')::int from app.notifications n where n.kind = 'accommodation_block.release_due'
  and n.subject_id = pg_temp.id('blk')), 60, 'and the free room-nights');
select is(private.send_block_release_reminders(), 0, 'a second run sends nothing');
update app.accommodation_blocks set release_on = private.zone_today('America/New_York') + 5, updated_by = pg_temp.id('hops')
where id = pg_temp.id('blk');
select private.send_block_release_reminders();
select is(pg_temp.sent('alice', 'accommodation_block.release_due', 'blk'), 2, 'a new release date 5 days out reminds again at 7');
select is(pg_temp.sent('hops', 'accommodation_block.release_due', 'blk'), 0, 'an editor without the capability is not reminded');

-- A full block is not reminded.
select pg_temp.as_user('alice');
with x as (insert into app.accommodation_blocks (project_id, title, check_in_on, check_out_on, rooms_held)
  values (pg_temp.id('prj_a'), 'Suite', '2027-06-01', '2027-06-03', 1) returning id)
insert into world select 'suite', id from x;
insert into app.accommodation_assignments (accommodation_block_id, person_id, check_in_on, check_out_on)
values (pg_temp.id('suite'), pg_temp.id('kai'), '2027-06-01', '2027-06-03');
select pg_temp.as_platform();
update app.accommodation_blocks set release_on = private.zone_today('America/New_York') + 1 where id = pg_temp.id('suite');
select private.send_block_release_reminders();
select is(pg_temp.sent('alice', 'accommodation_block.release_due', 'suite'), 0, 'a block with no free room-night is not reminded');
update app.accommodation_blocks set release_on = private.zone_today('America/New_York') - 1 where id = pg_temp.id('blk');
select is(private.send_block_release_reminders(), 0, 'nor one past its release date');

-- Driver assigned -------------------------------------------------------------------------------------------------------------------
select pg_temp.transfer('t1', '2027-06-02 14:00+00', '2027-06-02 15:00+00', 'dave', 'van');
select is(pg_temp.sent('dave', 'transfer.assigned', 't1'), 1, 'a new transfer with a driver tells the driver');
select is((select n.message_args ? 'gatewayPath' from app.notifications n where n.kind = 'transfer.assigned'
  and n.subject_id = pg_temp.id('t1') and n.recipient_person_id = pg_temp.id('dave')), false, 'a member''s link opens Atlas');
select is((select n.message_args ->> 'pickupPlace' from app.notifications n where n.kind = 'transfer.assigned'
  and n.subject_id = pg_temp.id('t1')), 'Miami International Airport (MIA)', 'with the pickup place');
select pg_temp.as_user('alice');
update app.transfers set notes = 'Meet at door 4.' where id = pg_temp.id('t1');
select pg_temp.as_platform();
select is(pg_temp.sent('dave', 'transfer.assigned', 't1'), 1, 'an edit that keeps the driver sends nothing more');
select pg_temp.as_user('alice');
update app.transfers set driver_person_id = pg_temp.id('kai') where id = pg_temp.id('t1');
select pg_temp.as_platform();
select is(pg_temp.sent('kai', 'transfer.assigned', 't1'), 1, 'a new driver is told once');
select is((select n.message_args ->> 'gatewayPath' from app.notifications n where n.kind = 'transfer.assigned'
  and n.subject_id = pg_temp.id('t1') and n.recipient_person_id = pg_temp.id('kai')),
  '/work/engagements/' || private.gateway_display_key('ENG', pg_temp.id('eng_vendor_a')),
  'a driver outside the org gets a Gateway link to their roster entry''s engagement');

-- A failure to queue never blocks the write (the queue is replaced inside this transaction only).
create or replace function private.notify(p_org_id uuid, p_recipient_person_id uuid, p_kind text, p_subject_table text default null,
  p_subject_id uuid default null, p_project_id uuid default null, p_message_args jsonb default '{}'::jsonb)
returns uuid language plpgsql as $$ begin raise exception 'queue down'; end $$;
select pg_temp.as_user('alice');
select is(pg_temp.rule_of(format($$update app.transfers set driver_person_id = %L where id = %L$$, pg_temp.id('erin'), pg_temp.id('t1'))),
  'ok', 'a failure to queue the notice never blocks the write');
select pg_temp.as_platform();
select is((select driver_person_id from app.transfers where id = pg_temp.id('t1')), pg_temp.id('erin'), 'the driver changed');

select * from finish();
rollback;

-- pgTAP: migration 2741 (R11), the reminder ledgers and the two purges. private.purge_organization (1351) and
-- private.purge_sandbox_org (1530) refuse any row outside the org that references it, so an org that has sent a reminder
-- must still purge, and its ledger rows go with it.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0200_identity_world.psql

select no_plan();

-- One sent packet with a recipient on the project, and a row in each ledger.
create function pg_temp.remind(p_key text, p_org uuid, p_project uuid, p_owner text, p_person uuid) returns void
language plpgsql as $$
declare
  v_packet uuid;
  v_section uuid;
  v_recipient uuid;
begin
  perform pg_temp.as_user(p_owner);
  insert into app.advance_packets (project_id, title, due_at) values (p_project, 'Production Advance', now() + interval '2 days')
  returning id into v_packet;
  insert into app.advance_sections (advance_packet_id, position, title) values (v_packet, 1, 'Power') returning id into v_section;
  insert into app.advance_recipients (advance_packet_id, person_id) values (v_packet, p_person) returning id into v_recipient;
  perform app.send_advance_packet(v_packet);
  perform pg_temp.as_platform();
  perform private.queue_advance_reminder(v_recipient, 'due', now() + interval '2 days', 1);
  insert into private.roster_fact_reminders_sent (roster_entry_id, org_id, threshold_days, arrival_starts_at)
  values (private.uuid_v7(), p_org, 1, now());
  insert into world values (p_key || '_recipient', v_recipient);
end $$;

create function pg_temp.ledger(p_org uuid) returns integer
language sql as $$
  select (select count(*) from private.advance_reminders_sent s where s.org_id = p_org)::int
    + (select count(*) from private.roster_fact_reminders_sent s where s.org_id = p_org)::int
$$;

-- Org deletion -----------------------------------------------------------------------------------------------------------------
select pg_temp.as_platform();
with p as (insert into app.projects (org_id, project_key, name, time_zone)
  values (pg_temp.id('org_b'), 'HBR', 'Harbor Season', 'America/New_York') returning id)
insert into world select 'prj_b', id from p;
select pg_temp.remind('org_b', pg_temp.id('org_b'), pg_temp.id('prj_b'), 'xavier', pg_temp.id('mia'));
select is(pg_temp.ledger(pg_temp.id('org_b')), 2, 'the org has sent a packet reminder and a project facts reminder');

insert into world select 'cert_b', private.write_deletion_certificate(pg_temp.id('org_b'), 'cancellation', now(), now(), null);
update app.deletion_certificates set storage_cleared_at = now() where id = pg_temp.id('cert_b');
select isnt(private.purge_organization(pg_temp.id('cert_b')), null::bigint, 'an org that has sent reminders still purges');
select is((select blocked_reason from app.deletion_certificates where id = pg_temp.id('cert_b')), null, 'nothing blocked it');
select is((select count(*)::int from app.organizations where id = pg_temp.id('org_b')), 0, 'the org is gone');
select is(pg_temp.ledger(pg_temp.id('org_b')), 0, 'with its ledger rows');
select is((select count(*)::int from private.advance_reminders_sent where advance_recipient_id = pg_temp.id('org_b_recipient')), 0,
  'none left for its recipient');

-- The sandbox purge ------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('nina');
insert into world select 'sandbox', s.org_id from app.open_my_sandbox() s;
select pg_temp.as_platform();
insert into world select 'prj_s', p.id from app.projects p where p.org_id = pg_temp.id('sandbox') and p.project_key = 'NWS';
select pg_temp.remind('sandbox', pg_temp.id('sandbox'), pg_temp.id('prj_s'), 'nina', pg_temp.id('nina'));
select is(pg_temp.ledger(pg_temp.id('sandbox')), 2, 'a sandbox has sent reminders too');
select isnt(private.purge_sandbox_org(pg_temp.id('sandbox')), null::bigint, 'and still purges');
select is((select count(*)::int from app.organizations where id = pg_temp.id('sandbox')), 0, 'the sandbox is gone');
select is(pg_temp.ledger(pg_temp.id('sandbox')), 0, 'with its ledger rows');

select * from finish();
rollback;

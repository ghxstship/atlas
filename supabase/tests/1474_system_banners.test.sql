-- pgTAP: migration 1474, system banners (A90, RRR-135, finding A65-009; Section 4.10). Operators with banners.write
-- publish maintenance, incident, plan and other notices scheduled in instants for every shell or one; the shells
-- read only the live ones through api_public.active_system_banners, before or after sign-in; an ended banner never
-- changes; a Critical banner cannot be dismissed and an incident links to the status page.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0200_identity_world.psql

select plan(22);

create function pg_temp.as_op(p_key text) returns void
language plpgsql as $$
begin
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', pg_temp.id(p_key || '_user'), 'role', 'authenticated', 'aal', 'aal2')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;

select pg_temp.new_user('omar', 'omar@platform.test', 'Omar Haddad');
select pg_temp.new_user('tess', 'tess@platform.test', 'Tess Morales');
select pg_temp.as_platform();
select private.grant_platform_operator('omar@platform.test', 'Support', 'Support on call.');
select private.grant_platform_operator('tess@platform.test', 'Trust and Safety', 'Moderation.');

-- Who may publish ------------------------------------------------------------------------------------------------------------
select pg_temp.as_op('alice');
select throws_ok($$select app.console_save_banner(null, 'Notice', 'Info', 'Everyone', 'Hello.', null, null, now(), null, true)$$,
  '42501', null, 'a tenant Owner publishes no system banner');
select is((select count(*)::int from app.system_banners), 0, 'nor reads the banner table');
select pg_temp.as_op('tess');
select throws_ok($$select app.console_save_banner(null, 'Notice', 'Info', 'Everyone', 'Hello.', null, null, now(), null, true)$$,
  '42501', null, 'Trust and Safety does not publish banners');

-- Publishing -----------------------------------------------------------------------------------------------------------------
select pg_temp.as_op('omar');
select lives_ok($$insert into world select 'maint', app.console_save_banner(null, 'Maintenance', 'Warning', 'Everyone',
  'Scheduled maintenance tonight from 02:00 to 03:00 UTC. Sync may pause.', 'Mantenimiento programado esta noche de 02:00 a 03:00 UTC.',
  null, now() - interval '1 minute', now() + interval '1 hour', true)$$, 'Support publishes a live maintenance banner for every shell');
select lives_ok($$insert into world select 'incident', app.console_save_banner(null, 'Incident', 'Critical', 'Gateway',
  'Payouts are delayed. We are working on it.', null, 'https://status.ghxstship.tech/incidents/1', now() - interval '1 minute', null, false)$$,
  'a Critical incident for Gateway, linked to the status page');
select lives_ok($$insert into world select 'later', app.console_save_banner(null, 'Plan Notice', 'Info', 'Atlas',
  'Plan prices change next month.', null, null, now() + interval '2 days', now() + interval '30 days', true)$$,
  'and a plan notice scheduled for later');
select throws_ok($$select app.console_save_banner(null, 'Incident', 'Warning', 'Everyone', 'Down.', null, null, now(), null, true)$$,
  'XR001', 'system_banner_incident_link: An incident banner links to the status page.', 'an incident needs its status link');
select throws_ok($$select app.console_save_banner(null, 'Maintenance', 'Info', 'Everyone', 'Soon.', null, null, now(), null, true)$$,
  'XR001', null, 'a maintenance banner needs the end of its window');
select throws_ok($$select app.console_save_banner(null, 'Notice', 'Critical', 'Everyone', 'Read me.', null, null, now(), null, true)$$,
  'XR001', 'system_banner_critical_dismissible: A Critical banner stays until it ends; it cannot be dismissed.', 'a Critical banner cannot be dismissible');
select throws_ok($$select app.console_save_banner(null, 'Notice', 'Info', 'Everyone', 'Link.', null, 'javascript:alert(1)', now(), null, true)$$,
  'XR001', 'system_banner_link: Links start with https://.', 'links are https only');
select throws_ok($$select app.console_save_banner(null, 'Notice', 'Info', 'Everyone', 'Long.', null, null, now(), now() + interval '120 days', true)$$,
  'XR001', null, 'a banner ends within 90 days');
select is((select count(*)::int from app.platform_operator_actions where action = 'system_banner.saved'), 3, 'each save is logged');

-- The shells read the live ones -------------------------------------------------------------------------------------------------
select pg_temp.as_anon();
select is((select string_agg(banner_kind, ', ' order by banner_kind) from api_public.active_system_banners('gateway')),
  'Incident, Maintenance', 'Gateway shows the incident and the maintenance window, before sign-in too');
select is((select banner_kind from api_public.active_system_banners('gateway') limit 1), 'Incident', 'the most severe first');
select is((select string_agg(banner_kind, ', ') from api_public.active_system_banners('atlas')), 'Maintenance',
  'Atlas shows only what is live for it');
select is((select message_es from api_public.active_system_banners('compass')), 'Mantenimiento programado esta noche de 02:00 a 03:00 UTC.',
  'with the es-US text');
select throws_ok($$select count(*) from app.system_banners$$, '42501', null, 'anon reads no banner table, only the RPC');

-- Ending -------------------------------------------------------------------------------------------------------------------------
select pg_temp.as_op('omar');
select lives_ok(format('select app.console_end_banner(%L)', pg_temp.id('incident')), 'Support ends the incident banner');
select throws_ok(format($$select app.console_save_banner(%L, 'Incident', 'Critical', 'Gateway', 'Edited.', null, 'https://status.ghxstship.tech', now(), null, false)$$,
  pg_temp.id('incident')), 'XR001', 'system_banner_ended: An ended banner never changes. Publish a new one.', 'an ended banner never changes');
select lives_ok(format($$select app.console_save_banner(%L, 'Plan Notice', 'Info', 'Atlas', 'Plan prices change on the first of next month.', null, null,
  now() + interval '2 days', now() + interval '30 days', true)$$, pg_temp.id('later')), 'a scheduled banner can be corrected');
select pg_temp.as_user('gina');
select is((select string_agg(banner_kind, ', ') from api_public.active_system_banners('gateway')), 'Maintenance',
  'once ended, the incident leaves every shell');
select throws_ok($$select * from app.console_banners()$$, '42501', null, 'and a tenant member cannot list banners in the console');

select * from finish();
rollback;

-- pgTAP: migration 904090003, the 4.9 email branding audit. Every email an org sends wears its brand: the email brand
-- answers whether "Delivered by XOS" is hidden, a worker reads an org's document brand for the guest pass it attaches
-- (whatever the plan, as Atlas prints it), a stakeholder pack's email facts carry the email brand only while white
-- label is in force, and a scheduled report's delivery names its recipient, links the report only for one who may open
-- it and says when the org's suppression list stops the email. Only the service role reads any of it.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(22);

create temporary table k (key text primary key, id uuid, val text);
grant select, insert, update, delete on k to public;
create function pg_temp.k(p_key text) returns uuid language sql stable as $$ select id from k where key = p_key $$;

create function pg_temp.as_worker() returns void
language plpgsql as $$
begin
  perform pg_temp.as_platform();
  perform set_config('role', 'service_role', true);
end $$;

-- Northwind (org_a) has white label in force; Harbor Lights (org_b) saves a brand on a plan without it.
select pg_temp.as_platform();
insert into app.org_brands (org_id, display_name, logo_light_path, accent_hex, email_sender_name, support_email, legal_entity_name, suppress_powered_by)
values (pg_temp.id('org_a'), 'Northwind Presents', pg_temp.id('org_a') || '/logo-light.png', '#0B5FFF', 'Northwind Crew Desk',
  'crew@northwind-live.com', 'Northwind Live LLC', true),
  (pg_temp.id('org_b'), 'Harbor Lights', pg_temp.id('org_b') || '/logo.png', '#123456', 'Harbor Desk', 'desk@harbor.test', null, false);

-- The email brand ------------------------------------------------------------------------------------------------------
select is((select suppress_powered_by from app.email_brand_for_org(pg_temp.id('org_a'))), true,
  'an org that hides Powered by XOS with white label in force hides Delivered by XOS on its email');
update app.org_brands set suppress_powered_by = false where org_id = pg_temp.id('org_a');
select is((select suppress_powered_by from app.email_brand_for_org(pg_temp.id('org_a'))), false, 'and shows it when it does not');
select is((select count(*)::int from app.email_brand_for_org(pg_temp.id('org_b'))), 0,
  'an org without white label in force still gets no email brand');
select ok(not has_function_privilege('authenticated', 'app.email_brand_for_org(uuid)', 'execute')
  and has_function_privilege('service_role', 'app.email_brand_for_org(uuid)', 'execute'), 'the email brand stays the workers''');

-- The document brand ---------------------------------------------------------------------------------------------------
select is((select row(name, legal_entity, accent_hex, logo_path)::text from app.document_brand_for_org(pg_temp.id('org_a'))),
  row('Northwind Presents', 'Northwind Live LLC', '#0B5FFF', pg_temp.id('org_a') || '/logo-light.png')::text,
  'a document carries the display name, legal entity, accent and light logo');
select is((select row(name, accent_hex, logo_path)::text from app.document_brand_for_org(pg_temp.id('org_b'))),
  row('Harbor Lights', '#123456', pg_temp.id('org_b') || '/logo.png')::text,
  'documents wear the brand whatever the plan, as Atlas prints them');
update app.org_brands set deleted_at = now() where org_id = pg_temp.id('org_b');
select is((select row(name, logo_path)::text from app.document_brand_for_org(pg_temp.id('org_b'))),
  row((select name from app.organizations where id = pg_temp.id('org_b')), null::text)::text,
  'a deleted brand leaves the org''s own name and no logo');
select ok(not has_function_privilege('authenticated', 'app.document_brand_for_org(uuid)', 'execute')
  and not has_function_privilege('anon', 'app.document_brand_for_org(uuid)', 'execute')
  and has_function_privilege('service_role', 'app.document_brand_for_org(uuid)', 'execute'), 'only a worker reads the document brand');

-- The stakeholder pack email -------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
insert into k values ('pack', app.create_stakeholder_pack(pg_temp.id('prj_a'), 'Supplier pack', now() + interval '30 days', 'Hello.'), null);
insert into k select 'r1', r.recipient_id, r.access_code from app.add_stakeholder_pack_recipient(pg_temp.k('pack'), 'Sol Supplier', 'sol@supplier.test') r;
select app.send_stakeholder_pack(pg_temp.k('pack'));
select pg_temp.as_platform();
insert into k select 'm1', null, m.email::text from app.mint_stakeholder_pack_link(
  (select d.id from app.stakeholder_pack_deliveries d where d.recipient_id = pg_temp.k('r1') order by d.created_at desc limit 1)) m;
select is((select val::jsonb ->> 'brand_name' from k where key = 'm1'), 'Northwind Presents', 'a pack email wears the brand name');
select is((select val::jsonb ->> 'white_label' from k where key = 'm1'), 'true', 'and says white label is in force');
select is((select val::jsonb ->> 'brand_sender_name' from k where key = 'm1'), 'Northwind Crew Desk', 'with the From name');
select is((select val::jsonb ->> 'reply_to' from k where key = 'm1'), 'crew@northwind-live.com', 'the reply-to');
select is((select val::jsonb ->> 'logo_path' from k where key = 'm1'), pg_temp.id('org_a') || '/logo-light.png', 'and the logo');
select is((select val::jsonb ->> 'org_id' from k where key = 'm1'), pg_temp.id('org_a')::text, 'and names the org');

-- The scheduled report email -------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
insert into app.report_definitions (membership_id, name, source_code) values (pg_temp.id('carol@org_a'), 'Spend Watch 4.9', 'records');
insert into k (key, id) select 'rep', id from app.report_definitions where name = 'Spend Watch 4.9';
insert into app.report_fields (report_definition_id, field, aggregate, position) values (pg_temp.k('rep'), 'title', 'None', 1);
insert into app.report_schedules (report_definition_id, cadence, local_hour, weekday, time_zone, export_format)
values (pg_temp.k('rep'), 'Weekly', 8, 1, 'America/New_York', 'PDF');
insert into k (key, id) select 'sched', id from app.report_schedules where report_definition_id = pg_temp.k('rep');
insert into app.report_schedule_recipients (report_schedule_id, membership_id) values
  (pg_temp.k('sched'), pg_temp.id('carol@org_a')), (pg_temp.k('sched'), pg_temp.id('dave@org_a'));
select pg_temp.as_platform();
update app.report_schedules set next_run_at = now() - interval '1 minute' where id = pg_temp.k('sched');
select pg_temp.as_worker();
select app.queue_due_report_schedules();
select pg_temp.as_platform();
insert into k (key, id) select 'carol_d', d.id from app.report_deliveries d join app.report_runs r on r.id = d.report_run_id
  where r.report_definition_id = pg_temp.k('rep') and d.membership_id = pg_temp.id('carol@org_a');
insert into k (key, id) select 'dave_d', d.id from app.report_deliveries d join app.report_runs r on r.id = d.report_run_id
  where r.report_definition_id = pg_temp.k('rep') and d.membership_id = pg_temp.id('dave@org_a');

select pg_temp.as_worker();
select is((select row(org_slug, recipient_person_id, suppressed)::text from app.report_delivery(pg_temp.k('carol_d'))),
  row((select slug from app.organizations where id = pg_temp.id('org_a')), pg_temp.id('carol'), false)::text,
  'a delivery names the org slug and the recipient person, and is not stopped');
select is((select report_definition_id from app.report_delivery(pg_temp.k('carol_d'))), pg_temp.k('rep'),
  'its owner''s email links the report');
select is((select report_definition_id from app.report_delivery(pg_temp.k('dave_d'))), null::uuid,
  'a recipient who may not open an unshared report gets the file and no link');

select pg_temp.as_platform();
insert into app.suppression_list (org_id, channel, address, reason, category_code)
values (pg_temp.id('org_a'), 'Email', (select lower(u.email) from auth.users u join app.people p on p.user_id = u.id where p.id = pg_temp.id('dave')),
  'Unsubscribe', 'mentions');
select pg_temp.as_worker();
select is((select suppressed from app.report_delivery(pg_temp.k('dave_d'))), false,
  'an unsubscribe from another category does not stop report email');
select pg_temp.as_platform();
update app.suppression_list set category_code = 'reports' where org_id = pg_temp.id('org_a') and category_code = 'mentions';
select pg_temp.as_worker();
select is((select suppressed from app.report_delivery(pg_temp.k('dave_d'))), true, 'an unsubscribe from reports does');
select pg_temp.as_platform();
update app.suppression_list set category_code = null where org_id = pg_temp.id('org_a') and category_code = 'reports';
select pg_temp.as_worker();
select is((select suppressed from app.report_delivery(pg_temp.k('dave_d'))), true, 'and so does an unsubscribe from all email');
select pg_temp.as_platform();
update app.suppression_list set lifted_at = now() where org_id = pg_temp.id('org_a') and address like '%';
select pg_temp.as_worker();
select is((select suppressed from app.report_delivery(pg_temp.k('dave_d'))), false, 'a lifted entry stops nothing');
select pg_temp.as_platform();
select ok(not has_function_privilege('authenticated', 'app.report_delivery(uuid)', 'execute')
  and has_function_privilege('service_role', 'app.report_delivery(uuid)', 'execute'), 'only the worker reads a delivery');

select * from finish();
rollback;

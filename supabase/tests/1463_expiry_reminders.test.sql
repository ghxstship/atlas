-- pgTAP: migration 1463, expiry reminders (A89, RRR-134, A65-008). Each expiring onboarding item, certification and
-- document reminds the person responsible once per threshold (30, 7 and 1 days, or an onboarding requirement's own
-- window), counting days on the org's calendar for org items and on the person's own calendar for personal items.
-- The zones are pinned 25 hours apart (Kiritimati, UTC+14, for org_a; Pago Pago, UTC-11, for the people), so the two
-- calendars always disagree by at least a day whatever the time of day the suite runs.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

select plan(21);

select pg_temp.as_user('alice');
select app.set_setting(pg_temp.id('org_a'), 'locale.time_zone', 'Organization', pg_temp.id('org_a'), p_value_text => 'Pacific/Kiritimati');
select pg_temp.as_user('frank');
select app.set_personal_setting('locale.time_zone', null, 'Pacific/Pago_Pago');
select pg_temp.as_user('nina');
select app.set_personal_setting('locale.time_zone', null, 'Pacific/Pago_Pago');
select pg_temp.as_platform();
select ok(private.org_today(pg_temp.id('org_a')) > private.person_today(pg_temp.id('frank')), 'the two calendars disagree, as pinned');
select private.org_today(pg_temp.id('org_a')) as org_today, private.person_today(pg_temp.id('frank')) as frank_today,
  private.person_today(pg_temp.id('nina')) as nina_today \gset

-- Org items --------------------------------------------------------------------------------------------------------------

insert into app.certifications (org_id, name, issuing_body) values (pg_temp.id('org_a'), 'Forklift Operator', 'OSHA') returning id as v_fork \gset
insert into app.certifications (org_id, name, issuing_body) values (pg_temp.id('org_a'), 'Aerial Lift', 'IPAF') returning id as v_lift \gset
insert into app.certification_holders (certification_id, person_id, verified_by, issued_on, expires_on)
values (:'v_fork', pg_temp.id('frank'), pg_temp.id('carol'), '2025-01-01', private.org_today(pg_temp.id('org_a')) + 7)
returning id as v_holder \gset
-- An Aerial Lift record about to lapse, renewed by a later one: the old record never reminds.
insert into app.certification_holders (certification_id, person_id, verified_by, issued_on, expires_on)
values (:'v_lift', pg_temp.id('frank'), pg_temp.id('carol'), '2025-01-01', private.org_today(pg_temp.id('org_a')) + 2)
returning id as v_lift_old \gset
insert into app.certification_holders (certification_id, person_id, verified_by, issued_on, expires_on)
values (:'v_lift', pg_temp.id('frank'), pg_temp.id('carol'), '2026-01-01', private.org_today(pg_temp.id('org_a')) + 400);

-- Onboarding: ivy (an engaged person) and the vendor account acct_v (victor Owner, fiona Finance, sam Member).
insert into app.onboarding_requirements (org_id, name, item_kind, role_type, verification_method, is_blocking, valid_for_days, remind_days_before)
values (pg_temp.id('org_a'), 'Rigging Safety Briefing', 'Acknowledgment', null, 'Reviewer', false, 365, 14) returning id as v_req \gset
insert into app.onboarding_items (engagement_id, onboarding_requirement_id) values (pg_temp.id('eng_ivy_a'), :'v_req') returning id as v_item_ivy \gset
insert into app.onboarding_items (engagement_id, onboarding_requirement_id) values (pg_temp.id('eng_vendor_a'), :'v_req') returning id as v_item_vendor \gset
select pg_temp.as_user('carol');
insert into app.onboarding_verifications (onboarding_item_id, outcome, expires_on) values (:'v_item_ivy', 'Passed', :'org_today'::date + 10);
insert into app.onboarding_verifications (onboarding_item_id, outcome, expires_on) values (:'v_item_vendor', 'Passed', :'org_today'::date + 3);
select pg_temp.as_platform();

-- A signed agreement on art's engagement expiring tomorrow on org_a's calendar, and an expired one.
insert into app.engagement_documents (engagement_id, document_kind, title, expires_on)
values (pg_temp.id('eng_art_a'), 'Agreement', 'Performance Agreement', private.org_today(pg_temp.id('org_a')) + 1) returning id as v_doc \gset
insert into app.engagement_documents (engagement_id, document_kind, title, expires_on)
values (pg_temp.id('eng_art_a'), 'Agreement', 'Old Rider', private.org_today(pg_temp.id('org_a')) - 1) returning id as v_doc_old \gset
select private.transition_lifecycle('engagement_document', 'app.engagement_documents', 'engagement_document_state',
  'app.engagement_document_state_transitions', 'engagement_document_id', d, 'Proposed', 'Sent', 'Sent.')
from unnest(array[:'v_doc'::uuid, :'v_doc_old'::uuid]) d;
select private.transition_lifecycle('engagement_document', 'app.engagement_documents', 'engagement_document_state',
  'app.engagement_document_state_transitions', 'engagement_document_id', d, 'Sent', 'Signed', 'Signed.')
from unnest(array[:'v_doc'::uuid, :'v_doc_old'::uuid]) d;

-- Personal items -------------------------------------------------------------------------------------------------------------

select pg_temp.as_user('frank');
insert into app.person_certifications (person_id, name, issuing_body, issued_on, expires_on)
values (pg_temp.id('frank'), 'CPR', 'Red Cross', '2025-01-01', :'frank_today'::date + 8) returning id as v_pcert \gset
select app.ensure_my_work_details() as v_wd \gset
update app.person_work_details set passport_expires_on = :'frank_today'::date + 30 where id = :'v_wd';
select pg_temp.as_user('nina');
insert into app.person_certifications (person_id, name, issuing_body, issued_on, expires_on)
values (pg_temp.id('nina'), 'CPR', 'Red Cross', '2025-01-01', :'nina_today'::date + 5) returning id as v_nina_cert \gset

-- ivy turns Email off for expiry reminders.
select pg_temp.as_user('ivy');
insert into app.person_notification_preferences (person_id, category_code, channel, enabled) values (pg_temp.id('ivy'), 'expiry_reminders', 'Email', false);
select pg_temp.as_platform();

create function pg_temp.reminded(p_table text, p_id uuid, p_person text) returns text
language sql as $$
  select string_agg(r.threshold_days::text, ',' order by r.threshold_days) from private.expiry_reminders_sent r
  where r.subject_table = p_table and r.subject_id = p_id and r.recipient_person_id = pg_temp.id(p_person);
$$;

select ok(private.send_expiry_reminders() >= 6, 'the job queues the reminders');

select is(pg_temp.reminded('certification_holders', :'v_holder', 'frank'), '7',
  'an org''s record expiring in 7 days on the org''s calendar reminds at 7 (the person''s calendar would say 8 or 9)');
select is(pg_temp.reminded('person_certifications', :'v_pcert', 'frank'), '30',
  'a profile certification 8 days out on the person''s calendar reminds at 30 (the org''s calendar would say 6 or 7)');
select is(pg_temp.reminded('certification_holders', :'v_lift_old', 'frank'), null, 'a renewed certification record does not remind');
select results_eq($$select n.kind, n.org_id, (n.message_args ->> 'days')::integer, n.message_args ? 'gatewayPath'
  from app.notifications n where n.subject_table = 'person_certifications' and n.recipient_person_id = pg_temp.id('frank')$$,
  format($$values ('certification.expiring'::text, %L::uuid, 8, false)$$, pg_temp.id('org_a')),
  'a personal item reaches frank through the org he belongs to, with the days left; a member''s link opens Atlas');
select is(pg_temp.reminded('person_work_details', :'v_wd', 'frank'), '30', 'his passport 30 days out reminds at 30');
select is((select n.message_args ->> 'kind' from app.notifications n where n.subject_table = 'person_work_details'), 'passport',
  'as a passport, so the copy names it');

select is(pg_temp.reminded('onboarding_items', :'v_item_ivy', 'ivy'), '14',
  'an onboarding item 10 days out reminds at its requirement''s own window of 14 days');
select ok((select n.message_args ->> 'gatewayPath' from app.notifications n where n.subject_table = 'onboarding_items'
           and n.recipient_person_id = pg_temp.id('ivy')) like '/work/engagements/ENG-%', 'linking an external party to the engagement in Gateway');
select is((select string_agg(d.channel::text, ',' order by d.channel) from app.notification_deliveries d
           join app.notifications n on n.id = d.notification_id
           where n.subject_table = 'onboarding_items' and n.recipient_person_id = pg_temp.id('ivy')), 'Push',
  'ivy''s preference holds: no email for the Expiry reminders category');
select is(pg_temp.reminded('onboarding_items', :'v_item_vendor', 'victor'), '7', 'the vendor account''s item 3 days out reminds its Owner at 7');
select is((select count(*)::integer from private.expiry_reminders_sent r where r.subject_id = :'v_item_vendor'
           and r.recipient_person_id in (pg_temp.id('fiona'), pg_temp.id('sam'))), 0, 'not its Finance or plain members');

select is(pg_temp.reminded('engagement_documents', :'v_doc', 'art'), '1', 'a signed agreement expiring tomorrow reminds at 1');
select is(pg_temp.reminded('engagement_documents', :'v_doc_old', 'art'), null, 'an expired one does not');

select results_eq($$select r.org_id, r.notification_id from private.expiry_reminders_sent r where r.subject_id = $$ || quote_literal(:'v_nina_cert'),
  $$values (null::uuid, null::uuid)$$, 'nina works with no org: her reminder is recorded and reaches nobody');

-- Idempotent.
select is(private.send_expiry_reminders(), 0, 'a second run queues nothing');
select is((select count(*)::integer from app.notifications where kind in ('certification.expiring', 'document.expiring', 'onboarding.item_expiring')
           and recipient_person_id in (pg_temp.id('frank'), pg_temp.id('ivy'), pg_temp.id('victor'), pg_temp.id('art'))), 6,
  'six reminders in all, one per item and recipient');

-- The thresholds.
select is(array[private.expiry_threshold(31), private.expiry_threshold(30), private.expiry_threshold(5), private.expiry_threshold(0),
  private.expiry_threshold(-1)], array[null, 30, 7, 1, null]::smallint[], 'standard thresholds: 30, 7 and 1 days, none once expired');
select is(array[private.expiry_threshold(20, 14), private.expiry_threshold(14, 14), private.expiry_threshold(8, 14), private.expiry_threshold(40, 45)],
  array[null, 14, 14, 45]::smallint[], 'a requirement''s window replaces the thresholds at or above it');

-- Renewing starts again: a new expiry date reminds anew.
update app.certification_holders set expires_on = private.org_today(pg_temp.id('org_a')) + 1 where id = :'v_holder';
select private.send_expiry_reminders();
select is(pg_temp.reminded('certification_holders', :'v_holder', 'frank'), '1,7', 'a new expiry date is reminded on its own thresholds');

select * from finish();
rollback;

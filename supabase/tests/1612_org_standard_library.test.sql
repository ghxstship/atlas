-- pgTAP: migration 1612, finding A65-027 (Section 7.2). A new org receives an editable copy of the XOS Standard
-- Library, each row naming its standard source; an existing org adopts it with the "Adopt Standard Library" action;
-- adopting again changes nothing and never overwrites an org's edits. Emergency codes are org data in numeric order.
-- Standard SOPs and documents naming the real CSMIA26 activation stay in canon and reach no org until the owner decides
-- RRR-67. Standard labor rates go only on a current card.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0200_identity_world.psql

select plan(46);

create function pg_temp.status(p_org uuid) returns table (library text, standard_count integer, adopted_count integer)
language sql as $$ select * from app.standard_library_status(p_org) $$;
-- What names the real CSMIA26 activation: its client, its site, the Miami bodies that permitted it, its permit numbers.
create function pg_temp.names_activation(p_text text) returns boolean
language sql immutable as $$ select p_text ~* '(spotify|wynwood|miami|biscayne|76th st|BD-2026-08914|EL-2026-04421)' $$;
-- Withheld rows an org holds a copy of, and copies whose text names the activation anyway.
create function pg_temp.activation_copies(p_org uuid) returns text
language sql as $$
  select string_agg(r, ', ' order by r) from (
    select 'SOP ' || coalesce(s.std_sop_id, s.code) as r from app.sops s where s.org_id = p_org and s.std_sop_id is not null
      and (s.std_sop_id = any (private.standard_library_withheld('sops')) or pg_temp.names_activation(s.title || ' ' || s.body))
    union all
    select 'document ' || d.std_document_id from app.documents d where d.org_id = p_org and d.std_document_id is not null
      and (d.std_document_id = any (private.standard_library_withheld('document_library')) or pg_temp.names_activation(d.title))
  ) x $$;

-- A new org receives its copy ------------------------------------------------------------------------------------
select pg_temp.as_user('nina');
insert into world values ('new_org', app.create_organization('Lantern Works', 'lantern-works'));
select is(
  (select string_agg(library, ', ' order by library) from pg_temp.status(pg_temp.id('new_org')) where adopted_count <> standard_count),
  null, 'a new org holds a copy of every Standard Library row');
select is((select count(*)::int from pg_temp.status(pg_temp.id('new_org'))), 10, 'all ten Standard Library tables are reported');
select is((select count(*)::int from app.emergency_codes where org_id = pg_temp.id('new_org')), 14, 'the 14 emergency codes are copied');
select is(
  (select string_agg(code, ', ' order by sort_order, code) from (select code, sort_order from app.emergency_codes
    where org_id = pg_temp.id('new_org') and deleted_at is null order by sort_order limit 3) c),
  'CODE_RED, CODE_ORANGE, CODE_YELLOW', 'emergency codes keep the canon order as numbers');
select is((select count(*)::int from app.sops where org_id = pg_temp.id('new_org') and std_sop_id is not null and published_at is null), 20,
  'the 20 SOPs not withheld arrive as drafts naming their standard SOP');
select is((select count(*)::int from app.sops s join xpms.std_sop x on x.sop_id = s.std_sop_id
  where s.org_id = pg_temp.id('new_org') and s.title = x.title and strpos(s.body, x.procedure_step_1) > 0), 20,
  'each SOP carries its title and procedure steps');
select is((select count(*)::int from app.verbiage_terms where org_id = pg_temp.id('new_org') and std_verbiage_id is not null and definition like '%.'), 213,
  'the 213 verbiage terms are copied with sentence definitions');
select is((select count(*)::int from app.documents where org_id = pg_temp.id('new_org') and std_document_id is not null and project_id is null), 23,
  'the 23 library documents not withheld are org documents naming their source');
select is((select count(*)::int from app.vendor_class_entitlements e join app.vendor_classes c on c.id = e.vendor_class_id
  where c.org_id = pg_temp.id('new_org') and c.std_vendor_class_id is not null), 59, 'the 59 vendor entitlements hang off the org''s vendor class copies');
select is((select count(distinct rate_card_id)::int from app.rate_card_lines where org_id = pg_temp.id('new_org') and canon_rate_card_id is not null), 1,
  'the standard labor rates are one org rate card');
select is((select count(*)::int from app.radio_channel_plan where org_id = pg_temp.id('new_org')), 32, 'the 32 radio channels form the org''s radio plan');
select is((select count(*)::int from app.enumerations where org_id = pg_temp.id('new_org')), 91, 'the 91 enumeration values are copied');
select is((select count(*)::int from app.role_library where org_id = pg_temp.id('new_org')), 35, 'the 35 Roles Library roles are copied');

-- Rows naming the real CSMIA26 activation stay in canon and reach no org (RRR-67) -----------------------------------
select is(
  (select string_agg(library || '=' || standard_count, ', ' order by library) from pg_temp.status(pg_temp.id('new_org'))
    where library in ('sops', 'document_library')),
  'document_library=23, sops=20', 'the status counts only the SOPs and documents an org can adopt');
select pg_temp.as_platform();
select is(pg_temp.activation_copies(pg_temp.id('new_org')), null,
  'a new org receives none of the withheld SOPs and documents, and no copy names the activation');
select is(
  (select count(*)::int from xpms.std_sop where sop_id = any (private.standard_library_withheld('sops'))) || ' SOPs, '
    || (select count(*)::int from xpms.std_document_library where record_id = any (private.standard_library_withheld('document_library'))) || ' documents',
  '14 SOPs, 11 documents', 'canon keeps the 14 withheld SOPs and 11 withheld documents');
select is(
  (select string_agg(id, ', ' order by id) from (
    select s.sop_id as id from xpms.std_sop s
    where pg_temp.names_activation(to_jsonb(s)::text) and s.sop_id <> all (private.standard_library_withheld('sops'))
    union all
    select d.record_id from xpms.std_document_library d
    where pg_temp.names_activation(to_jsonb(d)::text) and d.record_id <> all (private.standard_library_withheld('document_library'))) x),
  null, 'every canon SOP and document naming the activation is on the withheld list');
select is(
  (select count(*)::int from (
    select to_jsonb(x)::text as t from xpms.std_verbiage x union all select to_jsonb(x)::text from xpms.std_enumeration x
    union all select to_jsonb(x)::text from xpms.std_radio_channel x union all select to_jsonb(x)::text from xpms.std_vendor_class x
    union all select to_jsonb(x)::text from xpms.std_vendor_entitlement x union all select to_jsonb(x)::text from xpms.role x
    union all select to_jsonb(x)::text from xpms.rate_card x union all select to_jsonb(x)::text from xpms.emergency_code x) r
    where pg_temp.names_activation(r.t)),
  0, 'no other Standard Library table names the activation');
select pg_temp.as_user('nina');

-- The copies are the org's to edit ----------------------------------------------------------------------------------
update app.emergency_codes set label = 'Fire Alarm', sort_order = 20 where org_id = pg_temp.id('new_org') and code = 'CODE_RED';
select is((select label from app.emergency_codes where org_id = pg_temp.id('new_org') and code = 'CODE_RED'), 'Fire Alarm',
  'the Owner relabels an emergency code');
select is((select code from app.emergency_codes where org_id = pg_temp.id('new_org') and deleted_at is null order by sort_order, code limit 1),
  'CODE_ORANGE', 'and reorders it by number');
update app.sops set title = 'Rigging Inspection' where org_id = pg_temp.id('new_org') and std_sop_id = 'SOP-001';
update app.verbiage_terms set deleted_at = now() where org_id = pg_temp.id('new_org') and std_verbiage_id = 'VRB-001';
select is((select label from xpms.emergency_code where code = 'CODE_RED'), 'Code Red', 'canon keeps its own label');
select lives_ok($$insert into app.vendor_classes (org_id, name, std_vendor_class_id)
  select c.org_id, 'Touring Audio', c.std_vendor_class_id from app.vendor_classes c
  where c.org_id = (select id from world where key = 'new_org') and c.std_vendor_class_id is not null order by c.id limit 1$$,
  'a second class can still name a standard class the org holds a copy of');
select is((select adopted_count - standard_count from pg_temp.status(pg_temp.id('new_org')) where library = 'vendor_classes'), 0,
  'the status counts each standard class once');

-- Adopting again changes nothing ------------------------------------------------------------------------------------
create temporary table before_counts as select library, adopted_count from pg_temp.status(pg_temp.id('new_org'));
grant select on before_counts to public;
select is(
  (select string_agg(key || '=' || value, ', ') from jsonb_each_text(app.adopt_standard_library(pg_temp.id('new_org'))) where value <> '0'),
  null, 'adopting again copies nothing');
select is(
  (select count(*)::int from pg_temp.status(pg_temp.id('new_org')) s join before_counts b using (library) where s.adopted_count <> b.adopted_count),
  0, 'every library holds the same rows as before');
select is((select label from app.emergency_codes where org_id = pg_temp.id('new_org') and code = 'CODE_RED'), 'Fire Alarm',
  'an edited emergency code keeps the org''s label');
select is((select title from app.sops where org_id = pg_temp.id('new_org') and std_sop_id = 'SOP-001'), 'Rigging Inspection',
  'an edited SOP keeps the org''s title');
select ok((select deleted_at is not null from app.verbiage_terms where org_id = pg_temp.id('new_org') and std_verbiage_id = 'VRB-001'),
  'a removed term stays removed');
select is((select count(*)::int from app.verbiage_terms where org_id = pg_temp.id('new_org') and std_verbiage_id = 'VRB-001'), 1,
  'and is not copied again');

-- An existing org adopts with the action ----------------------------------------------------------------------------
select pg_temp.as_platform();
insert into world values ('demo_owner_user', '01920000-0000-7000-8000-000000000101'), ('demo', '01920000-0000-7000-8000-000000000001');
select pg_temp.as_user('demo_owner');
select is((select adopted_count from pg_temp.status(pg_temp.id('demo')) where library = 'emergency_codes'), 0,
  'an org created before the Standard Library was copied holds no emergency codes');
-- The demo org's rate card holds six standard rates; priced in euros, it must not take the US dollar ones.
update app.rate_cards set currency_code = 'EUR' where org_id = pg_temp.id('demo') and name = '2027 Crew Rates';
select is((app.adopt_standard_library(pg_temp.id('demo')) ->> 'emergency_codes')::int, 14, 'the action copies them');
select is((select count(*)::int from app.rate_card_lines l join app.rate_cards c on c.id = l.rate_card_id
  where c.org_id = pg_temp.id('demo') and c.name = '2027 Crew Rates'), 6, 'a card in another currency takes no standard rate');
select is((select count(*)::int from app.rate_card_lines l join app.rate_cards c on c.id = l.rate_card_id
  where c.org_id = pg_temp.id('demo') and c.currency_code = 'USD' and l.canon_rate_card_id is not null),
  (select count(*)::int from xpms.rate_card) - 6, 'the rest go on a card in US dollars');
select is((select count(*)::int from app.sops where org_id = pg_temp.id('demo') and std_sop_id is null), 4, 'the org''s own SOPs stay as they were');
select is((select count(*)::int from app.sops where org_id = pg_temp.id('demo') and std_sop_id is not null), 20,
  'every standard SOP not withheld is copied, a used code taking the next free one');
select pg_temp.as_platform();
select is(pg_temp.activation_copies(pg_temp.id('demo')), null,
  'an adopting org receives none of the withheld SOPs and documents either');
select pg_temp.as_user('demo_owner');
select is((select count(*)::int from app.sops where org_id = pg_temp.id('demo') and deleted_at is null)
  - (select count(distinct code)::int from app.sops where org_id = pg_temp.id('demo') and deleted_at is null), 0, 'no SOP code is used twice');
select is(
  (select string_agg(key || '=' || value, ', ') from jsonb_each_text(app.adopt_standard_library(pg_temp.id('demo'))) where value <> '0'),
  null, 'adopting twice changes nothing');

-- Standard labor rates go only on a current card -----------------------------------------------------------------
select pg_temp.as_platform();
insert into world values ('crew_agency', '01920000-0000-7000-8000-000010800301'), ('design_studio', '01920000-0000-7000-8000-000010800302');
create function pg_temp.rate_card(p_org text, p_name text, p_from date, p_to date, p_canon text) returns void
language plpgsql as $$
declare v_card uuid;
begin
  insert into app.rate_cards (org_id, name, currency_code, effective_from, effective_to)
  values (pg_temp.id(p_org), p_name, 'USD', p_from, p_to) returning id into v_card;
  insert into app.rate_card_lines (rate_card_id, role_code, worker_classification, pay_basis, arrangement,
    canon_rate_card_id, overtime_rule_id, rate_minor)
  select v_card, s.role_code, s.worker_classification, s.pay_basis, s.arrangement, s.rate_card_id, s.overtime_rule_id,
    s.standard_rate_minor
  from xpms.rate_card s where s.rate_card_id = p_canon;
  insert into world values (p_org || ':' || p_name, v_card);
end $$;
-- The crew agency's only card holding a standard rate ended last year; the design studio also has a current one.
select pg_temp.rate_card('crew_agency', '2025 Crew Rates', '2025-01-01', '2025-12-31', 'LRC-001');
select pg_temp.rate_card('design_studio', '2024 Rates', '2024-01-01', '2024-12-31', 'LRC-001');
select pg_temp.rate_card('design_studio', 'Current Rates', '2026-01-01', null, 'LRC-002');
select is((private.adopt_standard_library(pg_temp.id('crew_agency')) ->> 'labor_rate_cards')::int,
  (select count(*)::int from xpms.rate_card) - 1, 'an org whose only standard rate card has ended adopts the other standard rates');
select is((select count(*)::int from app.rate_card_lines where rate_card_id = pg_temp.id('crew_agency:2025 Crew Rates')), 1,
  'the ended card takes no standard rate');
select is((select count(*)::int from app.rate_card_lines l join app.rate_cards c on c.id = l.rate_card_id
  where c.org_id = pg_temp.id('crew_agency') and c.name = 'XOS Standard Labor Rates' and c.effective_to is null),
  (select count(*)::int from xpms.rate_card) - 1, 'they go on a new XOS Standard Labor Rates card');
select lives_ok($$select private.adopt_standard_library((select id from world where key = 'design_studio'))$$,
  'an org with an ended and a current card holding standard rates adopts');
select is((select count(*)::int from app.rate_card_lines where rate_card_id = pg_temp.id('design_studio:Current Rates')),
  (select count(*)::int from xpms.rate_card) - 1, 'standard rates go on the current card holding them, not the older ended one');
select is((select count(*)::int from app.rate_cards where org_id = pg_temp.id('design_studio') and deleted_at is null), 2,
  'and no new card is made');

-- Only the people who may change the org's canon extensions adopt ---------------------------------------------------
select pg_temp.as_user('dave');
select throws_ok($$select app.adopt_standard_library((select id from world where key = 'org_a'))$$, '42501', null,
  'a Member cannot adopt the Standard Library');
select pg_temp.as_user('xavier');
select throws_ok($$select * from app.standard_library_status((select id from world where key = 'org_a'))$$, '42501', null,
  'another org''s Owner cannot read the status');

select * from finish();
rollback;

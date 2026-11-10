-- 2620_offerings_model.sql
-- R3 Org and project offerings (RRR-181, ADR 0100 to 0104, owner decision 7). What the org's Gateway offers the
-- people it engages: travel, lodging, catering, parking, uniforms, per diem, radios, carts and a guest list. Every
-- offering defaults to Not Offered (decision 7; an absent claim resolves as a refusal, prompt lines 193-199).
--
--   * app.offering_kind is the one vocabulary of offerings. Later packages (project facts, asset classes,
--     requestable items, guest caps) name an offering by this enum, never by a text code.
--   * app.offering_mode: Not Offered, Provided, Reimbursed or Buyout.
--   * app.offering_rules: audience rules of the org or of one project, for every role type or one, and for every
--     vendor class or one, with an optional cap per engagement and per person. A rule sits between the locked org
--     value and the org and project settings (2621); private.effective_offerings (2622) resolves them.
--   * private.offering_mode_of_choice maps a stored setting choice to the mode, and private.offering_entitlement_module
--     names the Standard Library vendor entitlement module that answers for an offering, where one is unambiguous.
-- Removing a rule is a soft delete by update of deleted_at; a removed rule is a settings change, kept out of Trash.

create type app.offering_kind as enum (
  'Travel', 'Lodging', 'Catering', 'Parking', 'Uniforms', 'Per Diem', 'Radios', 'Carts', 'Guest List'
);
comment on type app.offering_kind is 'Services an org may offer the people it engages (R3, owner decision 7): the single vocabulary of offerings. Settings offerings.<kind>, audience rules, project facts, asset classes, requestable items and guest caps all name an offering by this enum.';

create type app.offering_mode as enum ('Not Offered', 'Provided', 'Reimbursed', 'Buyout');
comment on type app.offering_mode is 'How an offering reaches an engagement (R3): Not Offered (the default, decision 7), Provided by the org, Reimbursed against receipts, or paid as a Buyout.';

create or replace function private.offering_mode_of_choice(p_choice text)
returns app.offering_mode
language sql
immutable
set search_path = ''
as $$
  select case p_choice
    when 'not-offered' then 'Not Offered'
    when 'provided' then 'Provided'
    when 'reimbursed' then 'Reimbursed'
    when 'buyout' then 'Buyout'
    else 'Not Offered'
  end::app.offering_mode;
$$;

comment on function private.offering_mode_of_choice(text) is 'The offering mode of a stored offerings.* setting choice (not-offered, provided, reimbursed, buyout). Anything else, NULL included, is Not Offered: an absent claim resolves as a refusal (R3).';
revoke all on function private.offering_mode_of_choice(text) from public, anon, authenticated;
grant execute on function private.offering_mode_of_choice(text) to service_role;

create or replace function private.offering_entitlement_module(p_offering app.offering_kind)
returns text
language sql
immutable
set search_path = ''
as $$
  select case p_offering
    when 'Travel' then 'Travel'
    when 'Catering' then 'Catering'
    when 'Parking' then 'Parking'
    when 'Radios' then 'Radios'
  end;
$$;

comment on function private.offering_entitlement_module(app.offering_kind) is 'The vendor class entitlement module (app.vendor_class_entitlements.module, Standard Library modules of 0150) that answers for an offering: Travel, Catering, Parking and Radios. Every other offering has no unambiguous module (Vehicles and Quartermaster are not mapped) and returns NULL (R3).';
revoke all on function private.offering_entitlement_module(app.offering_kind) from public, anon, authenticated;
grant execute on function private.offering_entitlement_module(app.offering_kind) to service_role;

-- Audience rules --------------------------------------------------------------------------------------------------------

create table app.offering_rules (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  project_id uuid references app.projects (id),
  offering app.offering_kind not null,
  external_role_type app.external_role_type,
  vendor_class_id uuid references app.vendor_classes (id),
  offering_mode app.offering_mode not null,
  cap_per_engagement integer,
  cap_per_person integer,
  deleted_at timestamptz,
  constraint offering_rules_caps check (
    (cap_per_engagement is null or cap_per_engagement between 0 and 10000)
    and (cap_per_person is null or cap_per_person between 0 and 10000)),
  constraint offering_rules_vendor_class check (
    vendor_class_id is null or external_role_type is null or external_role_type = 'Vendor'),
  constraint offering_rules_caps_need_offer check (
    offering_mode <> 'Not Offered' or (cap_per_engagement is null and cap_per_person is null))
);
-- One live rule per audience. NULL (every project, role type or class) is a value of the audience here, so the
-- index treats NULLs as equal; an enum's text cast is not immutable and cannot stand in for it.
create unique index offering_rules_audience_key on app.offering_rules (
  org_id, project_id, offering, external_role_type, vendor_class_id) nulls not distinct
  where deleted_at is null;
create index offering_rules_project_id_idx on app.offering_rules (project_id);
create index offering_rules_vendor_class_id_idx on app.offering_rules (vendor_class_id);
call private.install_domain_table('app.offering_rules', null, null,
  array['app.projects', 'project_id', 'app.vendor_classes', 'vendor_class_id']);
call private.install_policies('app.offering_rules',
  $$org_id in (select private.my_org_ids()) and (project_id is null or project_id in (select private.readable_project_ids()))$$,
  $$(project_id is null and org_id in (select private.orgs_with_capability('projects.settings.write'))) or project_id in (select private.project_ids_with('projects.settings.write'))$$);
call private.describe('app.offering_rules', 'Audience rules of the org''s offerings (R3): for the whole org (project_id NULL) or one project, for every external role type or one, and for every vendor class or one, how an offering reaches the engagements they match, with optional caps. The most specific live rule matching an engagement wins over the org and project settings; a locked org setting wins over every rule (private.effective_offerings). Members read the org''s rules and those of projects they read; projects.settings.write edits them. Removal is a soft delete.', array[
  'project_id', 'Project the rule applies on; NULL for a rule of the whole org.',
  'offering', 'Offering the rule decides.',
  'external_role_type', 'External role type of the engagements the rule matches; NULL for every role type.',
  'vendor_class_id', 'Vendor class of the engagements the rule matches (the supplying vendor''s live class assignments); NULL for every class. Only with role type Vendor or every role type.',
  'offering_mode', 'How the offering reaches the matched engagements.',
  'cap_per_engagement', 'Most units of the offering one engagement may request, 0 to 10000; NULL for no cap. Only on an offered rule.',
  'cap_per_person', 'Most units of the offering one person may request, 0 to 10000; NULL for no cap. Only on an offered rule.'
]);
call private.install_default_retention('app.offering_rules');
call private.install_audit_trail('app.offering_rules');

insert into private.trash_excluded_tables (table_name, rationale) values
  ('offering_rules', 'A removed audience rule is a settings change; the project or org adds the rule again on its offerings settings.')
on conflict (table_name) do nothing;

select private.sync_trash_tables();

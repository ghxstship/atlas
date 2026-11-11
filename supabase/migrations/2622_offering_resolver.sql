-- 2622_offering_resolver.sql
-- R3 Org and project offerings (RRR-181, owner decision 7). One resolver answers, for an engagement, how each offering
-- reaches it. Gateway tabs (2623), the per diem writer (2625), project facts, asset caps and guest caps all read it.
--
--   * private.effective_offerings(engagement): one row per app.offering_kind, in enum order. The first layer that
--     answers wins:
--       a) Locked: the org's locked value of the setting (offerings.travel, offerings.lodging, offerings.catering,
--          offerings.parking, offerings.uniforms, offerings.per_diem, offerings.radios, offerings.carts,
--          offerings.guest_list), which no rule, class or project overrides.
--       b) Project Rule or Organization Rule: the most specific live app.offering_rules row that matches the
--          engagement (a project's rule over the org's, then a vendor class over every class, then a role type over
--          every role type, then the newest), with its caps.
--       c) Vendor Class: the live entitlements of the supplying vendor's classes for the offering's Standard Library
--          module (Travel, Catering, Parking, Radios): Provided when any permits it, else Not Offered.
--       d) Project, Organization or Default: the setting as it applies on the project (1320), Not Offered by default.
--     It never checks the caller and answers no rows for a missing or deleted engagement.
--   * private.offering_mode and private.assert_offered (refusal offering_not_offered) for writers inside the database.
--   * app.effective_offerings: the same rows for a reader of the engagement (opportunities.engagement.read or
--     advancing.packet.read on its project) or a party who reaches it (private.my_engagement_ids('engagement')).

create or replace function private.offering_setting_key(p_offering app.offering_kind)
returns text
language sql
immutable
set search_path = ''
as $$
  select case p_offering
    when 'Travel' then 'offerings.travel'
    when 'Lodging' then 'offerings.lodging'
    when 'Catering' then 'offerings.catering'
    when 'Parking' then 'offerings.parking'
    when 'Uniforms' then 'offerings.uniforms'
    when 'Per Diem' then 'offerings.per_diem'
    when 'Radios' then 'offerings.radios'
    when 'Carts' then 'offerings.carts'
    when 'Guest List' then 'offerings.guest_list'
  end;
$$;

comment on function private.offering_setting_key(app.offering_kind) is 'The registered setting of an offering: offerings.travel, offerings.lodging, offerings.catering, offerings.parking, offerings.uniforms, offerings.per_diem, offerings.radios, offerings.carts or offerings.guest_list (R3).';

create or replace function private.engagement_vendor_class_ids(p_engagement_id uuid)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select a.vendor_class_id
  from app.engagements e
  join app.vendors v on v.counterparty_id = e.counterparty_id and v.deleted_at is null
  join app.vendor_class_assignments a on a.vendor_id = v.id and a.deleted_at is null
  join app.vendor_classes k on k.id = a.vendor_class_id and k.deleted_at is null
  where e.id = p_engagement_id;
$$;

comment on function private.engagement_vendor_class_ids(uuid) is 'Live vendor classes of the engagement''s supplier: the live class assignments of the live vendor facet of its counterparty (0330). Empty when the engagement has no counterparty or the counterparty is not a vendor (R3).';

create or replace function private.effective_offerings(p_engagement_id uuid)
returns table (
  offering app.offering_kind,
  offering_mode app.offering_mode,
  cap_per_engagement integer,
  cap_per_person integer,
  source text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org uuid;
  v_project uuid;
  v_role app.external_role_type;
  v_classes uuid[];
  v_kind app.offering_kind;
  v_key text;
  v_text text;
  v_module text;
  v_permitted boolean;
  v_rule record;
begin
  select e.org_id, e.project_id, e.role_type into v_org, v_project, v_role
  from app.engagements e where e.id = p_engagement_id and e.deleted_at is null;
  if not found then
    return;
  end if;
  v_classes := array(select private.engagement_vendor_class_ids(p_engagement_id));

  foreach v_kind in array enum_range(null::app.offering_kind) loop
    v_key := private.offering_setting_key(v_kind);
    offering := v_kind;
    cap_per_engagement := null;
    cap_per_person := null;

    -- a) A locked org value wins over every rule, class and project value.
    select sv.value_text into v_text
    from app.setting_values sv
    where sv.org_id = v_org and sv.scope_kind = 'Organization' and sv.scope_id = v_org and sv.setting_key = v_key
      and sv.locked and sv.deleted_at is null;
    if found then
      offering_mode := private.offering_mode_of_choice(v_text);
      source := 'Locked';
      return next;
      continue;
    end if;

    -- b) The most specific live rule that matches the engagement.
    select r.offering_mode, r.cap_per_engagement, r.cap_per_person, r.project_id into v_rule
    from app.offering_rules r
    where r.org_id = v_org and r.offering = v_kind and r.deleted_at is null
      and (r.project_id = v_project or r.project_id is null)
      and (r.external_role_type is null or r.external_role_type = v_role)
      and (r.vendor_class_id is null or r.vendor_class_id = any (v_classes))
    order by (r.project_id is not null) desc, (r.vendor_class_id is not null) desc,
      (r.external_role_type is not null) desc, r.created_at desc, r.id desc
    limit 1;
    if found then
      offering_mode := v_rule.offering_mode;
      cap_per_engagement := v_rule.cap_per_engagement;
      cap_per_person := v_rule.cap_per_person;
      source := case when v_rule.project_id is null then 'Organization Rule' else 'Project Rule' end;
      return next;
      continue;
    end if;

    -- c) The supplier's vendor class entitlements, for offerings with an unambiguous Standard Library module.
    v_module := private.offering_entitlement_module(v_kind);
    if v_module is not null and cardinality(v_classes) > 0 then
      select bool_or(x.is_permitted) into v_permitted
      from app.vendor_class_entitlements x
      where x.vendor_class_id = any (v_classes) and x.deleted_at is null and lower(x.module) = lower(v_module);
      if v_permitted is not null then
        offering_mode := case when v_permitted then 'Provided' else 'Not Offered' end;
        source := 'Vendor Class';
        return next;
        continue;
      end if;
    end if;

    -- d) The setting as it applies on the project: the project, the org, then Not Offered.
    offering_mode := private.offering_mode_of_choice(private.project_setting_text(v_project, v_key));
    source := case
      when exists (select 1 from app.setting_values sv
                   where sv.setting_key = v_key and sv.scope_kind = 'Project' and sv.scope_id = v_project
                     and sv.deleted_at is null) then 'Project'
      when exists (select 1 from app.setting_values sv
                   where sv.org_id = v_org and sv.setting_key = v_key and sv.scope_kind = 'Organization'
                     and sv.scope_id = v_org and sv.deleted_at is null) then 'Organization'
      else 'Default'
    end;
    return next;
  end loop;
end;
$$;

comment on function private.effective_offerings(uuid) is 'How each offering reaches an engagement (R3, owner decision 7): one row per app.offering_kind in enum order with its mode, caps and source. The first layer that answers wins: the org''s locked setting value (Locked); the most specific live app.offering_rules row matching the engagement''s project, role type and supplier vendor classes (Project Rule or Organization Rule, with caps); the supplier''s vendor class entitlements for the Travel, Catering, Parking or Radios module (Vendor Class); the offerings.* setting on the project (Project, Organization, or Default, which is Not Offered). No rows for a missing or deleted engagement. Never checks the caller.';

create or replace function private.offering_mode(p_engagement_id uuid, p_offering app.offering_kind)
returns app.offering_mode
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select o.offering_mode from private.effective_offerings(p_engagement_id) o where o.offering = p_offering),
    'Not Offered'::app.offering_mode);
$$;

comment on function private.offering_mode(uuid, app.offering_kind) is 'The mode of one offering on an engagement through private.effective_offerings; Not Offered for a missing or deleted engagement (R3).';

create or replace function private.assert_offered(p_engagement_id uuid, p_offering app.offering_kind)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if private.offering_mode(p_engagement_id, p_offering) = 'Not Offered' then
    perform private.refuse('offering_not_offered', format('%s is not offered on this engagement''s project.', p_offering));
  end if;
end;
$$;

comment on function private.assert_offered(uuid, app.offering_kind) is 'Refuses offering_not_offered when the offering resolves Not Offered on the engagement (private.offering_mode). Writers of engagement requests call it; members of the org are not subject to offerings (R3).';

create or replace function app.effective_offerings(p_engagement_id uuid)
returns table (
  offering app.offering_kind,
  offering_mode app.offering_mode,
  cap_per_engagement integer,
  cap_per_person integer,
  source text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_project uuid;
begin
  perform private.require_person();
  select e.project_id into v_project from app.engagements e where e.id = p_engagement_id and e.deleted_at is null;
  if v_project is null
     or not (private.can_on_project(v_project, 'opportunities.engagement.read')
       or private.can_on_project(v_project, 'advancing.packet.read')
       or p_engagement_id in (select private.my_engagement_ids('engagement'))) then
    raise exception using errcode = '42501', message = 'the engagement is not readable';
  end if;
  return query select o.offering, o.offering_mode, o.cap_per_engagement, o.cap_per_person, o.source
    from private.effective_offerings(p_engagement_id) o;
end;
$$;

comment on function app.effective_offerings(uuid) is 'How each offering reaches an engagement, with the layer that decided it (private.effective_offerings, R3). For a reader of the engagement (opportunities.engagement.read or advancing.packet.read on its project) or a party who reaches it as an external principal; anyone else, and a missing or deleted engagement, gets 42501.';

revoke all on function private.offering_setting_key(app.offering_kind) from public, anon, authenticated;
revoke all on function private.engagement_vendor_class_ids(uuid) from public, anon, authenticated;
revoke all on function private.effective_offerings(uuid) from public, anon, authenticated;
revoke all on function private.offering_mode(uuid, app.offering_kind) from public, anon, authenticated;
revoke all on function private.assert_offered(uuid, app.offering_kind) from public, anon, authenticated;
grant execute on function private.offering_setting_key(app.offering_kind) to service_role;
grant execute on function private.engagement_vendor_class_ids(uuid) to service_role;
grant execute on function private.effective_offerings(uuid) to service_role;
grant execute on function private.offering_mode(uuid, app.offering_kind) to service_role;
grant execute on function private.assert_offered(uuid, app.offering_kind) to service_role;
revoke all on function app.effective_offerings(uuid) from public, anon;
grant execute on function app.effective_offerings(uuid) to authenticated, service_role;

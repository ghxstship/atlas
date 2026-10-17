-- 1060_a36.sql
-- A36 journey surfaces (Section 19.6: a demo tenant seed exercises every feature):
--   * Demo Partner Agency (demo-partner), a partner org whose Owner is partner@example.com, with the
--     wholesale agreement the platform records (20 percent off list, USD) and a default client brand.
--     The partner console journey creates its client orgs itself.
--   * a Gear Requests custom object in the demo org with a Stage choice field and two records.
-- Fixed ids in this file's block (...1060xxxx):
--   Partner Owner user and person   01920000-0000-7000-8000-000010600101
--   Partner org                     01920000-0000-7000-8000-000010600001
--   Partner Owner membership        01920000-0000-7000-8000-000010600201
--   Gear Requests object            01920000-0000-7000-8000-000010600301
-- Idempotent: every insert is guarded. The password is 0010's local demo value.

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, recovery_token, email_change_token_new, email_change
)
values (
  '00000000-0000-0000-0000-000000000000', '01920000-0000-7000-8000-000010600101', 'authenticated',
  'authenticated', 'partner@example.com', extensions.crypt('xos-demo-2026', extensions.gen_salt('bf')), now(),
  '{"provider": "email", "providers": ["email"]}'::jsonb, '{"full_name": "Demo Partner Owner"}'::jsonb,
  now(), now(), '', '', '', ''
)
on conflict (id) do nothing;

insert into auth.identities (id, user_id, provider_id, provider, identity_data, last_sign_in_at, created_at, updated_at)
values (
  '01920000-0000-7000-8000-000010600101', '01920000-0000-7000-8000-000010600101',
  '01920000-0000-7000-8000-000010600101', 'email',
  '{"sub": "01920000-0000-7000-8000-000010600101", "email": "partner@example.com", "email_verified": true}'::jsonb,
  null, now(), now()
)
on conflict (provider_id, provider) do nothing;

update app.people p set id = p.user_id
where p.user_id = '01920000-0000-7000-8000-000010600101' and p.id <> p.user_id;

do $$
declare
  c_partner constant uuid := '01920000-0000-7000-8000-000010600001';
  c_person constant uuid := '01920000-0000-7000-8000-000010600101';
  c_membership constant uuid := '01920000-0000-7000-8000-000010600201';
  c_org constant uuid := '01920000-0000-7000-8000-000000000001';
  c_admin constant uuid := '01920000-0000-7000-8000-000000000102';
  c_object constant uuid := '01920000-0000-7000-8000-000010600301';
  v_stage uuid;
  v_new uuid;
  v_record uuid;
begin
  -- The partner org, its Owner, terms and default brand. --------------------------------------------
  if not exists (select 1 from app.organizations o where o.id = c_partner) then
    insert into app.organizations (id, name, slug) values (c_partner, 'Demo Partner Agency', 'demo-partner');
    perform private.create_subscription(c_partner, 'team');
    insert into app.memberships (id, org_id, person_id, valid_from)
    values (c_membership, c_partner, c_person, '2026-03-16T09:00:00Z');
    insert into app.membership_roles (membership_id, role_id)
    select c_membership, r.id from app.roles r where r.org_id is null and r.code = 'owner';
    insert into app.partner_agreements (org_id, wholesale_discount_bps, currency_code, signed_on)
    values (c_partner, 2000, 'USD', '2026-03-16');
    insert into app.partner_default_brands (org_id, accent_hex, radius_scale, allow_client_override)
    values (c_partner, '#1F6FEB', 'Rounded', true);
  end if;

  -- A custom object in the demo org. -------------------------------------------------------------------
  if not exists (select 1 from app.organizations o where o.id = c_org)
     or exists (select 1 from app.custom_object_types t where t.id = c_object) then
    return;
  end if;
  perform set_config('request.jwt.claims', json_build_object('sub', c_admin, 'role', 'authenticated')::text, true);
  insert into app.custom_object_types (id, org_id, object_key, label, icon, default_view)
  values (c_object, c_org, 'gear_requests', 'Gear Requests', 'box', 'Board');
  insert into app.custom_object_fields (custom_object_type_id, field_key, label, data_type, required, filterable, sort_order)
  values (c_object, 'stage', 'Stage', 'Choice', true, true, 1) returning id into v_stage;
  insert into app.custom_object_fields (custom_object_type_id, field_key, label, data_type, required, filterable, sort_order)
  values (c_object, 'needed_by', 'Needed By', 'Date', false, false, 2);
  insert into app.custom_object_field_choices (custom_object_field_id, choice_key, label, sort_order)
  values (v_stage, 'requested', 'Requested', 1) returning id into v_new;
  insert into app.custom_object_field_choices (custom_object_field_id, choice_key, label, sort_order)
  values (v_stage, 'sourcing', 'Sourcing', 2), (v_stage, 'delivered', 'Delivered', 3);
  insert into app.custom_object_records (org_id, custom_object_type_id, title)
  values (c_org, c_object, 'Two follow spots for the main stage') returning id into v_record;
  insert into app.custom_object_values (custom_object_record_id, custom_object_field_id, value_choice_id)
  values (v_record, v_stage, v_new);
  insert into app.custom_object_records (org_id, custom_object_type_id, title)
  values (c_org, c_object, 'Spare wireless microphone kit') returning id into v_record;
  insert into app.custom_object_values (custom_object_record_id, custom_object_field_id, value_choice_id)
  values (v_record, v_stage, v_new);
  perform set_config('request.jwt.claims', '', true);
end
$$;

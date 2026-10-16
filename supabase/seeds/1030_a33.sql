-- 1030_a33.sql
-- A33 Platform workflow. The demo tenant's approval policy for purchase orders (Finance, then the
-- Owner), a purchase order that went through its first step and now waits on the Owner, a project
-- template with a published version and a draft, a relabeled record state, and a deleted template
-- in Trash (Section 19.6: a demo tenant seed exercises every feature). Builds on 0010, 0107 and
-- 0116 and loads cleanly without them. Idempotent: rows have fixed ids in this file's block
-- (...1030xxxx) and the file returns when its policy exists.

do $$
declare
  c_org constant uuid := '01920000-0000-7000-8000-000000000001';
  c_project constant uuid := '01920000-0000-7000-8000-000000001001';
  c_owner_m constant uuid := '01920000-0000-7000-8000-00000000a101';
  c_admin constant uuid := '01920000-0000-7000-8000-000000000102';
  c_producer constant uuid := '01920000-0000-7000-8000-000000000103';
  v_policy constant uuid := '01920000-0000-7000-8000-000010300001';
  v_template constant uuid := '01920000-0000-7000-8000-000010300101';
  v_retired_template constant uuid := '01920000-0000-7000-8000-000010300102';
  v_version1 constant uuid := '01920000-0000-7000-8000-000010300111';
  v_version2 constant uuid := '01920000-0000-7000-8000-000010300112';
  v_label constant uuid := '01920000-0000-7000-8000-000010300201';
  v_vendor uuid;
  v_po uuid;
  v_approval uuid;
begin
  if not exists (select 1 from app.organizations o where o.id = c_org)
     or not exists (select 1 from app.projects p where p.id = c_project)
     or not exists (select 1 from app.memberships m where m.id = c_owner_m)
     or exists (select 1 from app.approval_policies p where p.id = v_policy) then
    return;
  end if;

  -- Approval policy: every purchase order goes to Finance (Admins), then the Owner. -------------------
  insert into app.approval_policies (id, org_id, name, description, document_type)
  values (v_policy, c_org, 'Purchase orders', 'Every purchase order is reviewed by finance and signed off by the owner.', 'Purchase Order');
  insert into app.approval_steps (approval_policy_id, step_order, name, approver_role_id)
  select v_policy, 1, 'Finance review', r.id from app.roles r where r.org_id is null and r.code = 'admin';
  insert into app.approval_steps (approval_policy_id, step_order, name, approver_membership_id)
  values (v_policy, 2, 'Owner sign-off', c_owner_m);
  perform private.transition_lifecycle('approval_policy', 'app.approval_policies', 'policy_state',
    'app.approval_policy_state_transitions', 'approval_policy_id', v_policy, 'Draft', 'Active', 'Demo policy activated.');

  -- A purchase order in review: the Producer submits it, the Admin approves the first step. -------------
  select v.id into v_vendor from app.vendors v
  where v.org_id = c_org and v.deleted_at is null and v.vendor_state = 'Active' order by v.created_at limit 1;
  if v_vendor is not null then
    perform set_config('request.jwt.claims', json_build_object('sub', c_producer, 'role', 'authenticated')::text, true);
    insert into app.purchase_orders (project_id, vendor_id, currency_code)
    values (c_project, v_vendor, 'USD') returning id into v_po;
    insert into app.po_lines (purchase_order_id, line_number, description, quantity, unit_price_minor)
    values (v_po, 1, 'Stage barricade, per show day', 4, 85000),
           (v_po, 2, 'Barricade crew of four, per show day', 4, 160000);
    v_approval := app.request_approval('Purchase Order', v_po);
    perform set_config('request.jwt.claims', json_build_object('sub', c_admin, 'role', 'authenticated')::text, true);
    perform app.decide_approval(v_approval, true, 'Within the stage budget.');
    perform set_config('request.jwt.claims', '', true);
  end if;

  -- A project template: version 1 published, version 2 a draft adding the load-out. ----------------------
  insert into app.templates (id, org_id, name, description)
  values (v_template, c_org, 'Weekend Festival', 'Two-day outdoor festival on one stage, with advancing and safety records.'),
         (v_retired_template, c_org, 'Winter Gala Format', 'Single-night ballroom gala, replaced by the 2027 format.');
  insert into app.template_versions (id, template_id, notes, default_time_zone, default_currency_code, duration_days)
  values (v_version1, v_template, 'First format.', 'America/New_York', 'USD', 2);
  insert into app.template_items (template_version_id, item_kind, sort_order, name, scope_kind, scope_code_suffix,
    record_kind, xyz, phase_code, due_offset_days)
  values
    (v_version1, 'Scope Node', 1, 'Saturday Show', 'Show', 'E02', null, null, null, null),
    (v_version1, 'Scope Node', 2, 'Sunday Show', 'Show', 'E03', null, null, null, null),
    (v_version1, 'Record', 3, 'Book the stage rigging inspection', null, null, 'Inspection', 'Y', null, -7),
    (v_version1, 'Record', 4, 'Confirm the fire marshal walkthrough', null, null, 'Permit', 'Y', null, -14),
    (v_version1, 'Record', 5, 'Run the full-company rehearsal', null, null, 'Rehearsal', 'Z', null, -1);
  perform set_config('request.jwt.claims', json_build_object('sub', c_admin, 'role', 'authenticated')::text, true);
  perform app.publish_template_version(v_version1);
  perform set_config('request.jwt.claims', '', true);
  insert into app.template_versions (id, template_id, notes, default_time_zone, default_currency_code, duration_days)
  values (v_version2, v_template, 'Adds the load-out.', 'America/New_York', 'USD', 3);
  insert into app.template_items (template_version_id, item_kind, sort_order, name, scope_kind, scope_code_suffix,
    record_kind, xyz, phase_code, due_offset_days)
  select v_version2, i.item_kind, i.sort_order, i.name, i.scope_kind, i.scope_code_suffix, i.record_kind, i.xyz, i.phase_code, i.due_offset_days
  from app.template_items i where i.template_version_id = v_version1;
  insert into app.template_items (template_version_id, item_kind, sort_order, name, record_kind, xyz, due_offset_days)
  values (v_version2, 'Record', 6, 'Strike and load out the stage', 'Strike', 'Z', 2);

  -- The replaced gala template sits in Trash.
  update app.templates set deleted_at = now() where id = v_retired_template;

  -- Record state label: the org shows In Review as With Client. --------------------------------------------
  insert into app.org_state_labels (id, org_id, record_state, label)
  values (v_label, c_org, 'In Review', 'With Client')
  on conflict do nothing;
end
$$;

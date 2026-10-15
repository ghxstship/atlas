-- 0116_procurement_vendors_knowledge.sql
-- A16 Procurement, Vendors, Knowledge and Canon demo seed (Section 19.6: the demo tenant exercises every
-- feature). On the demo org and its project NWS (Northwind Summer Series):
--   * Vendors: two classes adopted from the Standard Library, the demo vendor organization (Demo Staging
--     Supply) as an Active vendor with bank details, an insurance certificate and a scorecard, a second
--     vendor (Bayline Audio Rentals) Onboarded with an approved prequalification, and a sponsor
--     (Gulfside Brewing) with two entitlements, an approved logo and a recorded delivery
--   * Procurement: an RFQ invited to both vendors, issued, closed with two sealed responses and awarded;
--     the purchase order created from the winning quote, approved by the Admin under spend authority,
--     sent, partly received, with an approved submittal; a catalog item bound to a canon element and the
--     vendor's product for it
--   * Knowledge: two SOPs (one published and acknowledged), a site document with a version, and three
--     verbiage terms
--   * Canon: an org discipline extension in the .50 to .99 range, proposed by the Admin and approved by
--     the Owner
-- Every change runs as the demo person who would make it, through the same RPCs and policies the app
-- uses, so ledgers, events, the activity feed and the audit ledger carry real entries. The Admin's
-- spend authority (Purchase Order and Invoice Approval, USD) is added only when the org has none for that
-- role, so the approval runs as it would for a configured org. Guarded on A30's demo org and A07's demo
-- project, and idempotent: nothing runs when the Bayline Audio Rentals vendor already exists.

do $$
declare
  c_org constant uuid := '01920000-0000-7000-8000-000000000001';
  c_project constant uuid := '01920000-0000-7000-8000-000000001001';
  c_vendor_org constant uuid := '01920000-0000-7000-8000-000000000301';
  c_owner constant uuid := '01920000-0000-7000-8000-000000000101';
  c_admin constant uuid := '01920000-0000-7000-8000-000000000102';
  c_producer constant uuid := '01920000-0000-7000-8000-000000000103';
  v_admin_role uuid := (select r.id from app.roles r where r.org_id is null and r.code = 'admin');
  v_class_staging uuid;
  v_class_audio uuid;
  v_cp_staging uuid;
  v_cp_audio uuid;
  v_cp_sponsor uuid;
  v_staging uuid;
  v_audio uuid;
  v_prequal uuid;
  v_rfq uuid;
  v_resp_staging uuid;
  v_resp_audio uuid;
  v_po uuid;
  v_line1 uuid;
  v_line2 uuid;
  v_receipt uuid;
  v_element text;
  v_binding uuid;
  v_submittal uuid;
  v_ent_logo uuid;
  v_ent_naming uuid;
  v_asset uuid;
  v_sop1 uuid;
  v_sop2 uuid;
  v_doc uuid;
  v_ext uuid;
  v_ext_code text;
begin
  if not exists (select 1 from app.organizations where id = c_org)
     or not exists (select 1 from app.projects where id = c_project)
     or exists (select 1 from app.vendors v join app.counterparties c on c.id = v.counterparty_id
                join app.organizations o on o.id = c.organization_id
                where v.org_id = c_org and o.name = 'Bayline Audio Rentals' and v.deleted_at is null) then
    return;
  end if;

  -- Owner: classes, companies, vendors, bank details and spend authority. ---------------------------------
  perform set_config('request.jwt.claims', json_build_object('sub', c_owner, 'role', 'authenticated')::text, true);

  insert into app.vendor_classes (org_id, name, std_vendor_class_id, description)
  select c_org, coalesce(s.class, s.record_id), s.record_id, s.description
  from xpms.std_vendor_class s order by s.source_row limit 1
  returning id into v_class_staging;
  insert into app.vendor_classes (org_id, name, description)
  values (c_org, 'Audio Rental Houses', 'Companies renting sound reinforcement packages with crew.')
  returning id into v_class_audio;

  select c.id into v_cp_staging from app.counterparties c
  where c.org_id = c_org and c.organization_id = c_vendor_org and c.deleted_at is null;
  if v_cp_staging is null then
    v_cp_staging := app.create_counterparty(c_org, null, 'Equipment Rental', c_vendor_org);
  end if;
  v_cp_audio := app.create_counterparty(c_org, 'Bayline Audio Rentals', 'Audio Supply');
  v_cp_sponsor := app.create_counterparty(c_org, 'Gulfside Brewing', 'Sponsor');

  insert into app.vendors (counterparty_id, payment_terms_days, default_currency_code)
  values (v_cp_staging, 30, 'USD') returning id into v_staging;
  insert into app.vendors (counterparty_id, payment_terms_days, default_currency_code)
  values (v_cp_audio, 45, 'USD') returning id into v_audio;
  insert into app.vendor_class_assignments (vendor_id, vendor_class_id) values
    (v_staging, v_class_staging), (v_audio, v_class_audio);

  perform app.transition_vendor(v_staging, 'Prospect', 'Onboarded', 'W-9 and insurance certificate received.');
  perform app.transition_vendor(v_staging, 'Onboarded', 'Active', 'Approved for the 2027 season.');
  perform app.transition_vendor(v_audio, 'Prospect', 'Onboarded', 'Onboarding packet complete.');

  insert into app.vendor_bank_accounts (vendor_id, bank_name, account_holder, account_last4, account_number, routing_number)
  values (v_staging, 'Example Community Bank', 'Demo Staging Supply', '4321', '000123454321', '000000000');

  if v_admin_role is not null and not exists (
    select 1 from app.spend_authorities a where a.org_id = c_org and a.role_id = v_admin_role and a.deleted_at is null
      and a.document_type = 'Purchase Order' and a.currency_code = 'USD') then
    insert into app.spend_authorities (org_id, role_id, document_type, currency_code, limit_minor)
    values (c_org, v_admin_role, 'Purchase Order', 'USD', 5000000);
  end if;
  if v_admin_role is not null and not exists (
    select 1 from app.spend_authorities a where a.org_id = c_org and a.role_id = v_admin_role and a.deleted_at is null
      and a.document_type = 'Invoice Approval' and a.currency_code = 'USD') then
    insert into app.spend_authorities (org_id, role_id, document_type, currency_code, limit_minor)
    values (c_org, v_admin_role, 'Invoice Approval', 'USD', 5000000);
  end if;

  -- Producer: compliance, scores, sourcing, ordering, receiving, sponsors and knowledge. --------------------
  perform set_config('request.jwt.claims', json_build_object('sub', c_producer, 'role', 'authenticated')::text, true);

  insert into app.insurance_certificates (vendor_id, insurer, policy_identifier, coverage_type, coverage_limit_minor,
    currency_code, valid_from, valid_to, document_uri)
  values (v_staging, 'Example Mutual Insurance', 'GL-2027-0042', 'General Liability', 200000000, 'USD',
    date '2027-01-01', date '2027-12-31', 'https://files.example.com/demo/coi-gl-2027.pdf');
  insert into app.vendor_scorecards (vendor_id, project_id, period_end, quality_score, delivery_score, safety_score, note)
  values (v_staging, c_project, date '2026-12-31', 5, 4, 5, 'Decks arrived a day late; build quality and site safety were excellent.');
  insert into app.prequalifications (vendor_id, scope_note)
  values (v_audio, 'Flown line array systems up to 1,500 kg per hang.') returning id into v_prequal;

  insert into app.rfqs (project_id, title, responses_due_at)
  values (c_project, 'Main stage audio package', timestamptz '2027-01-15 17:00:00-05') returning id into v_rfq;
  insert into app.rfq_invitations (rfq_id, vendor_id) values (v_rfq, v_staging), (v_rfq, v_audio);
  perform app.transition_rfq(v_rfq, 'Proposed', 'Issued', 'Specification and invitations ready.');
  insert into app.rfq_responses (rfq_id, vendor_id, valid_until) values (v_rfq, v_staging, date '2027-02-28')
    returning id into v_resp_staging;
  insert into app.rfq_response_lines (rfq_response_id, description, quantity, unit_price_minor, currency_code) values
    (v_resp_staging, 'Line array system, 12 boxes per side, per show day', 4, 450000, 'USD'),
    (v_resp_staging, 'Audio crew of three, per show day', 4, 180000, 'USD');
  insert into app.rfq_responses (rfq_id, vendor_id, valid_until) values (v_rfq, v_audio, date '2027-02-15')
    returning id into v_resp_audio;
  insert into app.rfq_response_lines (rfq_response_id, description, quantity, unit_price_minor, currency_code) values
    (v_resp_audio, 'Line array system, 12 boxes per side, per show day', 4, 495000, 'USD'),
    (v_resp_audio, 'Audio crew of three, per show day', 4, null, 'USD');
  perform app.transition_rfq(v_rfq, 'Issued', 'Closed', 'Deadline reached; responses unsealed.');
  perform app.transition_rfq(v_rfq, 'Closed', 'Awarded', 'Lowest fully priced quote with crew included.');

  insert into app.purchase_orders (project_id, vendor_id, rfq_response_id, currency_code)
  values (c_project, v_staging, v_resp_staging, 'USD') returning id into v_po;
  insert into app.po_lines (purchase_order_id, line_number, description, quantity, unit_basis, unit_price_minor)
  values (v_po, 1, 'Line array system, 12 boxes per side, per show day', 4, null, 450000) returning id into v_line1;
  insert into app.po_lines (purchase_order_id, line_number, description, quantity, unit_basis, unit_price_minor)
  values (v_po, 2, 'Audio crew of three, per show day', 4, null, 180000) returning id into v_line2;

  insert into app.submittals (project_id, vendor_id, purchase_order_id, submittal_kind, title, spec_reference, due_on)
  values (c_project, v_staging, v_po, 'Product Data', 'Line array rigging data and weights', 'AV-2.4', date '2027-02-01')
  returning id into v_submittal;
  perform app.transition_submittal(v_submittal, 'Proposed', 'Submitted', 'Rigging data received from the vendor.');

  insert into app.sponsor_entitlements (project_id, counterparty_id, description, quantity, due_on)
  values (c_project, v_cp_sponsor, 'Logo on the main stage scrims.', 4, date '2027-03-12') returning id into v_ent_logo;
  insert into app.sponsor_entitlements (project_id, counterparty_id, description, due_on)
  values (c_project, v_cp_sponsor, 'Naming rights on the VIP terrace.', date '2027-03-12') returning id into v_ent_naming;
  insert into app.sponsor_assets (sponsor_entitlement_id, asset_kind, title, usage_note, due_on)
  values (v_ent_logo, 'Logo', 'Gulfside Brewing primary logo', 'Scrims at stage left and stage right.', date '2027-02-15')
  returning id into v_asset;
  perform app.transition_sponsor_asset(v_asset, 'Proposed', 'Submitted', 'Vector artwork received from the sponsor.');

  -- Admin: approvals by someone other than the requester. ---------------------------------------------------
  perform set_config('request.jwt.claims', json_build_object('sub', c_admin, 'role', 'authenticated')::text, true);

  perform app.decide_prequalification(v_prequal, 'Approved', date '2027-12-31');
  perform app.approve_purchase_order(v_po, 'Within budget and spend authority.');
  perform app.transition_submittal(v_submittal, 'Submitted', 'Approved', 'Hang weights within the roof load.');
  perform app.transition_sponsor_asset(v_asset, 'Submitted', 'Approved', 'Brand guidelines met.');

  -- Producer: send, receive, deliver. ------------------------------------------------------------------------
  perform set_config('request.jwt.claims', json_build_object('sub', c_producer, 'role', 'authenticated')::text, true);

  perform app.transition_purchase_order(v_po, 'Approved', 'Sent', 'Emailed to the vendor with the rider.');
  insert into app.goods_receipts (purchase_order_id, received_at, note)
  values (v_po, timestamptz '2027-03-11 08:30:00-05', 'Two show days of the line array arrived; cases intact.')
  returning id into v_receipt;
  insert into app.receipt_lines (goods_receipt_id, po_line_id, quantity_received) values (v_receipt, v_line1, 2);
  insert into app.entitlement_deliveries (sponsor_entitlement_id, delivered_on, quantity_delivered, note)
  values (v_ent_logo, date '2027-03-12', 2, 'Stage left and stage right scrims hung for opening night.');

  -- Owner: catalog, knowledge and canon extension decisions. --------------------------------------------------
  perform set_config('request.jwt.claims', json_build_object('sub', c_owner, 'role', 'authenticated')::text, true);

  select e.element_id into v_element from xpms.elements e order by e.element_id limit 1;
  insert into app.catalog_bindings (org_id, element_id, name, unit_basis, default_unit_price_minor, currency_code)
  select c_org, e.element_id, e.item, e.unit_basis, null, null from xpms.elements e where e.element_id = v_element
  returning id into v_binding;
  insert into app.vendor_products (vendor_id, catalog_binding_id, vendor_sku, unit_price_minor, currency_code, lead_time_days)
  values (v_staging, v_binding, 'DSS-DECK-0408', null, null, 14);

  insert into app.sops (org_id, code, title, body)
  values (c_org, 'SOP-001', 'Load-in and staging sequence',
    'Confirm the dock slot with logistics. Stage cases by department in the marshalling area. Rigging goes first, then lighting, then audio.')
  returning id into v_sop1;
  insert into app.sops (org_id, code, title, body)
  values (c_org, 'SOP-002', 'Hot works permit check',
    'Request the hot works permit from the safety lead before any welding or cutting. Keep a fire watch for 60 minutes after work ends.')
  returning id into v_sop2;
  update app.sops set published_at = now() where id = v_sop1;

  insert into app.documents (org_id, project_id, title) values (c_org, c_project, 'Bayfront Pier site safety plan')
    returning id into v_doc;
  insert into app.document_versions (document_id, storage_uri, checksum_sha256)
  values (v_doc, 'https://files.example.com/demo/nws-site-safety-plan-v1.pdf', encode(extensions.digest('nws-site-safety-plan-v1', 'sha256'), 'hex'));

  insert into app.verbiage_terms (org_id, term, casing_rule, definition) values
    (c_org, 'Load In', 'Title Case in labels, sentence case in prose', 'The arrival and installation of equipment before a show.'),
    (c_org, 'Run of Show', 'Title Case in labels', 'The cue-by-cue running order of a show.'),
    (c_org, 'Strike', 'Sentence case', 'The removal of equipment after the last show.');

  -- Field and crew read SOPs; the Producer acknowledges the published one.
  perform set_config('request.jwt.claims', json_build_object('sub', c_producer, 'role', 'authenticated')::text, true);
  insert into app.sop_acknowledgments (sop_id, person_id) values (v_sop1, c_producer);

  -- Admin proposes a discipline extension; the Owner approves it.
  perform set_config('request.jwt.claims', json_build_object('sub', c_admin, 'role', 'authenticated')::text, true);
  select format('5000.%s', n) into v_ext_code
  from generate_series(90, 99) n
  where not exists (select 1 from xpms.dim_discipline d where d.disc_code = format('5000.%s', n))
  order by n limit 1;
  if v_ext_code is not null and exists (select 1 from xpms.dim_department d where d.dept_code = '5000') then
    insert into app.canon_extension_proposals (org_id, extension_level, parent_code, proposed_code, label, rationale)
    values (c_org, 'Discipline', '5000', v_ext_code, 'Drone Light Shows',
      'Most outdoor shows now include a drone light show that needs its own crew and permits.')
    returning id into v_ext;
    perform set_config('request.jwt.claims', json_build_object('sub', c_owner, 'role', 'authenticated')::text, true);
    perform app.decide_canon_extension(v_ext, 'Proposed', 'Approved', 'Core service for the 2027 season.');
  end if;

  perform set_config('request.jwt.claims', '', true);
end $$;

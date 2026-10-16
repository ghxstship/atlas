-- 0995_procurement_vendors_knowledge_late.sql
-- A16 late slot (ADR 0022: 0995 to 0999), after A18's platform services (0500 to 0590):
--   * retention policies for the tables A16 added in 0490 and 0492
--   * the audit trail (app.audit_events) on every procurement, vendor, knowledge and canon extension
--     table, so each insert, update and soft delete is a compliance event whose diff leaves out
--     Restricted columns
--   * comment and attachment subjects (0580) for the A16 tables A18 did not register

-- Retention -------------------------------------------------------------------------------------------

call private.install_default_retention('app.canon_extension_proposals');
call private.install_default_retention('app.canon_extension_state_transitions');
call private.install_default_retention('app.submittals');
call private.install_default_retention('app.submittal_state_transitions');
call private.install_default_retention('app.sponsor_assets');
call private.install_default_retention('app.sponsor_asset_state_transitions');
call private.install_default_retention('app.entitlement_deliveries');

-- Audit trail (A18 app.audit_events) -------------------------------------------------------------------

call private.install_audit_trail('app.canon_extension_proposals');
call private.install_audit_trail('app.vendors');
call private.install_audit_trail('app.vendor_classes');
call private.install_audit_trail('app.vendor_class_assignments');
call private.install_audit_trail('app.vendor_bank_accounts');
call private.install_audit_trail('app.prequalifications');
call private.install_audit_trail('app.insurance_certificates');
call private.install_audit_trail('app.vendor_scorecards');
call private.install_audit_trail('app.sponsor_entitlements');
call private.install_audit_trail('app.sponsor_assets');
call private.install_audit_trail('app.entitlement_deliveries');
call private.install_audit_trail('app.rfqs');
call private.install_audit_trail('app.rfq_invitations');
call private.install_audit_trail('app.rfq_responses');
call private.install_audit_trail('app.rfq_response_lines');
call private.install_audit_trail('app.purchase_orders');
call private.install_audit_trail('app.po_lines');
call private.install_audit_trail('app.po_change_orders');
call private.install_audit_trail('app.goods_receipts');
call private.install_audit_trail('app.receipt_lines');
call private.install_audit_trail('app.invoice_matches');
call private.install_audit_trail('app.submittals');
call private.install_audit_trail('app.catalog_bindings');
call private.install_audit_trail('app.vendor_products');
call private.install_audit_trail('app.sops');
call private.install_audit_trail('app.sop_acknowledgments');
call private.install_audit_trail('app.documents');
call private.install_audit_trail('app.document_versions');
call private.install_audit_trail('app.verbiage_terms');

-- Comment and attachment subjects -----------------------------------------------------------------------

insert into private.comment_subjects (table_name) values
  ('app.goods_receipts'),
  ('app.invoice_matches'),
  ('app.catalog_bindings'),
  ('app.prequalifications'),
  ('app.insurance_certificates'),
  ('app.vendor_scorecards'),
  ('app.sponsor_entitlements'),
  ('app.sops'),
  ('app.submittals'),
  ('app.sponsor_assets'),
  ('app.entitlement_deliveries'),
  ('app.canon_extension_proposals')
on conflict do nothing;

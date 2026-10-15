-- 0360_people_spend_document_type.sql
-- A03 Domain Data (RRR-71). Adds Requisition to the spend authority document types (Section 8.1), so a
-- staffing requisition is approved under spend authority before it turns into an opportunity (ADR 0019,
-- open decision "spend authority before publishing"). A new enum value is usable only after the
-- transaction that adds it commits, so it ships in its own migration ahead of 0361_people.sql.

alter type app.spend_document_type add value if not exists 'Requisition' after 'Payroll Run';

comment on type app.spend_document_type is 'Document types spend authority limits apply to (Section 8.1). Requisition is a declared extension: staffing requisitions are approved under spend authority before an opportunity is published from them.';

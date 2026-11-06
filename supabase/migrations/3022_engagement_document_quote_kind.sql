-- 3022_engagement_document_quote_kind.sql
-- B13 (RRR-237, gap G-188 phase 1, S14.5-01, ADR 0152). A client accepts a quote by signing a Quote engagement document
-- through the existing signing paths (0769 token links, 0710 signed in). A new enum value cannot be used in the
-- transaction that adds it, so the value is added here alone; 3023 and 3024 use it. A Quote document is created only by
-- app.send_quote_version (3023), and the v1 engagementDocuments resource never lists one, so its frozen enum holds.

alter type app.engagement_document_kind add value 'Quote';

comment on type app.engagement_document_kind is 'Kinds of document exchanged on an engagement (Section 4.4.4 onboarding packets and close-out). Quote (3022) is a client quote version sent for signature; only app.send_quote_version creates one, and the v1 API omits it.';

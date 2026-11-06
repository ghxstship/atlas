-- 6275_record_document_body.sql
-- B15 governance drafts (RRR-239, parity gap G-240; ADR 0154). A Document record has only a storage URI and a version label
-- (0311), and app.documents has no text column (ADR 0044), so an event plan, brief, approval pack or waste plan has nowhere
-- to live. The body is saved through the same extension path as version_label; a draft fills the editor and the editor's
-- Save is the write (ADR 0051 item 3).

alter table app.record_document add column body text,
  add constraint record_document_body_length check (body is null or char_length(btrim(body)) between 1 and 100000);
comment on column app.record_document.body is 'The document''s text, when it is written here rather than stored as a file: an event plan, brief, approval pack or waste plan a person saved (B15).';

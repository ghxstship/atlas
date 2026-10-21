-- 1392_chat_translation_retention.sql
-- Orchestrator block (ADR 0022, 1390 to 1399), RRR-125. A cached chat translation leaves with its message.
--
-- 1363 (A80) declared app.chat_message_translations.chat_message_id with no delete action, and live translations
-- are never removed: only an edit or a soft delete retires them, and retention then keeps a retired translation 90
-- days. The nightly purge of chat messages past communication.message_retention_days (1324) hard-deletes each org's
-- old messages in one statement, so a single translated message made the statement fail with a foreign key
-- violation. Its per-org exception handler rolled the whole org back and logged an error, every night, and the
-- org's retention setting stopped applying. A translation is derived data with no meaning once its message is
-- gone, so the reference now cascades: the purge (inside its retention_purge trusted operation) and any later hard
-- delete of a message remove its translations in the same statement.

alter table app.chat_message_translations
  drop constraint chat_message_translations_chat_message_id_fkey,
  add constraint chat_message_translations_chat_message_id_fkey
    foreign key (chat_message_id) references app.chat_messages (id) on delete cascade;

comment on constraint chat_message_translations_chat_message_id_fkey on app.chat_message_translations is
  'A translation leaves with its message (1392): hard-deleting a message, as the chat retention purge does (1324), deletes its cached translations, live or retired.';

comment on column app.chat_message_translations.chat_message_id is 'Message translated. Deleting the message deletes its translations (1392).';

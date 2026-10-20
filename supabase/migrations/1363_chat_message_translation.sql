-- 1363_chat_message_translation.sql
-- A80 (RRR-125), finding A65-012, Section 4.9 Chat ("message translation"): the chat stores each message's language
-- (0800) but nothing translated it. This migration is the database side of the translation seam in @xos/platform
-- (translateChatMessage):
--   * communication.message_translation (packages/schemas/settings/a80.yaml): off by default; an org turns it on in
--     Settings, Communication. The platform also runs no provider unless XOS_MESSAGE_TRANSLATION=google
--   * app.chat_message_translations: one translation per message and reader language, so each is paid for once
--     and every later reader gets the cached text; readable by the conversation's members only
--   * app.message_translation_enabled and app.record_chat_message_translation for the service

select private.define_setting('communication.message_translation', 'Boolean', 'org.communication.write', array['organization'], false, p_default_boolean => false);

create table app.chat_message_translations (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  chat_message_id uuid not null references app.chat_messages (id),
  target_language text not null,
  source_language text,
  body text not null,
  provider text not null,
  constraint chat_message_translations_target_format check (target_language ~ '^[a-z]{2,3}(-[A-Z]{2})?$'),
  constraint chat_message_translations_source_format check (source_language is null or source_language ~ '^[a-z]{2,3}(-[A-Z]{2})?$'),
  constraint chat_message_translations_body_length check (char_length(body) between 1 and 8000),
  constraint chat_message_translations_provider_format check (provider ~ '^[a-z][a-z0-9_-]{1,30}$')
);

call private.install_domain_table('app.chat_message_translations', 'app.chat_messages', 'chat_message_id');
create unique index chat_message_translations_key on app.chat_message_translations (chat_message_id, target_language) where deleted_at is null;
call private.describe('app.chat_message_translations', 'Machine translations of chat messages (Section 4.9), one per message and reader language, cached so each is translated once. Written only by the translation service while the org has communication.message_translation on; readable by the conversation''s members.', array[
  'chat_message_id', 'Message translated.',
  'target_language', 'Language of the translation (BCP 47), the reader''s language.',
  'source_language', 'Language the message was written in, as stored or as the provider detected it.',
  'body', 'Translated text.',
  'provider', 'Translation provider, for example google.'
]);

create or replace function private.is_readable_chat_message(p_message_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from app.chat_messages m
                 where m.id = p_message_id and m.deleted_at is null and m.conversation_id in (select private.my_conversation_ids()));
$$;

comment on function private.is_readable_chat_message(uuid) is 'True when the signed-in person takes part in the conversation of a live chat message. Takes the id as an argument (ADR 0016 rule 14).';

call private.install_policies('app.chat_message_translations', $$private.is_readable_chat_message(chat_message_id)$$);

create or replace function app.message_translation_enabled(p_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.org_boolean_setting(p_org_id, 'communication.message_translation');
$$;

comment on function app.message_translation_enabled(uuid) is 'Whether an org has chat message translation on (communication.message_translation, off by default).';

create or replace function app.record_chat_message_translation(
  p_chat_message_id uuid,
  p_target_language text,
  p_body text,
  p_source_language text,
  p_provider text
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_org uuid := (select m.org_id from app.chat_messages m where m.id = p_chat_message_id and m.deleted_at is null);
  v_id uuid;
begin
  if v_org is null then
    perform private.refuse('chat_message_unknown', 'No such message.');
  end if;
  if not private.org_boolean_setting(v_org, 'communication.message_translation') then
    perform private.refuse('message_translation_off', 'Message translation is off in this organization.');
  end if;
  insert into app.chat_message_translations (chat_message_id, target_language, source_language, body, provider)
  values (p_chat_message_id, p_target_language, p_source_language, p_body, p_provider)
  on conflict (chat_message_id, target_language) where deleted_at is null do update
    set body = excluded.body, source_language = excluded.source_language, provider = excluded.provider
  returning id into v_id;
  return v_id;
end;
$$;

comment on function app.record_chat_message_translation(uuid, text, text, text, text) is 'Translation service API (service role): caches the translation of a message into a reader''s language, once per message and language. Refused while the org has message translation off.';

-- A translation leaves with its message: editing or deleting the text drops the cached translations.
create or replace function private.drop_stale_translations()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.body is distinct from old.body or (new.deleted_at is not null and old.deleted_at is null) then
    update app.chat_message_translations set deleted_at = now() where chat_message_id = new.id and deleted_at is null;
  end if;
  return new;
end;
$$;

comment on function private.drop_stale_translations() is 'Retires a message''s cached translations when its text changes or it is deleted, so no reader sees a translation of words that are gone.';

create trigger t91_drop_stale_translations after update on app.chat_messages
  for each row execute function private.drop_stale_translations();

call private.install_default_retention('app.chat_message_translations', interval '90 days');

revoke all on function private.is_readable_chat_message(uuid) from public, anon;
grant execute on function private.is_readable_chat_message(uuid) to authenticated, service_role;
revoke all on function app.message_translation_enabled(uuid) from public, anon, authenticated;
grant execute on function app.message_translation_enabled(uuid) to service_role;
revoke all on function app.record_chat_message_translation(uuid, text, text, text, text) from public, anon, authenticated;
grant execute on function app.record_chat_message_translation(uuid, text, text, text, text) to service_role;
revoke all on function private.drop_stale_translations() from public, anon, authenticated;

-- 1411_project_inbox_triage.sql
-- A84 (RRR-129), finding A65-018, Section 4.6.5: the project inbox gets a surface. 0550 stored inbox addresses and the
-- mail the inbound-email Edge Function delivers, but nobody could see an address, replace it, or file or discard mail.
--   * one live address per project: app.create_project_inbox returns the live address or makes one,
--     app.replace_project_inbox retires it for a new one (when the old one draws spam) and app.disable_project_inbox
--     stops the inbox; disabled_at is set once with the database time and never cleared, and local_part never changes
--   * filing (app.file_inbound_message): a coordinator who files documents on the project turns verified mail into a
--     Document record of the project, optionally filed to one record of the project they can open; the mail's
--     subject, sender and text are posted as a comment on the document and on that record
--   * discarding (app.discard_inbound_message) keeps the mail, stamps who discarded it, when and why, and the audit
--     ledger records it; filed and discarded mail stays as it is
--   * both run as the caller, so the documents, comments and inbound mail policies decide; the guard checks that the
--     document and record belong to the inbox's project and stamps the filer and discarder
--   * audit: every change of an inbox address, and every filing or discard of inbound mail (updates only, so mail
--     bodies never enter the ledger)

-- Addresses -----------------------------------------------------------------------------------------------------------

create unique index inbound_addresses_live_project_key on app.inbound_addresses (project_id)
  where disabled_at is null and deleted_at is null;

revoke update on app.inbound_addresses from authenticated;
grant update (disabled_at) on app.inbound_addresses to authenticated;

create or replace function private.guard_inbound_address()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.local_part is distinct from old.local_part or new.project_id is distinct from old.project_id then
    perform private.refuse('project_inbox_immutable', 'An inbox address never changes. Replace the address instead.');
  end if;
  if old.disabled_at is not null and new.disabled_at is distinct from old.disabled_at then
    perform private.refuse('project_inbox_disabled', 'A disabled inbox address stays disabled. Create a new address instead.');
  end if;
  if old.disabled_at is null and new.disabled_at is not null then
    new.disabled_at := now();
  end if;
  return new;
end;
$$;

comment on function private.guard_inbound_address() is 'Before update on project inbox addresses: the address and project never change, and disabling stamps disabled_at with the database time once; it is never cleared.';
revoke all on function private.guard_inbound_address() from public, anon, authenticated;

create trigger t40_guard_inbound_address before update on app.inbound_addresses
  for each row execute function private.guard_inbound_address();

call private.install_audit_trail('app.inbound_addresses');

create or replace function app.create_project_inbox(p_project_id uuid)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_key text := (select lower(p.project_key) from app.projects p where p.id = p_project_id and p.deleted_at is null);
  v_local text;
begin
  if v_key is null or not private.can_on_project(p_project_id, 'projects.settings.write') then
    raise exception using errcode = '42501', message = 'project not found';
  end if;
  select a.local_part into v_local from app.inbound_addresses a
  where a.project_id = p_project_id and a.disabled_at is null and a.deleted_at is null;
  if v_local is not null then
    return v_local;
  end if;
  v_local := v_key || '-' || encode(extensions.gen_random_bytes(5), 'hex');
  insert into app.inbound_addresses (project_id, local_part) values (p_project_id, v_local);
  return v_local;
end;
$$;

comment on function app.create_project_inbox(uuid) is 'Returns the project''s live inbox address (local part), creating it (project key plus a random suffix) when there is none. Needs projects.settings.write on the project.';

create or replace function app.replace_project_inbox(p_project_id uuid)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if not private.can_on_project(p_project_id, 'projects.settings.write') then
    raise exception using errcode = '42501', message = 'project not found';
  end if;
  update app.inbound_addresses set disabled_at = now()
  where project_id = p_project_id and disabled_at is null and deleted_at is null;
  return app.create_project_inbox(p_project_id);
end;
$$;

comment on function app.replace_project_inbox(uuid) is 'Disables the project''s live inbox address and returns a new one. Mail to the old address is no longer accepted. Needs projects.settings.write on the project.';

create or replace function app.disable_project_inbox(p_project_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if not private.can_on_project(p_project_id, 'projects.settings.write') then
    raise exception using errcode = '42501', message = 'project not found';
  end if;
  update app.inbound_addresses set disabled_at = now()
  where project_id = p_project_id and disabled_at is null and deleted_at is null;
end;
$$;

comment on function app.disable_project_inbox(uuid) is 'Stops the project''s inbox: its live address no longer accepts mail. Mail already received stays. Needs projects.settings.write on the project.';

-- Filing and discarding -------------------------------------------------------------------------------------------------

alter table app.inbound_messages
  add column filed_record_id uuid references app.records (id),
  add column filed_by uuid references app.people (id),
  add column filed_at timestamptz,
  add column discarded_at timestamptz,
  add column discarded_by uuid references app.people (id),
  add column discard_reason text,
  add constraint inbound_messages_discard_reason_length check (discard_reason is null or char_length(discard_reason) between 1 and 500),
  add constraint inbound_messages_filed_or_discarded check (filed_document_id is null or discarded_at is null),
  add constraint inbound_messages_filed_stamped check ((filed_document_id is null) = (filed_at is null)),
  add constraint inbound_messages_discarded_stamped check (discarded_at is not null or (discarded_by is null and discard_reason is null));

create index inbound_messages_filed_record_idx on app.inbound_messages (filed_record_id);
create index inbound_messages_filed_by_idx on app.inbound_messages (filed_by);
create index inbound_messages_discarded_by_idx on app.inbound_messages (discarded_by);

comment on column app.inbound_messages.filed_record_id is 'Record of the inbox''s project the mail was filed to, if any; the mail is posted there as a comment.';
comment on column app.inbound_messages.filed_by is 'Person who filed the mail. Set by the database.';
comment on column app.inbound_messages.filed_at is 'When the mail was filed. Set by the database.';
comment on column app.inbound_messages.discarded_at is 'When a coordinator discarded the mail. Set by the database; discarded mail is kept and never filed.';
comment on column app.inbound_messages.discarded_by is 'Person who discarded the mail. Set by the database.';
comment on column app.inbound_messages.discard_reason is 'Why the mail was discarded, if the coordinator said.';

create or replace function private.guard_inbound_message()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.current_person_id();
  v_triage text[] := array['filed_document_id', 'inbound_status', 'filed_record_id', 'filed_by', 'filed_at', 'discarded_at',
    'discarded_by', 'discard_reason', 'updated_at', 'updated_by'];
  v_project uuid;
  v_filing boolean;
  v_discarding boolean;
begin
  if tg_op <> 'UPDATE' or v_person is null then
    return new;
  end if;
  if (to_jsonb(new) - v_triage) <> (to_jsonb(old) - v_triage) then
    perform private.refuse('inbound_message_immutable', 'A coordinator only files or discards inbound mail.');
  end if;
  v_filing := new.filed_document_id is distinct from old.filed_document_id;
  v_discarding := new.discarded_at is distinct from old.discarded_at;
  if not v_filing and not v_discarding then
    if (to_jsonb(new) - array['updated_at', 'updated_by']) <> (to_jsonb(old) - array['updated_at', 'updated_by']) then
      perform private.refuse('inbound_message_filing', 'Filing sets the document and the Filed status together.');
    end if;
    return new;
  end if;
  if old.purpose <> 'Project Inbox' then
    perform private.refuse('inbound_message_immutable', 'Only project inbox mail is filed or discarded.');
  end if;
  if old.filed_document_id is not null or old.discarded_at is not null or (v_filing and v_discarding) then
    perform private.refuse('inbound_message_triaged', 'This mail was already filed or discarded.');
  end if;
  v_project := (select a.project_id from app.inbound_addresses a where a.id = old.inbound_address_id);
  if v_filing then
    if old.inbound_status <> 'Verified' then
      perform private.refuse('inbound_message_unverified', 'Mail whose sender did not verify cannot be filed. Discard it instead.');
    end if;
    if new.inbound_status <> 'Filed' or new.filed_document_id is null then
      perform private.refuse('inbound_message_filing', 'Filing sets the document and the Filed status together.');
    end if;
    if not exists (select 1 from app.documents d where d.id = new.filed_document_id and d.project_id = v_project and d.deleted_at is null) then
      perform private.refuse('inbound_message_document', 'File the mail as a document of the inbox''s project.');
    end if;
    if new.filed_record_id is not null and not exists (
      select 1 from app.records r
      where r.id = new.filed_record_id and r.project_id = v_project and r.deleted_at is null
        and (r.project_id in (select private.project_ids_with('work.record.read'))
             or r.id in (select private.my_record_ids('work.record.read')))) then
      perform private.refuse('inbound_message_record', 'File the mail to a record of the inbox''s project that you can open.');
    end if;
    new.filed_by := v_person;
    new.filed_at := now();
    new.discarded_by := null;
    new.discard_reason := null;
  else
    if new.discarded_at is null or new.inbound_status is distinct from old.inbound_status or new.filed_record_id is not null then
      perform private.refuse('inbound_message_triaged', 'This mail was already filed or discarded.');
    end if;
    new.discarded_at := now();
    new.discarded_by := v_person;
    new.discard_reason := nullif(btrim(new.discard_reason), '');
    new.filed_by := null;
    new.filed_at := null;
  end if;
  return new;
end;
$$;

comment on function private.guard_inbound_message() is 'Inbound messages: a person only files or discards project inbox mail, once. Filing needs verified mail, sets the document (of the inbox''s project) and the Filed status together and may name a record of the project the person can open; discarding keeps the mail. The database stamps who filed or discarded and when.';

create trigger t85_audit_trail after update on app.inbound_messages
  for each row execute function private.audit_row_change();

create or replace function app.file_inbound_message(p_inbound_message_id uuid, p_title text default null, p_record_id uuid default null)
returns uuid
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_message app.inbound_messages;
  v_project uuid;
  v_title text;
  v_body text;
  v_document uuid;
begin
  select * into v_message from app.inbound_messages m
  where m.id = p_inbound_message_id and m.purpose = 'Project Inbox' and m.deleted_at is null
  for update;
  if v_message.id is null then
    raise exception using errcode = '42501', message = 'inbound message not found';
  end if;
  if v_message.filed_document_id is not null or v_message.discarded_at is not null then
    raise exception using errcode = 'XR001', message = 'inbound_message_triaged: This mail was already filed or discarded.',
      hint = 'inbound_message_triaged';
  end if;
  if v_message.inbound_status <> 'Verified' then
    raise exception using errcode = 'XR001',
      message = 'inbound_message_unverified: Mail whose sender did not verify cannot be filed. Discard it instead.',
      hint = 'inbound_message_unverified';
  end if;
  select a.project_id into v_project from app.inbound_addresses a where a.id = v_message.inbound_address_id;
  v_title := left(btrim(coalesce(nullif(btrim(p_title), ''), nullif(btrim(v_message.subject_line), ''), v_message.from_address)), 200);
  insert into app.documents (org_id, project_id, title) values (v_message.org_id, v_project, v_title) returning id into v_document;
  update app.inbound_messages set filed_document_id = v_document, inbound_status = 'Filed', filed_record_id = p_record_id
  where id = v_message.id;
  v_body := left(v_title || E'\n' || v_message.from_address
    || coalesce(E'\n\n' || nullif(btrim(v_message.body_text), ''), ''), 20000);
  perform app.post_comment('app.documents', v_document, v_body);
  if p_record_id is not null then
    perform app.post_comment('app.records', p_record_id, v_body);
  end if;
  return v_document;
end;
$$;

comment on function app.file_inbound_message(uuid, text, uuid) is 'Files verified project inbox mail as a Document record of the project (Section 4.6.5), titled as given or by the subject, optionally to a record of the project the caller can open; the subject, sender and text are posted as a comment on the document and on that record. Runs as the caller, so the documents, comments and inbound mail policies decide. Returns the document id.';

create or replace function app.discard_inbound_message(p_inbound_message_id uuid, p_reason text default null)
returns void
language plpgsql
volatile
security invoker
set search_path = ''
as $$
begin
  update app.inbound_messages set discarded_at = now(), discard_reason = left(nullif(btrim(coalesce(p_reason, '')), ''), 500)
  where id = p_inbound_message_id and purpose = 'Project Inbox' and deleted_at is null;
  if not found then
    raise exception using errcode = '42501', message = 'inbound message not found';
  end if;
end;
$$;

comment on function app.discard_inbound_message(uuid, text) is 'Discards project inbox mail with an optional reason: the mail is kept, never filed, and the audit ledger records who discarded it and when. Runs as the caller, so only people who file documents on the project can.';

-- Privileges -------------------------------------------------------------------------------------------------------------

revoke all on function app.create_project_inbox(uuid) from public, anon;
grant execute on function app.create_project_inbox(uuid) to authenticated, service_role;
revoke all on function app.replace_project_inbox(uuid) from public, anon;
grant execute on function app.replace_project_inbox(uuid) to authenticated, service_role;
revoke all on function app.disable_project_inbox(uuid) from public, anon;
grant execute on function app.disable_project_inbox(uuid) to authenticated, service_role;
revoke all on function app.file_inbound_message(uuid, text, uuid) from public, anon;
grant execute on function app.file_inbound_message(uuid, text, uuid) to authenticated, service_role;
revoke all on function app.discard_inbound_message(uuid, text) from public, anon;
grant execute on function app.discard_inbound_message(uuid, text) to authenticated, service_role;

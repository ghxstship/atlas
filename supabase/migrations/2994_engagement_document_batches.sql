-- 2994_engagement_document_batches.sql
-- B10 Crew onboarding, recruitment and account-free field access (RRR-234, gap G-130, Section 4.4.4, Section 7.4,
-- ADR 0149 decision 4). One template (2993) becomes one engagement document per person, sent as a batch, read and
-- signed in Gateway, countersigned in Atlas, and, for an Automatic Electronic Signature requirement, verified.
--   * app.engagement_document_batches: a record of one send: the project, the template and an optional live
--     Electronic Signature requirement the documents satisfy (document_batch_requirement). Excluded from Trash.
--   * app.engagement_document_texts: the merged text of a generated document, with 0361's signed-text rules
--     (app.agreements): body, signed_name, signed_body_sha256 and signed_at, all set together, a lowercase hex digest
--     and a name of 1 to 200 characters. No hash is stored before signing: the signing RPC computes it with
--     extensions.digest, and api_external.engagement_document_texts computes it as an expression for the party to
--     sign. ADR 0149 decision 4 says why the text lives with the engagement document and not in app.agreements: the
--     document is what onboarding items, the Gateway Documents tab and the engagement lifecycle already read, and an
--     agreement carries no engagement. The body is frozen from the document's first send (Sent can go back to
--     Proposed, so "not Proposed" is not enough) and after signature (document_text_signed). The onboarding item is
--     never stored: it is the engagement's item for the batch's requirement (unique onboarding_items_key).
--   * The body may hold a Restricted value: a body merged from engagement.rate holds the rate, and a SHA-256 of a text
--     that differs from known wording only by a number can be guessed offline. So body and signed_body_sha256 are
--     Restricted (data.restricted.read.payroll), which also keeps them out of the audit diff, and neither is selectable.
--     Org readers read texts through app.engagement_document_text_list, a definer view with its own row filter that masks
--     the body and both hashes unless the template uses no rate field or the caller holds the capability in the org (the
--     capability is org-wide, as app.engagement_resolved reads it). The engaged person, and a representative with
--     Settlement scope, read the text through api_external.engagement_document_texts while the documents area is open.
--     A Documents-only representative gets NULLs with body_masked true, and cannot sign or decline
--     (document_text_masked); the money area is not the test, since Onboarding and Blocked do not open it and that is
--     when people sign.
--   * One guard for every signing path: t42_guard_engagement_document_text_signature on app.engagement_documents
--     refuses document_text_sign_with_hash on a move from Sent to Signed while the document's text is unsigned. That
--     covers app.sign_engagement_document (0710), Gateway bulk signing (2160) and api_public.token_sign_document (0769,
--     1295), so none of them is recreated; Atlas offers no signing link for a text document, and a signing token for one
--     is refused when it is issued (t41_refuse_engagement_document_text_token).
--   * app.create_engagement_document_batch (each entry in its own subtransaction), app.send_engagement_document_batch,
--     app.countersign_engagement_document_batch, app.sign_engagement_document_text and app.decline_engagement_document
--     (the party's Sent to Canceled; no new enum value, so the frozen API enum is unchanged).
--   * Executed verifies: t86_verify_engagement_document_executed opens the trusted operation
--     engagement_document_executed (ADR 0008 item 4) and writes a Passed verification of the engagement's item for an
--     Automatic requirement. private.guard_onboarding_verification is recreated from 1306 so that under that operation
--     verified_by stays NULL and an Automatic requirement is allowed; expires_on still comes from the guard
--     (org_today + valid_for_days), and sod_onboarding_self_verify still holds for people: the engaged person cannot
--     countersign their own Automatic item. Superseded or Expired after Executed writes nothing. A Reviewer requirement
--     is verified by a reviewer as today.

-- Batches ------------------------------------------------------------------------------------------------------------

create table app.engagement_document_batches (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  project_id uuid not null references app.projects (id),
  engagement_document_template_id uuid not null references app.engagement_document_templates (id),
  onboarding_requirement_id uuid references app.onboarding_requirements (id),
  sent_at timestamptz,
  deleted_at timestamptz
);

create index engagement_document_batches_project_idx on app.engagement_document_batches (project_id);
create index engagement_document_batches_template_idx on app.engagement_document_batches (engagement_document_template_id);
create index engagement_document_batches_requirement_idx on app.engagement_document_batches (onboarding_requirement_id);

call private.install_domain_table('app.engagement_document_batches', 'app.projects', 'project_id',
  array['app.engagement_document_templates', 'engagement_document_template_id', 'app.onboarding_requirements', 'onboarding_requirement_id']);
call private.describe('app.engagement_document_batches', 'One send of generated engagement documents (B10, ADR 0149 decision 4): the project, the template merged and the Electronic Signature requirement the documents satisfy, if any. Written only by the batch RPCs.', array[
  'org_id', 'Owning org, derived from the project.',
  'project_id', 'Project whose engagements the documents go to.',
  'engagement_document_template_id', 'Template the documents were merged from.',
  'onboarding_requirement_id', 'Electronic Signature onboarding requirement the documents satisfy; NULL when none.',
  'sent_at', 'When the batch was sent; NULL while its documents are Proposed.'
]);

call private.install_policies('app.engagement_document_batches',
  $$project_id in (select private.project_ids_with('opportunities.engagement.read'))$$);
revoke insert, update on app.engagement_document_batches from authenticated;
call private.install_default_retention('app.engagement_document_batches');
call private.install_audit_trail('app.engagement_document_batches');

-- Texts ---------------------------------------------------------------------------------------------------------------

create table app.engagement_document_texts (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  engagement_document_id uuid not null references app.engagement_documents (id),
  engagement_document_batch_id uuid not null references app.engagement_document_batches (id),
  body text not null,
  signed_name text,
  signed_body_sha256 text,
  signed_at timestamptz,
  deleted_at timestamptz,
  constraint engagement_document_texts_document_key unique (engagement_document_id),
  constraint engagement_document_texts_body check (char_length(btrim(body)) between 1 and 200000),
  constraint engagement_document_texts_signature_set check ((signed_at is null) = (signed_name is null) and (signed_at is null) = (signed_body_sha256 is null)),
  constraint engagement_document_texts_signed_name_length check (signed_name is null or char_length(btrim(signed_name)) between 1 and 200),
  constraint engagement_document_texts_signed_body_format check (signed_body_sha256 is null or signed_body_sha256 ~ '^[0-9a-f]{64}$')
);

create index engagement_document_texts_batch_idx on app.engagement_document_texts (engagement_document_batch_id);

call private.install_domain_table('app.engagement_document_texts', 'app.engagement_documents', 'engagement_document_id',
  array['app.engagement_document_batches', 'engagement_document_batch_id']);
call private.describe('app.engagement_document_texts', 'The merged text of a generated engagement document (B10), frozen from its first send and after signature. The party signs the SHA-256 of exactly this text. Body readable only through app.engagement_document_text_list (masked when it may hold a rate) and, for the party, api_external.engagement_document_texts.', array[
  'org_id', 'Owning org, derived from the document.',
  'engagement_document_id', 'Engagement document the text belongs to.',
  'engagement_document_batch_id', 'Batch it was generated in.',
  'body', 'Merged text, 1 to 200000 characters. Restricted: it holds the rate when the template uses engagement.rate, so it is not directly selectable.',
  'signed_name', 'Name the party typed as their signature.',
  'signed_body_sha256', 'SHA-256 of the exact text signed, lowercase hex. Restricted with the body: a hash of a text that differs by a number can be guessed offline.',
  'signed_at', 'When the party signed.'
]);

insert into private.column_classifications (table_name, column_name, classification, read_capability) values
  ('app.engagement_document_texts', 'body', 'Restricted', 'data.restricted.read.payroll'),
  ('app.engagement_document_texts', 'signed_body_sha256', 'Restricted', 'data.restricted.read.payroll');

call private.install_policies('app.engagement_document_texts',
  $$engagement_document_id in (select d.id from app.engagement_documents d join app.engagements e on e.id = d.engagement_id
      where e.project_id in (select private.project_ids_with('opportunities.engagement.read')))$$);
revoke select, insert, update on app.engagement_document_texts from authenticated;
grant select (id, org_id, engagement_document_id, engagement_document_batch_id, signed_name, signed_at,
  deleted_at, created_at, created_by, updated_at, updated_by) on app.engagement_document_texts to authenticated;
call private.install_default_retention('app.engagement_document_texts');
call private.install_audit_trail('app.engagement_document_texts');

insert into private.trash_excluded_tables (table_name, rationale) values
  ('engagement_document_batches', 'A batch is a record of a send (B10); its documents are canceled or superseded, never the record.'),
  ('engagement_document_texts', 'The text is part of its engagement document (B10) and is never restored apart from it.')
on conflict (table_name) do nothing;

create or replace function private.guard_engagement_document_text()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.signed_at is not null or new.signed_name is not null or new.signed_body_sha256 is not null then
      perform private.refuse('document_text_signed', 'A text is signed by the party, never on creation.');
    end if;
    return new;
  end if;
  if new.engagement_document_id is distinct from old.engagement_document_id
     or new.engagement_document_batch_id is distinct from old.engagement_document_batch_id then
    perform private.refuse('document_text_fixed', 'A text stays with its document and batch.');
  end if;
  if old.signed_at is not null and (new.signed_at is distinct from old.signed_at or new.signed_name is distinct from old.signed_name
     or new.signed_body_sha256 is distinct from old.signed_body_sha256 or new.body is distinct from old.body) then
    perform private.refuse('document_text_signed', 'A signed text never changes (Section 7.4).');
  end if;
  if new.body is distinct from old.body and exists (
      select 1 from app.engagement_document_state_transitions t
      where t.engagement_document_id = old.engagement_document_id and t.to_state = 'Sent') then
    perform private.refuse('document_text_signed', 'The text is frozen once the document has been sent. Cancel it and generate a new one.');
  end if;
  if (new.signed_at is distinct from old.signed_at or new.signed_name is distinct from old.signed_name
      or new.signed_body_sha256 is distinct from old.signed_body_sha256)
     and not private.in_trusted_operation('engagement_document_text_sign') then
    perform private.refuse('document_text_signed', 'A text is signed only through app.sign_engagement_document_text.');
  end if;
  return new;
end;
$$;

comment on function private.guard_engagement_document_text() is 'Engagement document texts: created unsigned, kept on their document and batch, frozen from the document''s first send and after signature (document_text_signed), and signed only through app.sign_engagement_document_text.';
revoke all on function private.guard_engagement_document_text() from public, anon, authenticated;

create trigger t40_guard_engagement_document_text before insert or update on app.engagement_document_texts
  for each row execute function private.guard_engagement_document_text();

-- Every signing path: a text document is signed with the hash of what the party read.
create or replace function private.guard_engagement_document_text_signature()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.engagement_document_state = 'Sent' and new.engagement_document_state = 'Signed' and exists (
      select 1 from app.engagement_document_texts x
      where x.engagement_document_id = new.id and x.deleted_at is null and x.signed_at is null) then
    perform private.refuse('document_text_sign_with_hash', 'Read this document in Gateway and sign it there with your typed name.');
  end if;
  return new;
end;
$$;

comment on function private.guard_engagement_document_text_signature() is 'Refuses (document_text_sign_with_hash) moving a generated document from Sent to Signed while its text is unsigned, on every path: app.sign_engagement_document, Gateway bulk signing and the signing link. app.sign_engagement_document_text records the signature first.';
revoke all on function private.guard_engagement_document_text_signature() from public, anon, authenticated;

create trigger t42_guard_engagement_document_text_signature before update of engagement_document_state on app.engagement_documents
  for each row execute function private.guard_engagement_document_text_signature();

-- A signing link cannot sign a text document, so it is refused when it is issued, not when it is opened.
create or replace function private.refuse_engagement_document_text_token()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (select 1 from app.engagement_document_texts x
             where x.engagement_document_id = new.engagement_document_id and x.deleted_at is null) then
    perform private.refuse('document_text_sign_with_hash', 'This document is read and signed in Gateway, so it has no signing link.');
  end if;
  return new;
end;
$$;

comment on function private.refuse_engagement_document_text_token() is 'Refuses (document_text_sign_with_hash) a signing token for a generated document: a link cannot sign the hash of what its reader read.';
revoke all on function private.refuse_engagement_document_text_token() from public, anon, authenticated;

create trigger t41_refuse_engagement_document_text_token before insert on app.engagement_document_tokens
  for each row execute function private.refuse_engagement_document_text_token();

-- Reads ------------------------------------------------------------------------------------------------------------

-- Who may not read a body that holds a rate, for the party-side reads. The engaged person always may, whichever areas
-- are open, because they sign during Onboarding and Blocked; a representative needs Settlement scope.
create or replace function private.engagement_document_masked_for_party(p_body_template text, p_person_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.engagement_document_uses_rate(p_body_template)
    and p_person_id is distinct from private.current_person_id()
    and not private.represents(p_person_id, 'Settlement');
$$;

comment on function private.engagement_document_masked_for_party(text, uuid) is 'True when a body uses engagement.rate and the caller is neither the engaged person nor their representative with Settlement scope.';
revoke all on function private.engagement_document_masked_for_party(text, uuid) from public, anon;
grant execute on function private.engagement_document_masked_for_party(text, uuid) to authenticated, service_role;

create view app.engagement_document_text_list as
select x.engagement_document_id, x.org_id, d.engagement_id, e.project_id, x.engagement_document_batch_id, d.title,
  d.document_kind, d.engagement_document_state,
  case when not m.masked then x.body end as body,
  m.masked as body_masked,
  case when not m.masked then encode(extensions.digest(x.body, 'sha256'), 'hex') end as body_sha256,
  x.signed_name,
  case when not m.masked then x.signed_body_sha256 end as signed_body_sha256,
  x.signed_at
from app.engagement_document_texts x
join app.engagement_documents d on d.id = x.engagement_document_id and d.deleted_at is null
join app.engagements e on e.id = d.engagement_id
join app.engagement_document_batches b on b.id = x.engagement_document_batch_id
join app.engagement_document_templates t on t.id = b.engagement_document_template_id
cross join lateral (select private.engagement_document_uses_rate(t.body_template)
    and not private.has_capability(x.org_id, 'data.restricted.read.payroll') as masked) m
where x.deleted_at is null
  and e.project_id in (select private.project_ids_with('opportunities.engagement.read'));

call private.describe('app.engagement_document_text_list', 'Generated engagement documents'' texts as Atlas reads them (B10): the body and both hashes are masked (NULL, body_masked true) when the template uses engagement.rate and the caller lacks data.restricted.read.payroll in the org. Rows follow the engagement document read rule: opportunities.engagement.read on the project.', array[
  'engagement_document_id', 'Engagement document.',
  'org_id', 'Org.',
  'engagement_id', 'Engagement.',
  'project_id', 'Project.',
  'engagement_document_batch_id', 'Batch.',
  'title', 'Document title.',
  'document_kind', 'Kind.',
  'engagement_document_state', 'Document state.',
  'body', 'Merged text; NULL when masked.',
  'body_masked', 'True when the body may hold the Restricted rate and the caller may not read it.',
  'body_sha256', 'SHA-256 of the text, lowercase hex; NULL when masked.',
  'signed_name', 'Name the party signed with.',
  'signed_body_sha256', 'SHA-256 the party signed; NULL when masked.',
  'signed_at', 'When the party signed.'
]);

revoke all on app.engagement_document_text_list from public, anon;
revoke select on app.engagement_document_text_list from xos_backup;
grant select on app.engagement_document_text_list to authenticated, service_role;

create view api_external.engagement_document_texts as
select d.id, d.engagement_id, d.title,
  case when not m.masked then x.body end as body,
  case when not m.masked then encode(extensions.digest(x.body, 'sha256'), 'hex') end as body_sha256,
  m.masked as body_masked,
  x.signed_name, x.signed_at
from app.engagement_document_texts x
join app.engagement_documents d on d.id = x.engagement_document_id and d.deleted_at is null
join app.engagements e on e.id = d.engagement_id
join app.engagement_document_batches b on b.id = x.engagement_document_batch_id
join app.engagement_document_templates t on t.id = b.engagement_document_template_id
cross join lateral (select private.engagement_document_masked_for_party(t.body_template, e.person_id) as masked) m
where x.deleted_at is null and d.engagement_document_state <> 'Proposed'
  and d.engagement_id in (select private.my_engagement_ids('documents'));

call private.describe('api_external.engagement_document_texts', 'The texts of the caller''s generated engagement documents once sent, while the documents area is open (B10): the party reads the full text and signs its SHA-256. A representative without Settlement scope gets NULLs when the text uses the rate.', array[
  'id', 'Engagement document.',
  'engagement_id', 'Engagement.',
  'title', 'Title.',
  'body', 'Full text; NULL when masked.',
  'body_sha256', 'SHA-256 of the text, lowercase hex: what a signature names. NULL when masked.',
  'body_masked', 'True when the text uses the rate and the caller is neither the engaged person nor a representative with Settlement scope.',
  'signed_name', 'Name the party signed with.',
  'signed_at', 'When the party signed.'
]);

revoke all on api_external.engagement_document_texts from public, anon;
revoke select on api_external.engagement_document_texts from xos_backup;
grant select on api_external.engagement_document_texts to authenticated, service_role;

insert into private.domain_event_types (code, subject, description) values
  ('engagement_document_batch.created', 'engagement_document_batches', 'Engagement documents were generated from a template as a batch.'),
  ('engagement_document_batch.sent', 'engagement_document_batches', 'A batch of generated engagement documents was sent to the engaged people.'),
  ('engagement_document.declined', 'engagement_documents', 'The engaged party declined a sent engagement document.')
on conflict (code) do nothing;

-- Creating a batch -----------------------------------------------------------------------------------------------------

create or replace function private.create_engagement_document_entry(
  p_batch app.engagement_document_batches,
  p_template app.engagement_document_templates,
  p_entry jsonb
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_engagement app.engagements;
  v_title text := btrim(coalesce(p_entry ->> 'title', ''));
  v_body text := coalesce(p_entry ->> 'body', '');
  v_document uuid;
begin
  if (p_entry ->> 'engagement_id') is null
     or (p_entry ->> 'engagement_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    perform private.refuse('document_batch_person', 'Each document names a person''s engagement on the project.');
  end if;
  select * into v_engagement from app.engagements e where e.id = (p_entry ->> 'engagement_id')::uuid and e.deleted_at is null;
  -- A person supplied by a vendor signs through the vendor, so a company engagement is refused.
  -- A finished engagement takes no new documents, though its documents area stays open for 18 months.
  if v_engagement.id is null or v_engagement.project_id <> p_batch.project_id or v_engagement.person_id is null
     or v_engagement.counterparty_id is not null
     or v_engagement.engagement_state not in ('Onboarding', 'Blocked', 'Active', 'Closing') then
    perform private.refuse('document_batch_person', 'Each document names a person''s own engagement on the project, while it is Onboarding, Blocked, Active or Closing.');
  end if;
  if position('{{' in v_title) > 0 or position('{{' in v_body) > 0 then
    perform private.refuse('document_merge_unresolved', 'Some merge fields were not filled. Fill them in the engagement, then generate again.');
  end if;
  if private.engagement_document_uses_rate(p_template.body_template)
     and not private.has_capability(p_batch.org_id, 'data.restricted.read.payroll') then
    perform private.refuse('document_merge_rate_restricted', 'This template uses the rate, which needs data.restricted.read.payroll in the organization.');
  end if;
  if char_length(v_title) not between 1 and 200 then
    perform private.refuse('document_batch_title', 'A merged title has 1 to 200 characters.');
  end if;
  if char_length(btrim(v_body)) not between 1 and 200000 then
    perform private.refuse('document_batch_body', 'A merged text has 1 to 200000 characters.');
  end if;
  if exists (
    select 1 from app.engagement_documents d
    join app.engagement_document_texts x on x.engagement_document_id = d.id and x.deleted_at is null
    join app.engagement_document_batches b on b.id = x.engagement_document_batch_id
    where d.engagement_id = v_engagement.id and d.deleted_at is null
      and d.engagement_document_state not in ('Canceled', 'Superseded', 'Expired')
      and b.engagement_document_template_id = p_template.id) then
    perform private.refuse('document_batch_duplicate', 'This person already has a live document from this template.');
  end if;
  if p_batch.onboarding_requirement_id is not null and not exists (
    select 1 from app.onboarding_items i
    where i.engagement_id = v_engagement.id and i.onboarding_requirement_id = p_batch.onboarding_requirement_id and i.deleted_at is null) then
    perform private.refuse('document_batch_no_item', 'This engagement has no onboarding item for the requirement.');
  end if;
  insert into app.engagement_documents (engagement_id, document_kind, title)
  values (v_engagement.id, p_template.document_kind, v_title)
  returning id into v_document;
  insert into app.engagement_document_texts (engagement_document_id, engagement_document_batch_id, body)
  values (v_document, p_batch.id, v_body);
  return v_document;
end;
$$;

comment on function private.create_engagement_document_entry(app.engagement_document_batches, app.engagement_document_templates, jsonb) is 'One entry of app.create_engagement_document_batch: a Proposed engagement document with its merged text for a person''s own engagement on the batch''s project, while it is Onboarding, Blocked, Active or Closing. Refusals: document_batch_person, document_merge_unresolved, document_merge_rate_restricted, document_batch_title, document_batch_body, document_batch_duplicate, document_batch_no_item.';
revoke all on function private.create_engagement_document_entry(app.engagement_document_batches, app.engagement_document_templates, jsonb) from public, anon, authenticated;

create or replace function app.create_engagement_document_batch(
  p_project_id uuid,
  p_template_id uuid,
  p_documents jsonb,
  p_onboarding_requirement_id uuid default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_project app.projects;
  v_template app.engagement_document_templates;
  v_batch app.engagement_document_batches;
  v_entry jsonb;
  v_document uuid;
  v_hint text;
  v_results jsonb := '[]'::jsonb;
  v_created integer := 0;
begin
  perform private.require_person();
  select * into v_project from app.projects p where p.id = p_project_id and p.deleted_at is null;
  if v_project.id is null or not private.can_on_project(v_project.id, 'opportunities.engagement.write') then
    raise exception using errcode = '42501', message = 'opportunities.engagement.write is required on the project';
  end if;
  select * into v_template from app.engagement_document_templates t where t.id = p_template_id and t.deleted_at is null;
  if v_template.id is null or v_template.org_id <> v_project.org_id
     or v_template.org_id not in (select private.engagement_document_template_reader_org_ids()) then
    perform private.refuse('document_template_not_found', 'This template no longer exists or is not available to you.');
  end if;
  if p_documents is null or jsonb_typeof(p_documents) <> 'array' or jsonb_array_length(p_documents) not between 1 and 500 then
    perform private.refuse('document_batch_size', 'Generate 1 to 500 documents at a time.');
  end if;
  if p_onboarding_requirement_id is not null and not exists (
    select 1 from app.onboarding_requirements r
    where r.id = p_onboarding_requirement_id and r.org_id = v_project.org_id and r.deleted_at is null
      and r.item_kind = 'Electronic Signature') then
    perform private.refuse('document_batch_requirement', 'Choose a live Electronic Signature requirement of the organization.');
  end if;
  -- A batch that creates nothing leaves no row: a batch fixes its template's wording (2993), so a call whose every entry is
  -- refused must not fix it. The raise below undoes the batch and leaves the per-row results.
  begin
    insert into app.engagement_document_batches (project_id, engagement_document_template_id, onboarding_requirement_id)
    values (v_project.id, v_template.id, p_onboarding_requirement_id)
    returning * into v_batch;
    for v_entry in select e from jsonb_array_elements(p_documents) e loop
      begin
        v_document := private.create_engagement_document_entry(v_batch, v_template, v_entry);
        v_created := v_created + 1;
        v_results := v_results || jsonb_build_array(jsonb_build_object('engagement_id', v_entry ->> 'engagement_id',
          'engagement_document_id', v_document, 'outcome', 'created', 'code', null));
      exception when sqlstate 'XR001' then
        get stacked diagnostics v_hint = pg_exception_hint;
        v_results := v_results || jsonb_build_array(jsonb_build_object('engagement_id', v_entry ->> 'engagement_id',
          'engagement_document_id', null, 'outcome', 'refused', 'code', coalesce(nullif(v_hint, ''), 'refused')));
      end;
    end loop;
    if v_created = 0 then
      raise exception using errcode = 'XRB10', message = 'no document was created';
    end if;
  exception when sqlstate 'XRB10' then
    return jsonb_build_object('batch_id', null, 'results', v_results);
  end;
  perform private.emit_event(v_batch.org_id, 'engagement_document_batch.created', 'engagement_document_batches', v_batch.id,
    v_batch.project_id, jsonb_build_object('template_id', v_template.id, 'created', v_created));
  return jsonb_build_object('batch_id', v_batch.id, 'results', v_results);
end;
$$;

comment on function app.create_engagement_document_batch(uuid, uuid, jsonb, uuid) is 'Generates engagement documents from a template on a project (B10): p_documents is [{engagement_id, title, body}], 1 to 500 entries (document_batch_size), merged by the data layer as the caller. Needs opportunities.engagement.write on the project (42501), a template the caller reads (document_template_not_found) and, when named, a live Electronic Signature requirement of the org (document_batch_requirement). Each entry runs in its own subtransaction and creates a Proposed document with its text, or is refused with its code. A call that creates nothing leaves no batch, so batch_id is NULL and the template stays editable. Returns {batch_id, results: [{engagement_id, engagement_document_id, outcome created or refused, code}]}.';

-- The merge reads the project's shifts as the caller, so it asks first whether the caller may: a caller who cannot would read
-- zero shifts, and a legal text would say so. Recreated from 0470 with that one capability added.
create or replace function app.my_capabilities_on_project(p_project_id uuid, p_capabilities text[])
returns text[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(array_agg(c order by c), '{}')
  from unnest(p_capabilities) c
  where (c like 'credentials.%' or c like 'safety.%' or c like 'data.restricted.%' or c = 'crew.shift.read')
    and private.can_on_project(p_project_id, c);
$$;
comment on function app.my_capabilities_on_project(uuid, text[]) is 'Which of the named credentials, safety and restricted-data capabilities, and crew.shift.read, the signed-in person may use on a project. Only shapes which controls the apps show and which merge fields a generated document can fill; row level security and the RPCs still decide every write.';
revoke all on function app.my_capabilities_on_project(uuid, text[]) from public, anon;
grant execute on function app.my_capabilities_on_project(uuid, text[]) to authenticated, service_role;

-- Sending and countersigning -----------------------------------------------------------------------------------------

create or replace function private.authorized_document_batch(p_batch_id uuid)
returns app.engagement_document_batches
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_batch app.engagement_document_batches;
begin
  perform private.require_person();
  select * into v_batch from app.engagement_document_batches b where b.id = p_batch_id and b.deleted_at is null for update;
  if v_batch.id is null or not private.can_on_project(v_batch.project_id, 'opportunities.engagement.write') then
    raise exception using errcode = '42501', message = 'opportunities.engagement.write is required on the project';
  end if;
  return v_batch;
end;
$$;

comment on function private.authorized_document_batch(uuid) is 'Locks a live document batch for a caller who holds opportunities.engagement.write on its project; 42501 otherwise.';
revoke all on function private.authorized_document_batch(uuid) from public, anon, authenticated;

create or replace function app.send_engagement_document_batch(p_batch_id uuid)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_batch app.engagement_document_batches := private.authorized_document_batch(p_batch_id);
  v_document record;
  v_count integer := 0;
begin
  for v_document in
    select d.id, d.engagement_id, d.title, e.person_id, o.name as org_name
    from app.engagement_document_texts x
    join app.engagement_documents d on d.id = x.engagement_document_id and d.deleted_at is null
    join app.engagements e on e.id = d.engagement_id
    join app.organizations o on o.id = d.org_id
    where x.engagement_document_batch_id = v_batch.id and x.deleted_at is null and d.engagement_document_state = 'Proposed'
    order by d.id
  loop
    perform private.transition_lifecycle('engagement_document', 'app.engagement_documents', 'engagement_document_state',
      'app.engagement_document_state_transitions', 'engagement_document_id', v_document.id, 'Proposed', 'Sent', 'Sent with an agreement batch.');
    perform private.notify(v_batch.org_id, v_document.person_id, 'engagement_document.sent', 'engagement_documents', v_document.id,
      v_batch.project_id, jsonb_build_object('orgName', v_document.org_name, 'title', v_document.title,
        'gatewayPath', '/work/engagements/' || private.gateway_display_key('ENG', v_document.engagement_id) || '/documents'));
    v_count := v_count + 1;
  end loop;
  update app.engagement_document_batches set sent_at = coalesce(sent_at, now()) where id = v_batch.id;
  perform private.emit_event(v_batch.org_id, 'engagement_document_batch.sent', 'engagement_document_batches', v_batch.id,
    v_batch.project_id, jsonb_build_object('sent', v_count));
  return v_count;
end;
$$;

comment on function app.send_engagement_document_batch(uuid) is 'Sends every Proposed document of a batch (Proposed to Sent, the rule of app.transition_engagement_document) and tells each engaged person (engagement_document.sent, opening the Gateway Documents tab). Needs opportunities.engagement.write on the project. Stamps sent_at once and returns how many were sent.';

create or replace function app.countersign_engagement_document_batch(p_batch_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_batch app.engagement_document_batches := private.authorized_document_batch(p_batch_id);
  v_document uuid;
  v_executed integer := 0;
  v_refused jsonb := '[]'::jsonb;
  v_hint text;
begin
  for v_document in
    select d.id from app.engagement_document_texts x
    join app.engagement_documents d on d.id = x.engagement_document_id and d.deleted_at is null
    where x.engagement_document_batch_id = v_batch.id and x.deleted_at is null and d.engagement_document_state = 'Signed'
    order by d.id
  loop
    begin
      perform private.transition_lifecycle('engagement_document', 'app.engagement_documents', 'engagement_document_state',
        'app.engagement_document_state_transitions', 'engagement_document_id', v_document, 'Signed', 'Executed', 'Countersigned with the agreement batch.');
      v_executed := v_executed + 1;
    exception when sqlstate 'XR001' then
      get stacked diagnostics v_hint = pg_exception_hint;
      v_refused := v_refused || jsonb_build_array(jsonb_build_object('id', v_document, 'code', coalesce(nullif(v_hint, ''), 'refused')));
    end;
  end loop;
  return jsonb_build_object('executed', v_executed, 'refused', v_refused);
end;
$$;

comment on function app.countersign_engagement_document_batch(uuid) is 'Countersigns every Signed document of a batch (Signed to Executed) with the authority of app.transition_engagement_document: opportunities.engagement.write on the project. Each runs in its own subtransaction, and an Automatic Electronic Signature requirement is then verified. Returns {executed, refused: [{id, code}]}; the engaged person countersigning their own Automatic item is refused sod_onboarding_self_verify.';

-- The party ---------------------------------------------------------------------------------------------------------------

create or replace function private.assert_document_party(p_document_id uuid)
returns app.engagement_documents
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_document app.engagement_documents;
begin
  perform private.require_person();
  select * into v_document from app.engagement_documents d where d.id = p_document_id and d.deleted_at is null for update;
  -- The caller rule of app.sign_engagement_document (0710): the engaged party while the documents area is open.
  if v_document.id is null or not exists (select 1 from private.engagement_scope(v_document.engagement_id) a where a = 'documents') then
    raise exception using errcode = '42501', message = 'the documents of this engagement are not open to the caller';
  end if;
  return v_document;
end;
$$;

comment on function private.assert_document_party(uuid) is 'Locks an engagement document for its engaged party while the documents area is open (the caller rule of 0710); 42501 otherwise.';
revoke all on function private.assert_document_party(uuid) from public, anon, authenticated;

create or replace function private.engagement_document_text_masked(p_document app.engagement_documents)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select private.engagement_document_masked_for_party(t.body_template, e.person_id)
    from app.engagement_document_texts x
    join app.engagements e on e.id = p_document.engagement_id
    join app.engagement_document_batches b on b.id = x.engagement_document_batch_id
    join app.engagement_document_templates t on t.id = b.engagement_document_template_id
    where x.engagement_document_id = p_document.id and x.deleted_at is null), false);
$$;

comment on function private.engagement_document_text_masked(app.engagement_documents) is 'True when the document has a text the caller reads masked (private.engagement_document_masked_for_party); false for a document with no text.';
revoke all on function private.engagement_document_text_masked(app.engagement_documents) from public, anon, authenticated;

create or replace function app.sign_engagement_document_text(p_document_id uuid, p_signed_name text, p_body_sha256 text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_document app.engagement_documents := private.assert_document_party(p_document_id);
  v_text app.engagement_document_texts;
  v_requirement uuid;
  v_name text := btrim(coalesce(p_signed_name, ''));
begin
  select * into v_text from app.engagement_document_texts x where x.engagement_document_id = v_document.id and x.deleted_at is null for update;
  if v_text.id is null then
    perform private.refuse('document_text_missing', 'This document has no text to sign here. Sign it the way it was sent.');
  end if;
  if private.engagement_document_text_masked(v_document) then
    perform private.refuse('document_text_masked', 'This text holds a rate your representation does not cover, so only the engaged person can answer it.');
  end if;
  if v_document.engagement_document_state <> 'Sent' or v_text.signed_at is not null then
    perform private.refuse('document_not_awaiting_signature', 'This document is not waiting for your signature.');
  end if;
  if char_length(v_name) not between 1 and 200 then
    perform private.refuse('document_signer_name', 'Type your full name, up to 200 characters, to sign.');
  end if;
  if p_body_sha256 is distinct from encode(extensions.digest(v_text.body, 'sha256'), 'hex') then
    perform private.refuse('document_text_hash', 'The text changed since you opened it. Read it again, then sign.');
  end if;
  perform private.begin_trusted_operation('engagement_document_text_sign');
  update app.engagement_document_texts set signed_name = v_name, signed_body_sha256 = p_body_sha256, signed_at = now()
  where id = v_text.id;
  perform private.end_trusted_operation('engagement_document_text_sign');
  select b.onboarding_requirement_id into v_requirement from app.engagement_document_batches b where b.id = v_text.engagement_document_batch_id;
  if v_requirement is not null then
    update app.onboarding_items set submitted_at = now()
    where engagement_id = v_document.engagement_id and onboarding_requirement_id = v_requirement and deleted_at is null;
  end if;
  return private.transition_lifecycle('engagement_document', 'app.engagement_documents', 'engagement_document_state',
    'app.engagement_document_state_transitions', 'engagement_document_id', v_document.id, 'Sent', 'Signed', 'Signed by the party.');
end;
$$;

comment on function app.sign_engagement_document_text(uuid, text, text) is 'The engaged party signs a Sent generated document with their typed name and the SHA-256 of the text they read (the caller rule of app.sign_engagement_document). Records the signature, submits the engagement''s onboarding item for the batch''s requirement, and moves Sent to Signed. Refusals: document_text_missing, document_text_masked, document_not_awaiting_signature, document_signer_name, document_text_hash. Returns the ledger entry id.';

create or replace function app.decline_engagement_document(p_document_id uuid, p_reason text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_document app.engagement_documents := private.assert_document_party(p_document_id);
  v_reason text := btrim(coalesce(p_reason, ''));
  v_ledger uuid;
begin
  if private.engagement_document_text_masked(v_document) then
    perform private.refuse('document_text_masked', 'This text holds a rate your representation does not cover, so only the engaged person can answer it.');
  end if;
  if char_length(v_reason) not between 1 and 450 then
    perform private.refuse('document_decline_reason', 'Say why you decline, in up to 450 characters.');
  end if;
  if v_document.engagement_document_state <> 'Sent' then
    perform private.refuse('document_not_awaiting_signature', 'This document is not waiting for your signature.');
  end if;
  v_ledger := private.transition_lifecycle('engagement_document', 'app.engagement_documents', 'engagement_document_state',
    'app.engagement_document_state_transitions', 'engagement_document_id', v_document.id, 'Sent', 'Canceled',
    'Declined by the party: ' || v_reason);
  perform private.emit_event(v_document.org_id, 'engagement_document.declined', 'engagement_documents', v_document.id,
    (select e.project_id from app.engagements e where e.id = v_document.engagement_id), '{}'::jsonb);
  return v_ledger;
end;
$$;

comment on function app.decline_engagement_document(uuid, text) is 'The engaged party declines a Sent document with a reason of 1 to 450 characters (document_decline_reason): Sent to Canceled with the ledger reason ''Declined by the party: <reason>'', which fits the ledger''s 500 characters uncut. The reason stays in the ledger and out of the engagement_document.declined event. Same caller rule as signing, and a masked representative is refused document_text_masked; 42501 for anyone else.';

-- Executed verifies an Automatic requirement ---------------------------------------------------------------------------------

create or replace function private.verify_engagement_document_executed()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_item uuid;
  v_me uuid := private.current_person_id();
begin
  if not (old.engagement_document_state = 'Signed' and new.engagement_document_state = 'Executed') then
    return null;
  end if;
  select i.id into v_item
  from app.engagement_document_texts x
  join app.engagement_document_batches b on b.id = x.engagement_document_batch_id
  join app.onboarding_requirements r on r.id = b.onboarding_requirement_id and r.deleted_at is null
    and r.verification_method = 'Automatic'
  join app.onboarding_items i on i.engagement_id = new.engagement_id and i.onboarding_requirement_id = r.id and i.deleted_at is null
  where x.engagement_document_id = new.id and x.deleted_at is null and x.signed_at is not null;
  if v_item is null then
    return null;
  end if;
  -- The guard below stamps no reviewer under this operation, so the separation of duties is checked here, on every path
  -- to Executed: the batch and app.transition_engagement_document.
  if v_me is not null and v_me = (select e.person_id from app.engagements e where e.id = new.engagement_id) then
    perform private.refuse('sod_onboarding_self_verify', 'An engaged party cannot verify their own onboarding.');
  end if;
  perform private.begin_trusted_operation('engagement_document_executed');
  insert into app.onboarding_verifications (onboarding_item_id, outcome, note)
  values (v_item, 'Passed', 'Verified when the signed agreement was countersigned.');
  perform private.end_trusted_operation('engagement_document_executed');
  return null;
end;
$$;

comment on function private.verify_engagement_document_executed() is 'When a generated document signed with its text is countersigned (Signed to Executed) and its batch''s requirement is verified Automatically, writes a Passed verification of the engagement''s item with no reviewer, under the trusted operation engagement_document_executed. Superseded or Expired writes nothing. Refuses sod_onboarding_self_verify when the engaged person is the one countersigning.';
revoke all on function private.verify_engagement_document_executed() from public, anon, authenticated;

create trigger t86_verify_engagement_document_executed after update of engagement_document_state on app.engagement_documents
  for each row execute function private.verify_engagement_document_executed();

-- From 1306, its latest definition: an automatic verification of an executed document has no reviewer.
create or replace function private.guard_onboarding_verification()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid := private.current_person_id();
  v_engagement app.engagements;
  v_requirement app.onboarding_requirements;
  v_automatic boolean := private.in_trusted_operation('engagement_document_executed');
begin
  select e.* into v_engagement from app.onboarding_items i join app.engagements e on e.id = i.engagement_id where i.id = new.onboarding_item_id;
  select r.* into v_requirement from app.onboarding_items i join app.onboarding_requirements r on r.id = i.onboarding_requirement_id
  where i.id = new.onboarding_item_id;
  if v_automatic then
    -- B10: the platform verifies an Automatic Electronic Signature item when its signed agreement is executed.
    if v_requirement.verification_method <> 'Automatic' then
      perform private.refuse('verification_automatic', 'Only an Automatic requirement is verified by the platform.');
    end if;
    v_me := null;
  end if;
  new.verified_by := v_me;
  new.verified_at := now();
  if v_me is not null and v_requirement.verification_method = 'Automatic' then
    perform private.refuse('verification_automatic', 'This item is verified automatically by its integration.');
  end if;
  if v_me is not null and (v_engagement.person_id = v_me or v_engagement.counterparty_id in (
      select c.id from app.counterparties c where c.organization_id in (select private.my_account_ids(null)))) then
    perform private.refuse('sod_onboarding_self_verify', 'An engaged party cannot verify their own onboarding.');
  end if;
  if new.outcome = 'Passed' and new.expires_on is null and v_requirement.valid_for_days is not null then
    new.expires_on := private.org_today(v_requirement.org_id) + v_requirement.valid_for_days;
  end if;
  return new;
end;
$$;

comment on function private.guard_onboarding_verification() is 'Verifications: reviewer stamped from the session, never the engaged party (Section 8.2), Reviewer items only by people and Automatic items only by the platform (B10: including under the trusted operation engagement_document_executed, with no reviewer), and a Passed verification expires after the requirement''s validity, counted from today on the org''s calendar (A71).';
revoke all on function private.guard_onboarding_verification() from public, anon, authenticated;

-- Privileges ---------------------------------------------------------------------------------------------------------------

revoke all on function app.create_engagement_document_batch(uuid, uuid, jsonb, uuid) from public, anon;
revoke all on function app.send_engagement_document_batch(uuid) from public, anon;
revoke all on function app.countersign_engagement_document_batch(uuid) from public, anon;
revoke all on function app.sign_engagement_document_text(uuid, text, text) from public, anon;
revoke all on function app.decline_engagement_document(uuid, text) from public, anon;
grant execute on function app.create_engagement_document_batch(uuid, uuid, jsonb, uuid) to authenticated, service_role;
grant execute on function app.send_engagement_document_batch(uuid) to authenticated, service_role;
grant execute on function app.countersign_engagement_document_batch(uuid) to authenticated, service_role;
grant execute on function app.sign_engagement_document_text(uuid, text, text) to authenticated, service_role;
grant execute on function app.decline_engagement_document(uuid, text) to authenticated, service_role;

select private.sync_trash_tables();

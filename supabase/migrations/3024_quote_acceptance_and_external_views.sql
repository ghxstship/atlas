-- 3024_quote_acceptance_and_external_views.sql
-- B13 (RRR-237, gap G-188 phase 1; S14.5-01, S4.4-12, ADR 0152). A client accepts a quote by signing its Quote
-- engagement document, and reads the quote only through client-facing views.
--
--   * Acceptance: t60_accept_quote_on_signature fires on every Sent to Signed of a Quote document, whichever path
--     signed it: a signing link (api_public.token_sign_document, 0769) or Gateway signed in (app.sign_engagement_document,
--     0710). Neither function is redefined. The version moves to Accepted with who signed and when, a live Draft of the
--     quote is deleted, and the sender is told (quote.accepted). A signing link already expires at valid until; an
--     acceptance after it is refused (quote_expired) all the same. Inside token_sign_document the refusal raises, so
--     Gateway maps quote_expired to copy. The name typed on a link reaches the version when the link records it.
--   * The acceptance lock: 3023's guards refuse every edit, new version, withdraw, decline and delete of an accepted
--     quote. Later client-visible changes go through change orders and client approvals (0770).
--   * api_external.quote_versions and api_external.quote_version_lines: plain views filtered to the caller's open
--     documents area (0750), with client-facing columns only: never cost, unit cost, markup, margin, URID, cost center,
--     account, grade, element or budget ids. A Draft never appears.
--   * api_public.token_quote: the same client-facing quote for anyone holding a Quote document's signing link and code,
--     through private.resolve_document_token (1295), so wrong codes count toward the lock.
--   * Gateway bulk signing (2160) skips Quote documents: a quote is signed one at a time, after its lines and total are
--     shown.

-- 1. Acceptance --------------------------------------------------------------------------------------------------------

create or replace function private.accept_quote_on_signature()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_version app.quote_versions;
  v_project uuid;
  v_name text;
begin
  select v.* into v_version from app.quote_versions v
  where v.engagement_document_id = new.engagement_document_id and v.deleted_at is null;
  if v_version.id is null then
    return null;
  end if;
  perform 1 from app.quotes q where q.id = v_version.quote_id for update;
  select v.* into v_version from app.quote_versions v where v.id = v_version.id;
  if v_version.quote_version_state <> 'Sent' then
    perform private.refuse('quote_not_sent', 'This quote version is no longer waiting for a signature.');
  end if;
  v_project := private.quote_version_project(v_version.id);
  if v_version.valid_until < private.project_today(v_project) then
    perform private.refuse('quote_expired', 'This quote expired, so it can no longer be accepted. Ask for a new version.');
  end if;
  select p.full_name into v_name from app.people p where p.id = new.created_by;

  perform private.begin_trusted_operation('quote_acceptance');
  perform private.begin_trusted_operation('quote_version_transition');
  update app.quote_versions v set quote_version_state = 'Accepted', accepted_at = now(), accepted_by = new.created_by,
    accepted_name = v_name
  where v.id = v_version.id and v.quote_version_state = 'Sent';
  perform private.end_trusted_operation('quote_version_transition');
  insert into app.quote_version_state_transitions (quote_version_id, from_state, to_state, reason)
  values (v_version.id, 'Sent', 'Accepted', 'Accepted by the client''s signature.');
  update app.quote_versions v set deleted_at = now()
  where v.quote_id = v_version.quote_id and v.quote_version_state = 'Draft' and v.deleted_at is null;
  perform private.end_trusted_operation('quote_acceptance');

  -- A link records its signer's typed name after this, and the sender is told then (private.quote_signer_name).
  if new.created_by is not null then
    perform private.notify(v_version.org_id, v_version.sent_by, 'quote.accepted', 'quote_versions', v_version.id, v_project,
      jsonb_build_object('quoteKey', private.quote_key(v_version.quote_id), 'version', v_version.version_number,
        'actorName', coalesce(v_name, private.quote_party_name(
          (select q.engagement_id from app.quotes q where q.id = v_version.quote_id), v_project))));
  end if;
  return null;
end;
$$;
comment on function private.accept_quote_on_signature() is 'After a Quote engagement document is signed (Sent to Signed, by link or signed in): moves its Sent quote version to Accepted with accepted_at, the signed-in signer as accepted_by and their name, deletes a live Draft of the quote, and tells the version''s sender (quote.accepted) when the signer was signed in; a link''s signer is named, and the sender told, by private.quote_signer_name. Refuses quote_expired after valid until on the project''s calendar and quote_not_sent when the version left Sent.';
revoke all on function private.accept_quote_on_signature() from public, anon, authenticated;
create trigger t60_accept_quote_on_signature after insert on app.engagement_document_state_transitions
  for each row when (new.to_state = 'Signed')
  execute function private.accept_quote_on_signature();

-- token_sign_document records the typed name after the transition, in the same transaction.
create or replace function private.quote_signer_name()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_version app.quote_versions;
begin
  if new.used_at is not null and new.signer_name is not null then
    perform private.begin_trusted_operation('quote_acceptance');
    update app.quote_versions v set accepted_name = new.signer_name
    where v.engagement_document_id = new.engagement_document_id and v.quote_version_state = 'Accepted'
      and v.accepted_name is null
    returning v.* into v_version;
    perform private.end_trusted_operation('quote_acceptance');
    if v_version.id is not null then
      perform private.notify(v_version.org_id, v_version.sent_by, 'quote.accepted', 'quote_versions', v_version.id,
        private.quote_version_project(v_version.id),
        jsonb_build_object('quoteKey', private.quote_key(v_version.quote_id), 'version', v_version.version_number,
          'actorName', new.signer_name));
    end if;
  end if;
  return null;
end;
$$;
comment on function private.quote_signer_name() is 'After a signing link records its signer: the name typed becomes the accepted quote version''s accepted_name when it has none, and the version''s sender is told (quote.accepted) with that name.';
revoke all on function private.quote_signer_name() from public, anon, authenticated;
create trigger t60_quote_signer_name after update of used_at on app.engagement_document_tokens
  for each row execute function private.quote_signer_name();

-- 2. Gateway bulk signing skips quotes (from 2160, its only definition) --------------------------------------------------

create or replace function private.bulk_my_engagement_documents_row(p_id uuid, p_set jsonb, p_expect jsonb, p_reason text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_old app.engagement_documents;
  v_new app.engagement_documents;
  v_state app.engagement_document_state;
begin
  perform private.require_person();
  perform private.bulk_check_fields(p_set, p_expect, 'engagement_document_state');
  select * into v_old from app.engagement_documents d where d.id = p_id and d.deleted_at is null for update;
  if v_old.id is null
     or not exists (select 1 from private.engagement_scope(v_old.engagement_id) a where a = 'documents') then
    perform private.refuse('bulk_row_not_found', 'This row no longer exists or is not available to you.');
  end if;
  perform private.bulk_check_expect(to_jsonb(v_old), p_expect);
  -- A quote is signed on its own, after its lines and total are shown (B13).
  if v_old.document_kind = 'Quote' then
    return jsonb_build_object('org_id', v_old.org_id, 'changed', false);
  end if;
  v_state := case when p_set ? 'engagement_document_state'
                  then (p_set ->> 'engagement_document_state')::app.engagement_document_state
                  else v_old.engagement_document_state end;
  if v_state = v_old.engagement_document_state then
    return jsonb_build_object('org_id', v_old.org_id, 'changed', false);
  end if;
  if v_state <> 'Signed' then
    perform private.refuse('bulk_field_not_editable', 'In Gateway a document is signed; a signature cannot be undone.');
  end if;
  if v_old.engagement_document_state <> 'Sent' then
    perform private.refuse('document_not_awaiting_signature', 'This document is not waiting for your signature.');
  end if;
  perform app.sign_engagement_document(p_id, coalesce(nullif(btrim(p_reason), ''), 'Signed in Gateway.'));
  select * into v_new from app.engagement_documents d where d.id = p_id;
  return jsonb_build_object('org_id', v_old.org_id, 'changed', true,
    'before', jsonb_build_object('engagement_document_state', v_old.engagement_document_state),
    'after', jsonb_build_object('engagement_document_state', v_new.engagement_document_state));
end;
$$;

comment on function private.bulk_my_engagement_documents_row(uuid, jsonb, jsonb, text) is 'One document of the person''s engagements in a Gateway bulk action: sign a document sent for signature through app.sign_engagement_document, with its rule on who signs. A signature is final. A Quote document is skipped (unchanged): a quote is signed on its own after its lines and total are shown (B13). Rows outside the person''s open documents area read as not found.';
revoke all on function private.bulk_my_engagement_documents_row(uuid, jsonb, jsonb, text) from public, anon, authenticated;

-- 3. Client-facing views -------------------------------------------------------------------------------------------------

create view api_external.quote_versions as
select v.id, v.quote_id, p.project_key || '-Q-' || q.quote_number::text as quote_key, q.title, p.id as project_id,
  p.name as project_name, v.version_number, v.quote_version_state, v.valid_until, v.terms, bv.currency_code,
  t.total_minor, v.content_sha256, v.sent_at, v.accepted_at, v.accepted_name, v.engagement_document_id
from app.quote_versions v
join app.quotes q on q.id = v.quote_id
join app.budgets b on b.id = q.budget_id
join app.projects p on p.id = b.project_id
join app.budget_versions bv on bv.id = v.budget_version_id
cross join lateral (
  select case when count(*) filter (where l.client_unit_price_minor is null) > 0 then null
              else sum(private.extended_minor(l.quantity, l.client_unit_price_minor)) end::bigint as total_minor
  from app.budget_version_lines l
  where l.budget_version_id = v.budget_version_id and not l.excluded_from_quote
) t
where v.deleted_at is null and q.deleted_at is null and v.quote_version_state <> 'Draft'
  and v.engagement_document_id in (select d.id from api_external.engagement_documents d);

call private.describe('api_external.quote_versions', 'Quote versions sent to the caller''s engagements while the documents area is open (S4.4-12, ADR 0152): client-facing columns only. A Draft never appears; costs, markups, margins and budget coding never do.', array[
  'id', 'Quote version.', 'quote_id', 'Quote.', 'quote_key', 'Quote key, <project key>-Q-<number>.', 'title', 'Quote title.',
  'project_id', 'Project.', 'project_name', 'Project name.', 'version_number', 'Version number.',
  'quote_version_state', 'Sent, Accepted, Declined, Withdrawn or Superseded.', 'valid_until', 'Last day to accept.',
  'terms', 'Notes and terms.', 'currency_code', 'Currency of every amount.', 'total_minor', 'Quote total in minor units.',
  'content_sha256', 'SHA-256 fingerprint of the quote''s content, printed on the PDF.', 'sent_at', 'When sent.',
  'accepted_at', 'When accepted.', 'accepted_name', 'Who accepted it.', 'engagement_document_id', 'Quote document to sign.']);

create view api_external.quote_version_lines as
select l.id, v.id as quote_version_id, l.line_number, l.description, l.quantity, l.unit_basis,
  l.client_unit_price_minor as unit_price_minor, private.extended_minor(l.quantity, l.client_unit_price_minor) as amount_minor
from api_external.quote_versions v
join app.quote_versions qv on qv.id = v.id
join app.budget_version_lines l on l.budget_version_id = qv.budget_version_id
where not l.excluded_from_quote;

call private.describe('api_external.quote_version_lines', 'Lines of the quote versions in api_external.quote_versions: what the client is quoted for, at client prices. Internal lines never appear.', array[
  'id', 'Quote line.', 'quote_version_id', 'Quote version.', 'line_number', 'Line number.', 'description', 'Description.',
  'quantity', 'Quantity.', 'unit_basis', 'Unit.', 'unit_price_minor', 'Unit price quoted, in minor units.',
  'amount_minor', 'Quantity times the unit price, in minor units.']);

revoke all on api_external.quote_versions, api_external.quote_version_lines from public, anon;
grant select on api_external.quote_versions, api_external.quote_version_lines to authenticated, service_role;

-- 4. The token reader --------------------------------------------------------------------------------------------------

create or replace function api_public.token_quote(p_token text, p_access_code text)
returns table (refusal text, reason text, quote jsonb)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_token_id uuid;
  v_reason text;
  v_quote jsonb;
begin
  select r.token_id, r.reason into v_token_id, v_reason from private.resolve_document_token(p_token, p_access_code) r;
  if v_reason is not null then
    return query select 'REFUSE'::text, v_reason, null::jsonb;
    return;
  end if;
  select jsonb_build_object(
      'id', v.id, 'quote_key', private.quote_key(q.id), 'title', q.title, 'org_name', o.name,
      'project_name', p.name, 'client_name', private.quote_party_name(q.engagement_id, p.id),
      'version_number', v.version_number, 'quote_version_state', v.quote_version_state,
      'valid_until', v.valid_until, 'terms', v.terms, 'currency_code', bv.currency_code,
      'content_sha256', v.content_sha256, 'sent_at', v.sent_at, 'accepted_at', v.accepted_at,
      'accepted_name', v.accepted_name, 'engagement_document_id', v.engagement_document_id,
      'total_minor', (select case when count(*) filter (where l.client_unit_price_minor is null) > 0 then null
                                  else sum(private.extended_minor(l.quantity, l.client_unit_price_minor)) end
                      from app.budget_version_lines l where l.budget_version_id = bv.id and not l.excluded_from_quote),
      'lines', coalesce((select jsonb_agg(jsonb_build_object(
                  'id', l.id, 'line_number', l.line_number, 'description', l.description, 'quantity', l.quantity,
                  'unit_basis', l.unit_basis, 'unit_price_minor', l.client_unit_price_minor,
                  'amount_minor', private.extended_minor(l.quantity, l.client_unit_price_minor)) order by l.line_number)
                from app.budget_version_lines l where l.budget_version_id = bv.id and not l.excluded_from_quote), '[]'::jsonb))
    into v_quote
  from app.engagement_document_tokens t
  join app.quote_versions v on v.engagement_document_id = t.engagement_document_id and v.deleted_at is null
  join app.quotes q on q.id = v.quote_id
  join app.budgets b on b.id = q.budget_id
  join app.projects p on p.id = b.project_id
  join app.organizations o on o.id = v.org_id
  join app.budget_versions bv on bv.id = v.budget_version_id
  where t.id = v_token_id and v.quote_version_state <> 'Draft';
  if v_quote is null then
    return query select 'REFUSE'::text, 'quote_not_found'::text, null::jsonb;
    return;
  end if;
  return query select null::text, null::text, v_quote;
end;
$$;
comment on function api_public.token_quote(text, text) is 'The quote behind a Quote document''s signing link (S4.4-12): with a valid link and access code, the client-facing quote (key, title, org, project, client, version, state, valid until, terms, currency, fingerprint, sent and accepted, total and lines at client prices) as jsonb. Otherwise one row with refusal REFUSE and the reason: the token reasons of api_public.token_document (wrong codes count toward the lock at 5), or quote_not_found when the link signs no quote.';
revoke all on function api_public.token_quote(text, text) from public;
grant execute on function api_public.token_quote(text, text) to anon, authenticated, service_role;

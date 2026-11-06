-- 3023_quotes.sql
-- B13 (RRR-237, gap G-188 phase 1; Section 4.2 Finance, S14.5-01, ADR 0152). Client quotes built from a budget, with
-- versions, a send that freezes what the client sees, and an acceptance lock (3024).
--
--   * app.quotes: a quote of one budget for one Client engagement of the budget's project, keyed <project>-Q-<n> from
--     the project's display key sequence, as change orders are (0321). The project, the currency and the client are
--     read through the budget and the engagement, never stored (denormalization register): the client shown is the
--     engagement's person or counterparty, else the project's client counterparty (0301), and the currency is the
--     budget's while a version is a Draft and its version's frozen currency once sent.
--   * app.quote_versions: Draft, Sent, Accepted, Declined, Withdrawn or Superseded. A Draft prices from the live
--     budget; the send captures a Quote budget version (3021), fixes a SHA-256 fingerprint of the client-facing
--     content, and creates the Quote engagement document the client signs (3022). At most one live Draft and at most
--     one Accepted version per quote.
--   * app.send_quote_version, app.create_quote, app.create_quote_version, app.withdraw_quote_version and
--     app.decline_quote_version are the only writers of what a client sees; each locks the quote row first.
--   * A Quote engagement document is locked to the quote (t45_guard_quote_document): it is created, moved and edited
--     only inside the quote operations, except the client's Sent to Signed through either signing path.
--   * app.quote_statuses: one row per live quote with its display state (Expired computed), totals and draft flag.
-- Trash: app.quotes is in (titled by title); app.quote_versions has no title column, so it is never a candidate.
-- XOS never holds funds: there is no Paid state, deposit or payment on a quote.

-- 1. States, rules and events ------------------------------------------------------------------------------------------

create type app.quote_version_state as enum ('Draft', 'Sent', 'Accepted', 'Declined', 'Withdrawn', 'Superseded');
comment on type app.quote_version_state is 'Quote version lifecycle (ADR 0152): Draft (priced from the live budget), Sent (frozen and out for signature), then Accepted by the client''s signature, Declined, Withdrawn by the org, or Superseded by a later version. Expired is computed from valid_until, never stored.';

insert into private.lifecycle_transition_rules (lifecycle, from_state, to_state) values
  ('quote_version', 'Draft', 'Sent'),
  ('quote_version', 'Sent', 'Accepted'),
  ('quote_version', 'Sent', 'Declined'),
  ('quote_version', 'Sent', 'Withdrawn'),
  ('quote_version', 'Sent', 'Superseded');

insert into private.domain_event_types (code, subject, description) values
  ('quote.sent', 'quote_versions', 'A quote version was sent to the client for signature.'),
  ('quote.accepted', 'quote_versions', 'The client accepted a quote version by signing it.'),
  ('quote.declined', 'quote_versions', 'A sent quote version was marked declined.'),
  ('quote.withdrawn', 'quote_versions', 'The org withdrew a sent quote version.');

-- 2. Quotes ------------------------------------------------------------------------------------------------------------

create table app.quotes (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  budget_id uuid not null references app.budgets (id),
  engagement_id uuid references app.engagements (id),
  quote_number bigint not null,
  title text not null,
  deleted_at timestamptz,
  constraint quotes_title_length check (char_length(btrim(title)) between 1 and 200)
);

create index quotes_budget_id_idx on app.quotes (budget_id);
create index quotes_engagement_id_idx on app.quotes (engagement_id);

call private.install_domain_table('app.quotes', 'app.budgets', 'budget_id', array['app.engagements', 'engagement_id']);
call private.describe('app.quotes', 'Client quotes (G-188 phase 1, ADR 0152): a quote of one budget for a Client engagement of the budget''s project, with numbered versions. The project, currency and client are read through the budget and the engagement. Written through the quote RPCs, except the title, the client engagement before a send, and a soft delete before a send.', array[
  'budget_id', 'Budget the quote prices from; its project is the quote''s project. Never changes.',
  'engagement_id', 'Client engagement (role type Client) of the budget''s project the quote is for. Required to send; fixed once a version was sent.',
  'quote_number', 'Number in the project''s display key sequence, shared with its other records: the key is <project key>-Q-<number>. Never changes.',
  'title', 'What the quote is for, 1 to 200 characters. Fixed once a version is accepted.'
]);

create or replace function private.guard_quote()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_project uuid;
  v_engagement app.engagements;
begin
  select b.project_id into v_project from app.budgets b where b.id = new.budget_id;
  if tg_op = 'INSERT' then
    if v_project is null or exists (select 1 from app.budgets b where b.id = new.budget_id and b.deleted_at is not null) then
      perform private.refuse('budget_not_found', 'This budget no longer exists.');
    end if;
    new.quote_number := private.next_sequence(new.org_id, 'project:' || v_project::text);
  else
    if new.budget_id <> old.budget_id or new.quote_number <> old.quote_number then
      perform private.refuse('quote_immutable', 'A quote keeps its budget and number.');
    end if;
    if new.engagement_id is distinct from old.engagement_id and private.quote_has_sent(new.id) then
      perform private.refuse('quote_sent_parties', 'The client is fixed once a version was sent; start a new quote for another client.');
    end if;
    if new.title <> old.title and exists (select 1 from app.quote_versions v
        where v.quote_id = new.id and v.quote_version_state = 'Accepted') then
      perform private.refuse('quote_accepted_locked', 'This quote was accepted, so it can''t change. Record changes as a change order.');
    end if;
    if new.deleted_at is not null and old.deleted_at is null and private.quote_has_sent(new.id) then
      perform private.refuse('quote_sent_permanent', 'A quote that was sent is kept; withdraw its version instead.');
    end if;
  end if;
  if new.engagement_id is distinct from (case when tg_op = 'UPDATE' then old.engagement_id end) and new.engagement_id is not null then
    select e.* into v_engagement from app.engagements e where e.id = new.engagement_id and e.deleted_at is null;
    if v_engagement.id is null or v_engagement.project_id <> v_project then
      perform private.refuse('quote_budget_project', 'The client engagement is on the budget''s project.');
    end if;
    if v_engagement.role_type <> 'Client' then
      perform private.refuse('quote_client_engagement', 'A quote goes to a Client engagement of the project.');
    end if;
  end if;
  return new;
end;
$$;
comment on function private.guard_quote() is 'Quotes: numbered from the project''s display key sequence on insert, for a live budget; the budget and number never change (quote_immutable); the engagement is a live Client engagement on the budget''s project (quote_budget_project, quote_client_engagement) and is fixed once a version was sent (quote_sent_parties); the title is fixed once accepted (quote_accepted_locked); a quote that was sent is never deleted (quote_sent_permanent).';
revoke all on function private.guard_quote() from public, anon, authenticated;
create trigger t40_guard_quote before insert or update on app.quotes
  for each row execute function private.guard_quote();

call private.install_policies('app.quotes',
  $$budget_id in (select b.id from app.budgets b where b.project_id in (select private.project_ids_with('finance.budget.read')))$$,
  $$budget_id in (select b.id from app.budgets b where b.project_id in (select private.project_ids_with('finance.budget.write')))$$);
drop policy quotes_insert on app.quotes;
revoke insert, update on app.quotes from authenticated;
grant update (title, engagement_id, deleted_at) on app.quotes to authenticated;
call private.install_default_retention('app.quotes');
call private.install_audit_trail('app.quotes');

-- 3. Quote versions ----------------------------------------------------------------------------------------------------

create table app.quote_versions (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  quote_id uuid not null references app.quotes (id),
  version_number integer not null,
  valid_until date not null,
  terms text,
  quote_version_state app.quote_version_state not null default 'Draft',
  budget_version_id uuid references app.budget_versions (id),
  content_sha256 text,
  engagement_document_id uuid references app.engagement_documents (id),
  sent_at timestamptz,
  sent_by uuid references app.people (id),
  accepted_at timestamptz,
  accepted_by uuid references app.people (id),
  accepted_name text,
  sent_title text,
  sent_client_name text,
  deleted_at timestamptz,
  constraint quote_versions_number_positive check (version_number > 0),
  constraint quote_versions_terms_length check (terms is null or char_length(btrim(terms)) between 1 and 4000),
  constraint quote_versions_frozen check (
    (budget_version_id is null) = (quote_version_state = 'Draft')
    and (content_sha256 is null) = (quote_version_state = 'Draft')
    and (engagement_document_id is null) = (quote_version_state = 'Draft')
    and (sent_at is null) = (quote_version_state = 'Draft')
    and (sent_by is null) = (quote_version_state = 'Draft')
    and (sent_title is null) = (quote_version_state = 'Draft')
    and (sent_client_name is null) = (quote_version_state = 'Draft')),
  constraint quote_versions_accepted check ((accepted_at is null) = (quote_version_state <> 'Accepted')),
  constraint quote_versions_hash_format check (content_sha256 is null or content_sha256 ~ '^[0-9a-f]{64}$'),
  constraint quote_versions_accepted_name_length check (accepted_name is null or char_length(btrim(accepted_name)) between 1 and 200)
);

create unique index quote_versions_number_key on app.quote_versions (quote_id, version_number);
create unique index quote_versions_one_draft on app.quote_versions (quote_id)
  where quote_version_state = 'Draft' and deleted_at is null;
create unique index quote_versions_one_accepted on app.quote_versions (quote_id) where quote_version_state = 'Accepted';
create index quote_versions_budget_version_id_idx on app.quote_versions (budget_version_id);
create unique index quote_versions_engagement_document_key on app.quote_versions (engagement_document_id);
create index quote_versions_sent_by_idx on app.quote_versions (sent_by);
create index quote_versions_accepted_by_idx on app.quote_versions (accepted_by);

create or replace function private.quote_has_sent(p_quote_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from app.quote_versions v
                 where v.quote_id = p_quote_id and v.quote_version_state <> 'Draft');
$$;

comment on function private.quote_has_sent(uuid) is 'True when any version of the quote left Draft, so its client is fixed and it is never deleted.';
revoke all on function private.quote_has_sent(uuid) from public, anon, authenticated;

call private.install_domain_table('app.quote_versions', 'app.quotes', 'quote_id',
  array['app.budget_versions', 'budget_version_id', 'app.engagement_documents', 'engagement_document_id']);
call private.describe('app.quote_versions', 'Versions of a quote (ADR 0152). A Draft prices from the live budget and is the only version that can be edited or deleted. Sending freezes it: the Quote budget version it prices from, the SHA-256 fingerprint of its client-facing content and the Quote engagement document the client signs. Acceptance is that signature; an accepted version never changes.', array[
  'quote_id', 'Quote the version belongs to.',
  'version_number', 'Number of the version within its quote, from 1.',
  'valid_until', 'Last day the client can accept, on the project''s calendar. Signing links never outlive it.',
  'terms', 'Notes and terms printed on the quote, 1 to 4000 characters.',
  'quote_version_state', 'Draft, Sent, Accepted, Declined, Withdrawn or Superseded. Changes only through the quote RPCs and the client''s signature.',
  'budget_version_id', 'Quote budget version captured at send; the client lines and total are read from it. NULL while Draft.',
  'content_sha256', 'Lowercase hex SHA-256 of the canonical client-facing content at send (ADR 0152), printed on the PDF as its fingerprint. NULL while Draft.',
  'engagement_document_id', 'Quote engagement document the client signs. NULL while Draft.',
  'sent_at', 'When the version was sent; the quote PDF''s issue time.',
  'sent_by', 'Person who sent it; they are told when it is accepted.',
  'accepted_at', 'When the client''s signature accepted it; set exactly when Accepted.',
  'accepted_by', 'Person who signed while signed in to Gateway; NULL when signed through a link.',
  'accepted_name', 'Name of the signer, frozen at signature: the name typed on the signing link, or the signed-in person''s name.',
  'sent_title', 'Quote title frozen at send: what the fingerprint hashes and the client signs. app.quotes.title applies to the next Draft. NULL exactly while Draft.',
  'sent_client_name', 'Client party name frozen at send, so a later rename never changes what was signed. NULL exactly while Draft.'
]);

call private.install_lifecycle('app.quote_versions', 'quote_version_id', 'quote_version_state', 'quote_version', 'Draft',
  $$quote_version_id in (select v.id from app.quote_versions v join app.quotes q on q.id = v.quote_id
    join app.budgets b on b.id = q.budget_id where b.project_id in (select private.project_ids_with('finance.budget.read')))$$);
call private.install_default_retention('app.quote_version_state_transitions');

create or replace function private.guard_quote_version()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if not private.in_trusted_operation('quote_write') then
      perform private.refuse('quote_rpc_only', 'Quote versions are created with New quote and New version.');
    end if;
    new.version_number := coalesce((select max(v.version_number) from app.quote_versions v where v.quote_id = new.quote_id), 0) + 1;
    return new;
  end if;
  if new.quote_id <> old.quote_id or new.version_number <> old.version_number then
    perform private.refuse('quote_rpc_only', 'A quote version keeps its quote and number.');
  end if;
  -- A soft-deleted Draft of an accepted quote stays deleted, and nothing else moves after acceptance.
  if not private.in_trusted_operation('quote_acceptance')
     and exists (select 1 from app.quote_versions v where v.quote_id = new.quote_id and v.quote_version_state = 'Accepted') then
    perform private.refuse('quote_accepted_locked', 'This quote was accepted, so it can''t change. Record changes as a change order.');
  end if;
  if (new.valid_until <> old.valid_until or new.terms is distinct from old.terms) and old.quote_version_state <> 'Draft' then
    perform private.refuse(case when old.quote_version_state = 'Accepted' then 'quote_accepted_locked' else 'quote_not_draft' end,
      'Only a Draft version is edited; start a new version to change a sent quote.');
  end if;
  if (new.budget_version_id is distinct from old.budget_version_id or new.content_sha256 is distinct from old.content_sha256
      or new.engagement_document_id is distinct from old.engagement_document_id or new.sent_at is distinct from old.sent_at
      or new.sent_by is distinct from old.sent_by or new.sent_title is distinct from old.sent_title
      or new.sent_client_name is distinct from old.sent_client_name) and not private.in_trusted_operation('quote_send') then
    perform private.refuse('quote_rpc_only', 'A version is frozen by Send quote.');
  end if;
  if (new.accepted_at is distinct from old.accepted_at or new.accepted_by is distinct from old.accepted_by
      or new.accepted_name is distinct from old.accepted_name) and not private.in_trusted_operation('quote_acceptance') then
    perform private.refuse('quote_rpc_only', 'A version is accepted by the client''s signature.');
  end if;
  if new.deleted_at is distinct from old.deleted_at and old.quote_version_state <> 'Draft' then
    perform private.refuse(case when old.quote_version_state = 'Accepted' then 'quote_accepted_locked' else 'quote_not_draft' end,
      'Only a Draft version is deleted; a sent version is kept.');
  end if;
  return new;
end;
$$;
comment on function private.guard_quote_version() is 'Quote versions: created only inside the quote RPCs and numbered per quote; once any version of the quote is Accepted nothing changes outside quote_acceptance (quote_accepted_locked); valid_until, terms and deleted_at change only while Draft (quote_not_draft); the frozen columns, sent_title and sent_client_name included, change only inside quote_send, the acceptance columns only inside quote_acceptance (quote_rpc_only).';
revoke all on function private.guard_quote_version() from public, anon, authenticated;
create trigger t40_guard_quote_version before insert or update on app.quote_versions
  for each row execute function private.guard_quote_version();

-- A live quote always has a live version: deleting the only Draft of a quote that was never sent deletes the quote, and
-- restoring that quote from Trash brings its latest deleted Draft back.
create or replace function private.cascade_quote_draft_delete()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_table_name = 'quote_versions' then
    if new.deleted_at is not null and old.deleted_at is null
       and not exists (select 1 from app.quote_versions v where v.quote_id = new.quote_id and v.deleted_at is null) then
      update app.quotes q set deleted_at = new.deleted_at where q.id = new.quote_id and q.deleted_at is null;
    end if;
  elsif new.deleted_at is null and old.deleted_at is not null
        and not exists (select 1 from app.quote_versions v where v.quote_id = new.id and v.deleted_at is null) then
    update app.quote_versions v set deleted_at = null
    where v.id = (select x.id from app.quote_versions x where x.quote_id = new.id and x.quote_version_state = 'Draft'
                  order by x.deleted_at desc nulls last, x.version_number desc limit 1);
  end if;
  return null;
end;
$$;
comment on function private.cascade_quote_draft_delete() is 'Keeps a live quote with a live version: deleting the last live version (a Draft of a quote never sent) soft-deletes the quote, and restoring a quote with no live version restores its latest deleted Draft.';
revoke all on function private.cascade_quote_draft_delete() from public, anon, authenticated;
create trigger t61_cascade_quote_draft_delete after update of deleted_at on app.quote_versions
  for each row execute function private.cascade_quote_draft_delete();
create trigger t61_restore_quote_draft after update of deleted_at on app.quotes
  for each row execute function private.cascade_quote_draft_delete();

call private.install_policies('app.quote_versions',
  $$quote_id in (select q.id from app.quotes q join app.budgets b on b.id = q.budget_id
    where b.project_id in (select private.project_ids_with('finance.budget.read')))$$,
  $$quote_id in (select q.id from app.quotes q join app.budgets b on b.id = q.budget_id
    where b.project_id in (select private.project_ids_with('finance.budget.write')))$$);
drop policy quote_versions_insert on app.quote_versions;
revoke insert, update on app.quote_versions from authenticated;
grant update (valid_until, terms, deleted_at) on app.quote_versions to authenticated;
call private.install_default_retention('app.quote_versions');
call private.install_audit_trail('app.quote_versions');

create or replace function private.emit_quote_version_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_project uuid;
begin
  select b.project_id into v_project from app.quote_versions v join app.quotes q on q.id = v.quote_id
  join app.budgets b on b.id = q.budget_id where v.id = new.quote_version_id;
  perform private.emit_event(new.org_id, 'quote.' || lower(new.to_state::text), 'quote_versions', new.quote_version_id,
    v_project, jsonb_build_object('from_state', new.from_state, 'to_state', new.to_state));
  return null;
end;
$$;
comment on function private.emit_quote_version_event() is 'Emits quote.sent, quote.accepted, quote.declined or quote.withdrawn for a quote version''s state change, with the project of its budget.';
revoke all on function private.emit_quote_version_event() from public, anon, authenticated;
create trigger t90_emit_quote_version_event after insert on app.quote_version_state_transitions
  for each row when (new.to_state in ('Sent', 'Accepted', 'Declined', 'Withdrawn'))
  execute function private.emit_quote_version_event();

-- 4. Quote engagement documents are locked to the quote --------------------------------------------------------------

create or replace function private.guard_quote_document()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_in_quote boolean := private.in_trusted_operation('quote_send') or private.in_trusted_operation('quote_withdraw')
    or private.in_trusted_operation('quote_decline');
begin
  if tg_op = 'INSERT' then
    if new.document_kind = 'Quote' and not private.in_trusted_operation('quote_send') then
      perform private.refuse('quote_document_locked', 'A Quote document follows its quote; change the quote instead.');
    end if;
    return new;
  end if;
  -- A change of kind never reaches here: t40 private.guard_engagement_document (0700) refuses it first.
  if old.document_kind <> 'Quote' then
    return new;
  end if;
  if (new.title <> old.title or new.expires_on is distinct from old.expires_on or new.document_id is distinct from old.document_id
      or new.deleted_at is distinct from old.deleted_at) and not private.in_trusted_operation('quote_send') then
    perform private.refuse('quote_document_locked', 'A Quote document follows its quote; change the quote instead.');
  end if;
  if new.engagement_document_state <> old.engagement_document_state
     and not (old.engagement_document_state = 'Sent' and new.engagement_document_state = 'Signed')
     and not (old.engagement_document_state = 'Signed' and new.engagement_document_state = 'Executed'
              and private.in_trusted_operation('quote_acceptance'))
     and not v_in_quote then
    perform private.refuse('quote_document_locked', 'A Quote document follows its quote; change the quote instead.');
  end if;
  return new;
end;
$$;
comment on function private.guard_quote_document() is 'Engagement documents of kind Quote (3022): inserted only inside quote_send. A Quote document''s title, expiry, file and deletion change only inside quote_send, and its state only by the client''s Sent to Signed (either signing path), Signed to Executed inside quote_acceptance (no countersignature), or inside quote_send, quote_withdraw or quote_decline. Anything else refuses quote_document_locked. A change of kind is refused earlier by t40 (engagement_document_immutable).';
revoke all on function private.guard_quote_document() from public, anon, authenticated;
create trigger t45_guard_quote_document before insert or update on app.engagement_documents
  for each row execute function private.guard_quote_document();

-- 5. Helpers -----------------------------------------------------------------------------------------------------------

create or replace function private.quote_key(p_quote_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select p.project_key || '-Q-' || q.quote_number::text
  from app.quotes q join app.budgets b on b.id = q.budget_id join app.projects p on p.id = b.project_id
  where q.id = p_quote_id;
$$;
comment on function private.quote_key(uuid) is 'Display key of a quote: the project key, -Q- and the quote number, as change orders are keyed -CO- (0770).';
revoke all on function private.quote_key(uuid) from public, anon;
grant execute on function private.quote_key(uuid) to authenticated, service_role;

create or replace function private.quote_party_name(p_engagement_id uuid, p_project_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select coalesce(pe.full_name, o.name) from app.engagements e
     left join app.people pe on pe.id = e.person_id
     left join app.counterparties c on c.id = e.counterparty_id
     left join app.organizations o on o.id = c.organization_id
     where e.id = p_engagement_id),
    (select o.name from app.projects p join app.counterparties c on c.id = p.client_counterparty_id
     join app.organizations o on o.id = c.organization_id where p.id = p_project_id));
$$;
comment on function private.quote_party_name(uuid, uuid) is 'Who a quote is for: the client engagement''s person or counterparty, else the project''s client counterparty (0301). Internal: the send fingerprint, the external views and the token reader call it.';
revoke all on function private.quote_party_name(uuid, uuid) from public, anon, authenticated;

create or replace function private.quote_client_name(p_engagement_id uuid, p_project_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select private.quote_party_name(p_engagement_id, p_project_id)
  where p_project_id in (select private.project_ids_with('finance.budget.read'));
$$;
comment on function private.quote_client_name(uuid, uuid) is 'Who a quote is for (private.quote_party_name), for a reader who holds finance.budget.read on the project; NULL for anyone else. app.quote_statuses calls it.';
revoke all on function private.quote_client_name(uuid, uuid) from public, anon;
grant execute on function private.quote_client_name(uuid, uuid) to authenticated, service_role;

create or replace function private.quote_version_project(p_quote_version_id uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select b.project_id from app.quote_versions v join app.quotes q on q.id = v.quote_id
  join app.budgets b on b.id = q.budget_id where v.id = p_quote_version_id;
$$;
comment on function private.quote_version_project(uuid) is 'Project of a quote version, through its quote''s budget.';
revoke all on function private.quote_version_project(uuid) from public, anon, authenticated;

-- The canonical client-facing content of a captured version (ADR 0152 publishes the form): the jsonb text of the quote
-- key, version number, title, client name, currency, valid until, terms, the included lines ordered by line number and
-- the total. jsonb output orders keys deterministically, so the same content always gives the same text. Title and client
-- read the values frozen at send, so a later retitle or rename never changes the recomputed text.
create or replace function private.quote_canonical_content(p_quote_version_id uuid, p_budget_version_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'quote', private.quote_key(q.id),
    'version_number', v.version_number,
    'title', coalesce(v.sent_title, q.title),
    'client', coalesce(v.sent_client_name, private.quote_party_name(q.engagement_id, b.project_id)),
    'currency', bv.currency_code,
    'valid_until', v.valid_until,
    'terms', v.terms,
    'lines', coalesce((
      select jsonb_agg(jsonb_build_object(
        'line_number', l.line_number,
        'description', l.description,
        'quantity', l.quantity,
        'unit_basis', l.unit_basis,
        'client_unit_price_minor', l.client_unit_price_minor,
        'client_extended_minor', private.extended_minor(l.quantity, l.client_unit_price_minor)) order by l.line_number)
      from app.budget_version_lines l where l.budget_version_id = bv.id and not l.excluded_from_quote), '[]'::jsonb),
    'total_minor', (select sum(private.extended_minor(l.quantity, l.client_unit_price_minor))
                    from app.budget_version_lines l where l.budget_version_id = bv.id and not l.excluded_from_quote)
  )::text
  from app.quote_versions v
  join app.quotes q on q.id = v.quote_id
  join app.budgets b on b.id = q.budget_id
  join app.budget_versions bv on bv.id = p_budget_version_id
  where v.id = p_quote_version_id;
$$;
comment on function private.quote_canonical_content(uuid, uuid) is 'Canonical text of a quote version''s client-facing content over a captured budget version (ADR 0152): the jsonb text of quote key, version number, title, client name, currency, valid until, terms, the lines on the quote (line number, description, quantity, unit, client unit price, client amount) ordered by line number, and the total. Its SHA-256 is the version''s content_sha256.';
revoke all on function private.quote_canonical_content(uuid, uuid) from public, anon, authenticated;

-- Revokes every live signing link of an engagement document, as issuing a new link does (0769).
create or replace function private.revoke_document_tokens(p_engagement_document_id uuid)
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  update app.engagement_document_tokens t set revoked_at = now()
  where t.engagement_document_id = p_engagement_document_id and t.revoked_at is null and t.deleted_at is null;
$$;
comment on function private.revoke_document_tokens(uuid) is 'Revokes the live signing links of an engagement document, as app.issue_engagement_document_token revokes earlier links (0769).';
revoke all on function private.revoke_document_tokens(uuid) from public, anon, authenticated;

-- 6. Create ------------------------------------------------------------------------------------------------------------

create or replace function app.create_quote(
  p_budget_id uuid,
  p_title text,
  p_engagement_id uuid default null,
  p_valid_until date default null,
  p_terms text default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_project uuid := (select b.project_id from app.budgets b where b.id = p_budget_id and b.deleted_at is null);
  v_id uuid;
begin
  perform private.require_person();
  if v_project is null or not private.can_on_project(v_project, 'finance.budget.write') then
    raise exception using errcode = '42501', message = 'finance.budget.write is required on the budget''s project';
  end if;
  insert into app.quotes (budget_id, engagement_id, title, quote_number)
  values (p_budget_id, p_engagement_id, btrim(coalesce(p_title, '')), 0)
  returning id into v_id;
  perform private.begin_trusted_operation('quote_write');
  insert into app.quote_versions (quote_id, version_number, valid_until, terms)
  values (v_id, 1, coalesce(p_valid_until, private.project_today(v_project) + 30), nullif(btrim(coalesce(p_terms, '')), ''));
  perform private.end_trusted_operation('quote_write');
  return v_id;
end;
$$;
comment on function app.create_quote(uuid, text, uuid, date, text) is 'New quote (G-188 phase 1): a quote of a live budget, optionally for a Client engagement of its project, with version 1 as a Draft valid until the given day or 30 days from today on the project''s calendar. Needs finance.budget.write on the budget''s project. Returns the quote id.';
revoke all on function app.create_quote(uuid, text, uuid, date, text) from public, anon;
grant execute on function app.create_quote(uuid, text, uuid, date, text) to authenticated, service_role;

create or replace function app.create_quote_version(p_quote_id uuid)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_quote app.quotes;
  v_project uuid;
  v_latest app.quote_versions;
  v_today date;
  v_id uuid;
begin
  perform private.require_person();
  select * into v_quote from app.quotes q where q.id = p_quote_id and q.deleted_at is null for update;
  select b.project_id into v_project from app.budgets b where b.id = v_quote.budget_id;
  if v_quote.id is null or not private.can_on_project(v_project, 'finance.budget.write') then
    raise exception using errcode = '42501', message = 'finance.budget.write is required on the quote''s project';
  end if;
  if exists (select 1 from app.quote_versions v where v.quote_id = p_quote_id and v.quote_version_state = 'Accepted') then
    perform private.refuse('quote_accepted_locked', 'This quote was accepted, so it can''t change. Record changes as a change order.');
  end if;
  if exists (select 1 from app.quote_versions v where v.quote_id = p_quote_id and v.quote_version_state = 'Draft' and v.deleted_at is null) then
    perform private.refuse('quote_draft_exists', 'This quote already has a draft version; edit that one.');
  end if;
  select * into v_latest from app.quote_versions v where v.quote_id = p_quote_id order by v.version_number desc limit 1;
  v_today := private.project_today(v_project);
  perform private.begin_trusted_operation('quote_write');
  insert into app.quote_versions (quote_id, version_number, valid_until, terms)
  values (p_quote_id, 1,
    case when v_latest.valid_until is null or v_latest.valid_until < v_today then v_today + 30 else v_latest.valid_until end,
    v_latest.terms)
  returning id into v_id;
  perform private.end_trusted_operation('quote_write');
  return v_id;
end;
$$;
comment on function app.create_quote_version(uuid) is 'New version: a Draft copying the latest version''s valid until (moved to 30 days from today when already past) and terms, priced from the live budget. Needs finance.budget.write; refuses quote_draft_exists while a Draft is live and quote_accepted_locked once a version is accepted. Returns the version id.';
revoke all on function app.create_quote_version(uuid) from public, anon;
grant execute on function app.create_quote_version(uuid) to authenticated, service_role;

-- 7. Send --------------------------------------------------------------------------------------------------------------

create or replace function app.send_quote_version(p_quote_version_id uuid, p_reason text)
returns table (engagement_document_id uuid, content_sha256 text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_version app.quote_versions;
  v_quote app.quotes;
  v_project uuid;
  v_engagement app.engagements;
  v_key text;
  v_capture uuid;
  v_hash text;
  v_document uuid;
  v_client text;
  v_earlier record;
  v_reason text := coalesce(nullif(btrim(coalesce(p_reason, '')), ''), 'Sent to the client.');
begin
  perform private.require_person();
  select q.* into v_quote from app.quotes q
  where q.id = (select v.quote_id from app.quote_versions v where v.id = p_quote_version_id) and q.deleted_at is null
  for update;
  select b.project_id into v_project from app.budgets b where b.id = v_quote.budget_id;
  if v_quote.id is null or not private.can_on_project(v_project, 'finance.budget.approve') then
    raise exception using errcode = '42501', message = 'finance.budget.approve is required on the quote''s project';
  end if;
  select v.* into v_version from app.quote_versions v where v.id = p_quote_version_id;
  if exists (select 1 from app.quote_versions v where v.quote_id = v_quote.id and v.quote_version_state = 'Accepted') then
    perform private.refuse('quote_accepted_locked', 'This quote was accepted, so it can''t change. Record changes as a change order.');
  end if;
  if v_version.quote_version_state <> 'Draft' or v_version.deleted_at is not null then
    perform private.refuse('quote_not_draft', 'Only a Draft version is sent.');
  end if;
  select e.* into v_engagement from app.engagements e where e.id = v_quote.engagement_id and e.deleted_at is null;
  v_client := private.quote_party_name(v_engagement.id, v_project);
  if v_engagement.id is null or v_engagement.role_type <> 'Client' or v_engagement.engagement_state in ('Canceled', 'Complete')
     or v_client is null then
    perform private.refuse('quote_client_engagement', 'Choose an open Client engagement of the project to send the quote to.');
  end if;
  if v_version.valid_until < private.project_today(v_project) then
    perform private.refuse('quote_valid_until', 'Valid until is in the past; choose a later day.');
  end if;
  if not exists (select 1 from app.budget_line_prices p where p.budget_id = v_quote.budget_id and not p.excluded_from_quote) then
    perform private.refuse('quote_no_lines', 'The budget has no line on the quote.');
  end if;
  if exists (select 1 from app.budget_line_prices p
             where p.budget_id = v_quote.budget_id and not p.excluded_from_quote and p.client_unit_price_minor is null) then
    perform private.refuse('quote_unpriced_lines', 'Every line on the quote needs a client price: set a markup or a client unit price.');
  end if;

  v_key := private.quote_key(v_quote.id);
  v_capture := private.capture_budget_version(v_quote.budget_id, format('Quote %s v%s', v_key, v_version.version_number), 'Quote');
  v_hash := encode(extensions.digest(private.quote_canonical_content(v_version.id, v_capture), 'sha256'), 'hex');

  perform private.begin_trusted_operation('quote_send');
  -- No expires_on: valid_until is the only expiry, and 1463 would remind the client about a signed quote.
  insert into app.engagement_documents (engagement_id, document_kind, title)
  values (v_engagement.id, 'Quote', format('Quote %s v%s', v_key, v_version.version_number))
  returning id into v_document;
  perform private.transition_lifecycle('engagement_document', 'app.engagement_documents', 'engagement_document_state',
    'app.engagement_document_state_transitions', 'engagement_document_id', v_document, 'Proposed', 'Sent', v_reason);

  -- Earlier sent versions are superseded, their documents canceled and their signing links revoked.
  for v_earlier in
    select v.id, v.engagement_document_id from app.quote_versions v
    where v.quote_id = v_quote.id and v.quote_version_state = 'Sent' and v.id <> v_version.id
  loop
    perform private.transition_lifecycle('quote_version', 'app.quote_versions', 'quote_version_state',
      'app.quote_version_state_transitions', 'quote_version_id', v_earlier.id, 'Sent', 'Superseded',
      format('Superseded by version %s.', v_version.version_number));
    if exists (select 1 from app.engagement_documents d where d.id = v_earlier.engagement_document_id
               and d.engagement_document_state = 'Sent') then
      perform private.transition_lifecycle('engagement_document', 'app.engagement_documents', 'engagement_document_state',
        'app.engagement_document_state_transitions', 'engagement_document_id', v_earlier.engagement_document_id, 'Sent', 'Canceled',
        format('Superseded by version %s.', v_version.version_number));
    end if;
    perform private.revoke_document_tokens(v_earlier.engagement_document_id);
  end loop;

  -- Draft to Sent and the frozen columns in one statement: the frozen check pairs them with the state.
  perform private.begin_trusted_operation('quote_version_transition');
  update app.quote_versions v set quote_version_state = 'Sent', budget_version_id = v_capture, content_sha256 = v_hash,
    engagement_document_id = v_document, sent_at = now(), sent_by = private.current_person_id(),
    sent_title = v_quote.title, sent_client_name = v_client
  where v.id = v_version.id and v.quote_version_state = 'Draft';
  perform private.end_trusted_operation('quote_version_transition');
  insert into app.quote_version_state_transitions (quote_version_id, from_state, to_state, reason)
  values (v_version.id, 'Draft', 'Sent', v_reason);
  perform private.end_trusted_operation('quote_send');

  return query select v_document, v_hash;
end;
$$;
comment on function app.send_quote_version(uuid, text) is 'Send quote (S14.5-01, ADR 0152): in one transaction captures a Quote budget version, fixes the SHA-256 of the canonical client-facing content, creates the Quote engagement document (Sent, with no expires_on: valid_until is the only expiry), freezes the title and client name, supersedes earlier sent versions (their documents canceled and links revoked) and moves the Draft to Sent. Needs finance.budget.approve. Refuses quote_accepted_locked, quote_not_draft, quote_client_engagement (no open Client engagement), quote_valid_until (in the past), quote_no_lines and quote_unpriced_lines. The signing link is issued afterwards with app.issue_engagement_document_token. Returns the document id and the fingerprint.';
revoke all on function app.send_quote_version(uuid, text) from public, anon;
grant execute on function app.send_quote_version(uuid, text) to authenticated, service_role;

-- 8. Withdraw and decline -----------------------------------------------------------------------------------------------

create or replace function private.close_quote_version(p_quote_version_id uuid, p_next app.quote_version_state, p_reason text, p_operation text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_version app.quote_versions;
  v_quote app.quotes;
  v_project uuid;
  v_reason text := btrim(coalesce(p_reason, ''));
begin
  perform private.require_person();
  select q.* into v_quote from app.quotes q
  where q.id = (select v.quote_id from app.quote_versions v where v.id = p_quote_version_id) and q.deleted_at is null
  for update;
  select b.project_id into v_project from app.budgets b where b.id = v_quote.budget_id;
  if v_quote.id is null or not private.can_on_project(v_project, 'finance.budget.approve') then
    raise exception using errcode = '42501', message = 'finance.budget.approve is required on the quote''s project';
  end if;
  select v.* into v_version from app.quote_versions v where v.id = p_quote_version_id;
  if v_version.quote_version_state = 'Accepted' then
    perform private.refuse('quote_accepted_locked', 'This quote was accepted, so it can''t change. Record changes as a change order.');
  end if;
  if v_version.quote_version_state <> 'Sent' then
    perform private.refuse('quote_not_sent', 'Only a sent version is withdrawn or marked declined.');
  end if;
  if char_length(v_reason) = 0 then
    v_reason := case p_next when 'Withdrawn' then 'Withdrawn by the organization.' else 'Declined by the client.' end;
  end if;
  perform private.begin_trusted_operation(p_operation);
  perform private.transition_lifecycle('quote_version', 'app.quote_versions', 'quote_version_state',
    'app.quote_version_state_transitions', 'quote_version_id', v_version.id, 'Sent', p_next::text, v_reason);
  if exists (select 1 from app.engagement_documents d where d.id = v_version.engagement_document_id
             and d.engagement_document_state = 'Sent') then
    perform private.transition_lifecycle('engagement_document', 'app.engagement_documents', 'engagement_document_state',
      'app.engagement_document_state_transitions', 'engagement_document_id', v_version.engagement_document_id, 'Sent', 'Canceled',
      v_reason);
  end if;
  perform private.revoke_document_tokens(v_version.engagement_document_id);
  perform private.end_trusted_operation(p_operation);
end;
$$;
comment on function private.close_quote_version(uuid, app.quote_version_state, text, text) is 'Withdraw or Mark declined: moves a Sent version to Withdrawn or Declined inside the named operation, cancels its Quote document and revokes its signing links. Needs finance.budget.approve; refuses quote_accepted_locked and quote_not_sent.';
revoke all on function private.close_quote_version(uuid, app.quote_version_state, text, text) from public, anon, authenticated;

create or replace function app.withdraw_quote_version(p_quote_version_id uuid, p_reason text)
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  select private.close_quote_version(p_quote_version_id, 'Withdrawn', p_reason, 'quote_withdraw');
$$;
comment on function app.withdraw_quote_version(uuid, text) is 'Withdraw: the org takes back a Sent quote version (Sent to Withdrawn); its Quote document is canceled and its signing links revoked. Needs finance.budget.approve.';
revoke all on function app.withdraw_quote_version(uuid, text) from public, anon;
grant execute on function app.withdraw_quote_version(uuid, text) to authenticated, service_role;

create or replace function app.decline_quote_version(p_quote_version_id uuid, p_reason text)
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  select private.close_quote_version(p_quote_version_id, 'Declined', p_reason, 'quote_decline');
$$;
comment on function app.decline_quote_version(uuid, text) is 'Mark declined: records that the client declined a Sent quote version (Sent to Declined); its Quote document is canceled and its signing links revoked. Needs finance.budget.approve.';
revoke all on function app.decline_quote_version(uuid, text) from public, anon;
grant execute on function app.decline_quote_version(uuid, text) to authenticated, service_role;

-- 9. Status ------------------------------------------------------------------------------------------------------------

create view app.quote_statuses with (security_invoker = true) as
select q.id as quote_id, q.org_id, b.project_id, q.budget_id, q.engagement_id,
  p.project_key || '-Q-' || q.quote_number::text as quote_key, coalesce(cur.sent_title, q.title) as title,
  coalesce(cur.sent_client_name, private.quote_client_name(q.engagement_id, b.project_id)) as client_name,
  cur.id as current_version_id, cur.version_number as current_version_number,
  case when cur.quote_version_state = 'Sent' and cur.valid_until < private.project_today(b.project_id) then 'Expired'
       else cur.quote_version_state::text end as display_state,
  cur.valid_until, cur.sent_at, cur.accepted_at,
  case when cur.quote_version_state = 'Draft' then b.currency_code else bv.currency_code end as currency_code,
  case when cur.quote_version_state = 'Draft' then pt.client_total_minor else vt.client_total_minor end as client_total_minor,
  case when cur.quote_version_state = 'Draft' then pt.margin_minor else vt.margin_minor end as margin_minor,
  exists (select 1 from app.quote_versions d where d.quote_id = q.id and d.quote_version_state = 'Draft' and d.deleted_at is null)
    as has_draft
from app.quotes q
join app.budgets b on b.id = q.budget_id
join app.projects p on p.id = b.project_id
cross join lateral (
  select v.* from app.quote_versions v
  where v.quote_id = q.id and v.deleted_at is null
  order by (v.quote_version_state = 'Draft'), v.version_number desc
  limit 1
) cur
left join app.budget_versions bv on bv.id = cur.budget_version_id
left join app.budget_version_totals vt on vt.budget_version_id = cur.budget_version_id
left join app.budget_price_totals pt on pt.budget_id = q.budget_id
where q.deleted_at is null;

call private.describe('app.quote_statuses', 'One row per live quote with its display state and totals (ADR 0152): the current version is the latest one that was sent, else the Draft. Expired is computed for a Sent version whose valid until has passed on the project''s calendar. A Draft''s totals come from the live budget (app.budget_price_totals), a sent version''s from its frozen capture.', array[
  'quote_id', 'Quote.',
  'org_id', 'Org of the quote.',
  'project_id', 'Project of the quote''s budget.',
  'budget_id', 'Budget the quote prices from.',
  'engagement_id', 'Client engagement the quote is for.',
  'quote_key', 'Display key, <project key>-Q-<number>.',
  'title', 'Title of the current version: frozen once sent, else the quote''s.',
  'client_name', 'Who the current version is for: frozen once sent, else the engagement''s person or counterparty, else the project''s client.',
  'current_version_id', 'The latest sent version, else the Draft.',
  'current_version_number', 'Its number.',
  'display_state', 'Draft, Sent, Expired, Accepted, Declined, Withdrawn or Superseded.',
  'valid_until', 'Valid until of the current version.',
  'sent_at', 'When the current version was sent.',
  'accepted_at', 'When the current version was accepted.',
  'currency_code', 'Currency: the budget''s for a Draft, the frozen capture''s once sent.',
  'client_total_minor', 'Client total of the current version; NULL while any line on the quote is unpriced.',
  'margin_minor', 'Client total less cost of the lines on the quote; NULL whenever either is unknown.',
  'has_draft', 'True while the quote has a live Draft version.'
]);

revoke all on app.quote_statuses from public, anon;
grant select on app.quote_statuses to authenticated, service_role;
do $$
begin
  if exists (select 1 from pg_catalog.pg_roles r where r.rolname = 'xos_backup') then
    revoke select on app.quote_statuses from xos_backup;
  end if;
end;
$$;

-- 10. A budget under a sent quote stays ---------------------------------------------------------------------------------

create or replace function private.guard_budget_sent_quote()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.deleted_at is not null and old.deleted_at is null
     and exists (select 1 from app.quotes q join app.quote_versions v on v.quote_id = q.id
                 where q.budget_id = new.id and v.quote_version_state <> 'Draft') then
    perform private.refuse('budget_has_sent_quote', 'A quote was sent from this budget, so the budget is kept.');
  end if;
  return new;
end;
$$;
comment on function private.guard_budget_sent_quote() is 'Budgets: a budget with a quote version past Draft is never soft-deleted (budget_has_sent_quote); the capture it sent is the record of what the client saw.';
revoke all on function private.guard_budget_sent_quote() from public, anon, authenticated;
create trigger t41_guard_budget_sent_quote before update of deleted_at on app.budgets
  for each row execute function private.guard_budget_sent_quote();

-- 11. Live list ----------------------------------------------------------------------------------------------------------

-- /finance/quotes shows an acceptance without a reload (S11.7-10). Realtime checks each change against the subscriber's
-- read policy, as 2170 and 2811.
do $$
declare
  v_table record;
begin
  if not exists (select 1 from pg_catalog.pg_publication where pubname = 'supabase_realtime') then
    return;
  end if;
  for v_table in
    select t.table_name from (values ('quotes'), ('quote_versions')) as t (table_name)
  loop
    if not exists (
      select 1 from pg_catalog.pg_publication_tables p
      where p.pubname = 'supabase_realtime' and p.schemaname = 'app' and p.tablename = v_table.table_name
    ) then
      execute format('alter publication supabase_realtime add table app.%I', v_table.table_name);
    end if;
  end loop;
end;
$$;

select private.sync_trash_tables();

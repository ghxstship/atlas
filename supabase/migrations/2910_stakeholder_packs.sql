-- 2910_stakeholder_packs.sql
-- B2 (RRR-226, ADR 0141; parity gap G-29). A stakeholder pack bundles a project's P1 live links (2780) and its Public
-- or Internal files for people outside the org: a venue, a client's department, each supplier. Before this migration
-- an outsider received one live link or one file share link (1380) at a time, with nothing that said who opened what.
--   * app.stakeholder_packs: one pack per project audience, with a message shown to recipients, an internal note that
--     never reaches a token page, and an expiry within 90 days (Section 7.5 invariant 8, ADR 0033 decision 56).
--   * app.stakeholder_pack_items: up to 30 items, each a live link of the same project (private.manageable_live_link,
--     P1) or a file of the same project that scanned clean and is Public or Internal. Confidential and Restricted
--     files never leave by link (Section 8.6). A file item is inserted by the caller under row level security, as
--     1380 inserts share links, so the attachment's own read policy decides; a guard checks the rest and logs Share
--     Link Created in app.file_access_log.
--   * app.stakeholder_pack_recipients: up to 200 named people per pack, each with a 6-digit access code given out of
--     band. The code is returned once and stored as a salted SHA-256 hash; signed-in callers can select neither.
--   * app.stakeholder_pack_events: what each recipient did (Sent, Opened, Viewed, Downloaded, Signed, Unsubscribed),
--     append-only. app.stakeholder_pack_recipient_activity counts it per recipient; nothing stores the counts.
--   * private.stakeholder_pack_links hold the hashes of the emailed sign-in links (2913) and private.stakeholder_pack_grants
--     the device grants a correct code earns (2912).
--   * Only members of the project's org who hold projects.settings.write on it make or change packs, so a partner org
--     that reaches the project through app.project_shares never publishes the owner org's data. A read-only org makes
--     nothing new, but packs and recipients can still be revoked and recipients can still read and unsubscribe.
--   * Packs stay out of Trash (ADR 0110): a revoked pack is replaced, never restored. One year after a pack ended, the
--     daily job of 2913 soft-deletes it with its items, recipients, schedule and deliveries, and the one-year retention
--     here purges them, so a non-user's name and email go two years after the pack ended. Events age out at two years.
--   * The private tables carry org_id, so deleting the org (1351) takes them with it.

create type app.pack_item_kind as enum ('Live Link', 'File');
comment on type app.pack_item_kind is 'What a stakeholder pack item is (ADR 0141): Live Link, one P1 live link of the project; File, one Public or Internal file of the project.';

create type app.pack_event_action as enum ('Sent', 'Opened', 'Viewed', 'Downloaded', 'Signed', 'Unsubscribed');
comment on type app.pack_event_action is 'What happened in a stakeholder pack (ADR 0141): a sign-in link was sent, the recipient opened the pack, viewed a live item, downloaded a file, acknowledged an item with their typed name, or stopped the emails.';

insert into private.domain_event_types (code, subject, description) values
  ('stakeholder_pack.created', 'stakeholder_packs', 'A stakeholder pack was made for people outside the org.'),
  ('stakeholder_pack.revoked', 'stakeholder_packs', 'A stakeholder pack was revoked; none of its links opens again.'),
  ('stakeholder_pack_recipient.added', 'stakeholder_pack_recipients', 'A recipient was added to a stakeholder pack.'),
  ('stakeholder_pack_recipient.revoked', 'stakeholder_pack_recipients', 'A recipient of a stakeholder pack was revoked.'),
  ('stakeholder_pack.signed', 'stakeholder_packs', 'A recipient acknowledged a stakeholder pack item with their typed name.')
on conflict (code) do nothing;

-- Revoking withdraws access and an outsider's events and unsubscribe keep working, so these stay writable while a
-- canceled org is read-only (Section 14.7). The rows go in before install_domain_table, whose read-only guard
-- installer skips an exempt table (1063); the RPCs refuse new packs, items, recipients and codes themselves.
insert into private.read_only_exempt_tables (table_name, rationale) values
  ('app.stakeholder_packs', 'Revoking a stakeholder pack withdraws access; new packs are refused by the pack RPCs.'),
  ('app.stakeholder_pack_recipients', 'Revoking a recipient withdraws access and unsubscribing stops email; new recipients and codes are refused by the pack RPCs.'),
  ('app.stakeholder_pack_events', 'Recipients keep opening and reading a pack in a read-only org, and each read is logged.')
on conflict (table_name) do nothing;

-- Packs ----------------------------------------------------------------------------------------------------------------

create table app.stakeholder_packs (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  project_id uuid not null references app.projects (id),
  name text not null,
  message text,
  note text,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  revoked_by uuid references app.people (id),
  constraint stakeholder_packs_name_length check (char_length(btrim(name)) between 1 and 120),
  constraint stakeholder_packs_message_length check (message is null or char_length(btrim(message)) between 1 and 2000),
  constraint stakeholder_packs_note_length check (note is null or char_length(btrim(note)) between 1 and 200),
  constraint stakeholder_packs_revoked check ((revoked_at is null) = (revoked_by is null))
);

create index stakeholder_packs_project_idx on app.stakeholder_packs (project_id);
create index stakeholder_packs_revoked_by_idx on app.stakeholder_packs (revoked_by);

call private.install_domain_table('app.stakeholder_packs', 'app.projects', 'project_id');
call private.describe('app.stakeholder_packs', 'Stakeholder packs (ADR 0141): a named bundle of a project''s live links and Public or Internal files for people outside the org, each recipient with an access code given out of band. Made and changed only through the pack RPCs (app.create_stakeholder_pack and the rest); read without an account through api_public.open_stakeholder_pack and api_public.stakeholder_pack.', array[
  'project_id', 'Project the pack shares from; every item belongs to it.',
  'name', 'Pack name shown to recipients, 1 to 120 characters.',
  'message', 'Message shown to recipients at the top of the pack, up to 2000 characters.',
  'note', 'What the pack is for, for the team. Never shown on a token page or in an email.',
  'expires_at', 'When the pack stops opening: after now and at most 90 days ahead.',
  'revoked_at', 'When the pack was revoked; a revoked pack never opens again.',
  'revoked_by', 'Person who revoked the pack.'
]);
call private.install_audit_trail('app.stakeholder_packs');
call private.install_default_retention('app.stakeholder_packs', interval '1 year');

call private.install_policies('app.stakeholder_packs',
  $$project_id in (select private.project_ids_with('projects.settings.write')) and private.is_member(org_id)$$);
revoke insert, update, delete on app.stakeholder_packs from authenticated;

-- Items --------------------------------------------------------------------------------------------------------------

create table app.stakeholder_pack_items (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  stakeholder_pack_id uuid not null references app.stakeholder_packs (id),
  item_kind app.pack_item_kind not null default 'File',
  live_link_id uuid references app.live_links (id),
  attachment_id uuid references app.attachments (id),
  title text not null,
  position smallint not null,
  requires_acknowledgement boolean not null default false,
  constraint stakeholder_pack_items_subject check (
    (item_kind = 'Live Link' and live_link_id is not null and attachment_id is null)
    or (item_kind = 'File' and attachment_id is not null and live_link_id is null)),
  constraint stakeholder_pack_items_title_length check (char_length(btrim(title)) between 1 and 200),
  constraint stakeholder_pack_items_position check (position between 0 and 999),
  constraint stakeholder_pack_items_pack_key unique (id, stakeholder_pack_id)
);

create index stakeholder_pack_items_pack_idx on app.stakeholder_pack_items (stakeholder_pack_id, position);
create index stakeholder_pack_items_live_link_idx on app.stakeholder_pack_items (live_link_id);
create index stakeholder_pack_items_attachment_idx on app.stakeholder_pack_items (attachment_id);

call private.install_domain_table('app.stakeholder_pack_items', 'app.stakeholder_packs', 'stakeholder_pack_id',
  array['app.live_links', 'live_link_id', 'app.attachments', 'attachment_id']);
create unique index stakeholder_pack_items_live_link_key on app.stakeholder_pack_items (stakeholder_pack_id, live_link_id)
  where live_link_id is not null and deleted_at is null;
create unique index stakeholder_pack_items_attachment_key on app.stakeholder_pack_items (stakeholder_pack_id, attachment_id)
  where attachment_id is not null and deleted_at is null;
call private.describe('app.stakeholder_pack_items', 'Items of a stakeholder pack (ADR 0141): at most 30, each one live link of the pack''s project (P1) or one file of the project that scanned clean and is Public or Internal. A file item is added by the caller under the attachment''s own read policy; a live link item through app.add_stakeholder_pack_item. Removing an item soft-deletes it.', array[
  'stakeholder_pack_id', 'Pack the item belongs to.',
  'item_kind', 'Live Link or File, set by the database from the item added.',
  'live_link_id', 'Live link a Live Link item opens; it must be on the pack''s project and neither revoked nor expired when added.',
  'attachment_id', 'File a File item downloads: its current version that scanned clean, while the file is still Public or Internal.',
  'title', 'Item title shown to recipients, 1 to 200 characters.',
  'position', 'Order of the item in the pack, from 0; the database puts a new item last.',
  'requires_acknowledgement', 'True when each recipient is asked to type their name to acknowledge the item. A typed-name acknowledgement is a receipt, not a signature of a contract.'
]);
call private.install_audit_trail('app.stakeholder_pack_items');
call private.install_default_retention('app.stakeholder_pack_items', interval '1 year');

-- Recipients ---------------------------------------------------------------------------------------------------------

create table app.stakeholder_pack_recipients (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  stakeholder_pack_id uuid not null references app.stakeholder_packs (id),
  full_name text not null,
  email text not null,
  counterparty_id uuid references app.counterparties (id),
  label text,
  code_salt bytea not null,
  access_code_hash bytea not null,
  failed_attempts smallint not null default 0,
  unsubscribed_at timestamptz,
  revoked_at timestamptz,
  revoked_by uuid references app.people (id),
  constraint stakeholder_pack_recipients_name_length check (char_length(btrim(full_name)) between 1 and 200),
  constraint stakeholder_pack_recipients_email_format check (email = lower(btrim(email))
    and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' and char_length(email) <= 320),
  constraint stakeholder_pack_recipients_label_length check (label is null or char_length(btrim(label)) between 1 and 80),
  constraint stakeholder_pack_recipients_salt_length check (octet_length(code_salt) = 32),
  constraint stakeholder_pack_recipients_code_hash_length check (octet_length(access_code_hash) = 32),
  constraint stakeholder_pack_recipients_failed_attempts check (failed_attempts between 0 and 5),
  constraint stakeholder_pack_recipients_revoked check ((revoked_at is null) = (revoked_by is null)),
  constraint stakeholder_pack_recipients_pack_key unique (id, stakeholder_pack_id)
);

create index stakeholder_pack_recipients_pack_idx on app.stakeholder_pack_recipients (stakeholder_pack_id);
create index stakeholder_pack_recipients_counterparty_idx on app.stakeholder_pack_recipients (counterparty_id);
create index stakeholder_pack_recipients_revoked_by_idx on app.stakeholder_pack_recipients (revoked_by);

call private.install_domain_table('app.stakeholder_pack_recipients', 'app.stakeholder_packs', 'stakeholder_pack_id',
  array['app.counterparties', 'counterparty_id']);
create unique index stakeholder_pack_recipients_email_key on app.stakeholder_pack_recipients (stakeholder_pack_id, email)
  where revoked_at is null and deleted_at is null;
call private.describe('app.stakeholder_pack_recipients', 'People outside the org a stakeholder pack is for (ADR 0141): at most 200 per pack, each with a 6-digit access code given out of band (by phone or message, never by email). The code is returned once by app.add_stakeholder_pack_recipient or app.reset_stakeholder_pack_recipient_code and stored only as a salted hash. What each recipient did is in app.stakeholder_pack_events.', array[
  'stakeholder_pack_id', 'Pack the recipient may open.',
  'full_name', 'Recipient''s name as the team entered it; shown to the recipient on the pack.',
  'email', 'Where the pack''s sign-in links go, lower case. Confidential.',
  'counterparty_id', 'Supplier the recipient works for, when the pack goes out per supplier.',
  'label', 'Group the recipient belongs to, for example a department, 1 to 80 characters.',
  'code_salt', '32 random bytes that salt the access code''s hash, drawn by the database. Never readable by signed-in callers.',
  'access_code_hash', 'SHA-256 of the salt in hex, a colon and the 6-digit access code. Never readable by signed-in callers.',
  'failed_attempts', 'Wrong access codes entered since the code was set; the recipient locks at 5 until the code is reset.',
  'unsubscribed_at', 'When the recipient stopped the pack''s emails; scheduled sends skip them, and the pack still opens.',
  'revoked_at', 'When the recipient was revoked; their links and device grants stop working.',
  'revoked_by', 'Person who revoked the recipient.'
]);
call private.install_audit_trail('app.stakeholder_pack_recipients');
call private.install_default_retention('app.stakeholder_pack_recipients', interval '1 year');

insert into private.column_classifications (table_name, column_name, classification, read_capability) values
  ('app.stakeholder_pack_recipients', 'email', 'Confidential', null)
on conflict (table_name, column_name) do nothing;

-- Events -------------------------------------------------------------------------------------------------------------

create table app.stakeholder_pack_events (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  stakeholder_pack_id uuid not null references app.stakeholder_packs (id),
  recipient_id uuid not null,
  item_id uuid,
  action app.pack_event_action not null,
  signer_name text,
  occurred_at timestamptz not null default now(),
  constraint stakeholder_pack_events_recipient_fkey foreign key (recipient_id, stakeholder_pack_id)
    references app.stakeholder_pack_recipients (id, stakeholder_pack_id),
  constraint stakeholder_pack_events_item_fkey foreign key (item_id, stakeholder_pack_id)
    references app.stakeholder_pack_items (id, stakeholder_pack_id),
  constraint stakeholder_pack_events_item check ((action in ('Viewed', 'Downloaded', 'Signed')) = (item_id is not null)),
  constraint stakeholder_pack_events_signer check ((action = 'Signed') = (signer_name is not null)
    and (signer_name is null or char_length(btrim(signer_name)) between 1 and 200))
);

create index stakeholder_pack_events_pack_idx on app.stakeholder_pack_events (stakeholder_pack_id, occurred_at);
create index stakeholder_pack_events_recipient_idx on app.stakeholder_pack_events (recipient_id, action, occurred_at);
create index stakeholder_pack_events_item_idx on app.stakeholder_pack_events (item_id, recipient_id, action);
create index stakeholder_pack_events_recipient_fkey_idx on app.stakeholder_pack_events (recipient_id, stakeholder_pack_id);
create index stakeholder_pack_events_item_fkey_idx on app.stakeholder_pack_events (item_id, stakeholder_pack_id);

call private.install_domain_table('app.stakeholder_pack_events', 'app.stakeholder_packs', 'stakeholder_pack_id', '{}', true);
call private.describe('app.stakeholder_pack_events', 'What each stakeholder pack recipient did (ADR 0141), append-only: a sign-in link Sent, the pack Opened with the code or a device grant, a live item Viewed (at most once per recipient, item and hour), a file Downloaded (also in app.file_access_log), an item Signed with the typed name, and Unsubscribed. Written only by the pack RPCs; no visitor address is kept.', array[
  'stakeholder_pack_id', 'Pack the event belongs to.',
  'recipient_id', 'Recipient who acted, or to whom the link was sent.',
  'item_id', 'Item viewed, downloaded or signed; null for pack-level events.',
  'action', 'Sent, Opened, Viewed, Downloaded, Signed or Unsubscribed.',
  'signer_name', 'Name the recipient typed to acknowledge the item; Signed events only.',
  'occurred_at', 'When it happened.'
]);
call private.install_default_retention('app.stakeholder_pack_events', interval '2 years');

-- Private state: emailed links and device grants --------------------------------------------------------------------

create table private.stakeholder_pack_links (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  stakeholder_pack_delivery_id uuid not null,
  recipient_id uuid not null references app.stakeholder_pack_recipients (id),
  token_hash bytea not null,
  token_hint text not null,
  unsubscribe_hash bytea not null,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  constraint stakeholder_pack_links_token_hash_length check (octet_length(token_hash) = 32),
  constraint stakeholder_pack_links_unsubscribe_hash_length check (octet_length(unsubscribe_hash) = 32),
  constraint stakeholder_pack_links_token_hint check (token_hint ~ '^[0-9a-f]{4}$')
);

create unique index stakeholder_pack_links_token_key on private.stakeholder_pack_links (token_hash);
create unique index stakeholder_pack_links_unsubscribe_key on private.stakeholder_pack_links (unsubscribe_hash);
create index stakeholder_pack_links_org_idx on private.stakeholder_pack_links (org_id);
create index stakeholder_pack_links_delivery_idx on private.stakeholder_pack_links (stakeholder_pack_delivery_id);
create index stakeholder_pack_links_recipient_idx on private.stakeholder_pack_links (recipient_id);

comment on table private.stakeholder_pack_links is 'One row per emailed stakeholder pack sign-in link (ADR 0141, 2913): the SHA-256 of the xpkl_ token and of the xpku_ unsubscribe token, the expiry (7 days after it was sent, or the pack''s expiry if sooner) and the revocation. Minting a link for a retried delivery revokes the earlier attempt''s; a failed send revokes its own. Rows are deleted 30 days after the pack''s expiry, so an old email''s unsubscribe still works until then.';
comment on column private.stakeholder_pack_links.id is 'Link id (UUID v7).';
comment on column private.stakeholder_pack_links.org_id is 'Org of the pack; deleting the org (1351) takes the link with it.';
comment on column private.stakeholder_pack_links.stakeholder_pack_delivery_id is 'Delivery whose email carried the link (app.stakeholder_pack_deliveries, 2913).';
comment on column private.stakeholder_pack_links.recipient_id is 'Recipient the link opens the pack for.';
comment on column private.stakeholder_pack_links.token_hash is 'SHA-256 of the link token (xpkl_ and 256 random bits in hex); the token is only in the email.';
comment on column private.stakeholder_pack_links.token_hint is 'Last four characters of the token.';
comment on column private.stakeholder_pack_links.unsubscribe_hash is 'SHA-256 of the unsubscribe token (xpku_ and 256 random bits in hex) the email''s Stop these emails link and List-Unsubscribe header carry.';
comment on column private.stakeholder_pack_links.expires_at is 'When the link stops opening: 7 days after it was minted, or the pack''s expiry if sooner.';
comment on column private.stakeholder_pack_links.revoked_at is 'When the link was revoked: a later attempt of its delivery, a failed send, or the pack or recipient revoked.';
comment on column private.stakeholder_pack_links.created_at is 'When the link was minted.';

alter table private.stakeholder_pack_links enable row level security;
revoke all on private.stakeholder_pack_links from public, anon, authenticated;
grant select on private.stakeholder_pack_links to service_role;

create table private.stakeholder_pack_grants (
  grant_hash bytea primary key,
  org_id uuid not null references app.organizations (id),
  recipient_id uuid not null references app.stakeholder_pack_recipients (id),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  constraint stakeholder_pack_grants_hash_length check (octet_length(grant_hash) = 32)
);

create index stakeholder_pack_grants_org_idx on private.stakeholder_pack_grants (org_id);
create index stakeholder_pack_grants_recipient_idx on private.stakeholder_pack_grants (recipient_id);
create index stakeholder_pack_grants_expires_idx on private.stakeholder_pack_grants (expires_at);

comment on table private.stakeholder_pack_grants is 'Device grants of stakeholder pack recipients (ADR 0141): a correct access code, or a valid grant on a newer emailed link, earns the browser a grant kept in an HttpOnly cookie, so later reads need no code. Only the SHA-256 of the grant is stored. Resetting the code or revoking the recipient or the pack deletes them.';
comment on column private.stakeholder_pack_grants.grant_hash is 'SHA-256 of the grant (xpkg_ and 256 random bits in hex).';
comment on column private.stakeholder_pack_grants.org_id is 'Org of the pack; deleting the org (1351) takes the grant with it.';
comment on column private.stakeholder_pack_grants.recipient_id is 'Recipient the grant reads the pack for.';
comment on column private.stakeholder_pack_grants.expires_at is 'When the grant stops working: the link''s expiry, the pack''s expiry or 7 days after it was issued, whichever comes first.';
comment on column private.stakeholder_pack_grants.created_at is 'When the grant was issued.';

alter table private.stakeholder_pack_grants enable row level security;
revoke all on private.stakeholder_pack_grants from public, anon, authenticated;
grant select on private.stakeholder_pack_grants to service_role;

select cron.schedule('xos_prune_stakeholder_pack_grants', '47 4 * * *', $$
  delete from private.stakeholder_pack_grants where expires_at < now() - interval '1 day';
$$);

-- Who manages a pack, which the file item insert policy reads ---------------------------------------------------------

create or replace function private.can_manage_stakeholder_pack(p_pack_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from app.stakeholder_packs p
    where p.id = p_pack_id and p.deleted_at is null and private.is_member(p.org_id)
      and private.can_on_project(p.project_id, 'projects.settings.write'));
$$;

comment on function private.can_manage_stakeholder_pack(uuid) is 'True when the signed-in person is a member of the pack''s org holding projects.settings.write on its project; a partner org reaching the project through a project share never is. Read by the file item insert policy.';
revoke all on function private.can_manage_stakeholder_pack(uuid) from public, anon;
grant execute on function private.can_manage_stakeholder_pack(uuid) to authenticated, service_role;

-- Read access and column grants --------------------------------------------------------------------------------------

call private.install_policies('app.stakeholder_pack_items',
  $$stakeholder_pack_id in (select p.id from app.stakeholder_packs p
    where p.project_id in (select private.project_ids_with('projects.settings.write')) and private.is_member(p.org_id))$$,
  $$private.is_member(org_id) and private.can_manage_stakeholder_pack(stakeholder_pack_id)
    and (attachment_id is null or private.can_read_attachment(attachment_id))$$);
revoke insert, update, delete on app.stakeholder_pack_items from authenticated;
grant insert (stakeholder_pack_id, live_link_id, attachment_id, title, position, requires_acknowledgement)
  on app.stakeholder_pack_items to authenticated;

call private.install_policies('app.stakeholder_pack_recipients',
  $$stakeholder_pack_id in (select p.id from app.stakeholder_packs p
    where p.project_id in (select private.project_ids_with('projects.settings.write')) and private.is_member(p.org_id))$$);
revoke select, insert, update, delete on app.stakeholder_pack_recipients from authenticated;
grant select (id, org_id, stakeholder_pack_id, full_name, email, counterparty_id, label, failed_attempts, unsubscribed_at,
  revoked_at, revoked_by, created_at, created_by, updated_at, updated_by, deleted_at) on app.stakeholder_pack_recipients to authenticated;

call private.install_policies('app.stakeholder_pack_events',
  $$stakeholder_pack_id in (select p.id from app.stakeholder_packs p
    where p.project_id in (select private.project_ids_with('projects.settings.write')) and private.is_member(p.org_id))$$);
revoke insert, update, delete on app.stakeholder_pack_events from authenticated;

-- Who manages a pack ------------------------------------------------------------------------------------------------

create or replace function private.manageable_stakeholder_pack(p_pack_id uuid)
returns app.stakeholder_packs
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_pack app.stakeholder_packs;
begin
  perform private.require_person();
  select * into v_pack from app.stakeholder_packs p where p.id = p_pack_id and p.deleted_at is null for update;
  if v_pack.id is null or not private.is_member(v_pack.org_id)
     or not private.can_on_project(v_pack.project_id, 'projects.settings.write') then
    raise exception using errcode = '42501', message = 'pack not found';
  end if;
  return v_pack;
end;
$$;

comment on function private.manageable_stakeholder_pack(uuid) is 'Locks and returns a stakeholder pack the signed-in person may change: a member of its org holding projects.settings.write on its project; otherwise raises pack not found.';
revoke all on function private.manageable_stakeholder_pack(uuid) from public, anon, authenticated;

-- Defense in depth behind the grants: packs and recipients change only inside the pack RPCs; file items are checked
-- by their own guard below.
create or replace function private.guard_stakeholder_pack()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.in_trusted_operation('stakeholder_pack_service') then
    perform private.refuse('stakeholder_pack_immutable', 'A stakeholder pack and its recipients change only through the pack RPCs.');
  end if;
  if tg_op = 'UPDATE' and tg_table_name = 'stakeholder_packs' then
    if (to_jsonb(new) ->> 'project_id') is distinct from (to_jsonb(old) ->> 'project_id') then
      perform private.refuse('stakeholder_pack_immutable', 'A stakeholder pack keeps its project; make a new pack instead.');
    end if;
  end if;
  if tg_op = 'UPDATE' and old.revoked_at is not null and new.revoked_at is distinct from old.revoked_at then
    perform private.refuse('stakeholder_pack_revoked', 'A revoked pack or recipient stays revoked.');
  end if;
  return new;
end;
$$;

comment on function private.guard_stakeholder_pack() is 'Stakeholder packs and recipients: rows are inserted and changed only inside the pack RPCs (trusted operation stakeholder_pack_service); a pack keeps its project, and a revoked pack or recipient stays revoked.';
revoke all on function private.guard_stakeholder_pack() from public, anon, authenticated;

create trigger t40_guard_stakeholder_pack before insert or update on app.stakeholder_packs
  for each row execute function private.guard_stakeholder_pack();
create trigger t40_guard_stakeholder_pack before insert or update on app.stakeholder_pack_recipients
  for each row execute function private.guard_stakeholder_pack();

-- The version a pack serves: the highest version that is not deleted, and only if it scanned clean. A pack does not pin
-- a version (1380 does), so a newer Pending or Infected version makes the item unavailable rather than quietly serving
-- an older file.
create or replace function private.pack_file_version(p_attachment_id uuid)
returns app.attachment_versions
language sql
stable
security definer
set search_path = ''
as $$
  select x.* from (
    select v.* from app.attachment_versions v
    where v.attachment_id = p_attachment_id and v.deleted_at is null
    order by v.version_number desc limit 1
  ) x
  where x.scan_status = 'Clean';
$$;

comment on function private.pack_file_version(uuid) is 'The version of a file a stakeholder pack serves: its highest version that is not deleted, when that version scanned clean; otherwise null, so a newer Pending or Infected version makes the item unavailable.';
revoke all on function private.pack_file_version(uuid) from public, anon, authenticated;

create or replace function private.pack_file_project_id(p_attachment_id uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select (private.subject_row(a.subject_table, a.subject_id) ->> 'project_id')::uuid
  from app.attachments a
  where a.id = p_attachment_id and private.is_member(a.org_id) and (private.pack_file_version(a.id)).id is not null;
$$;

comment on function private.pack_file_project_id(uuid) is 'Project of a file a stakeholder pack could serve: the project of the attachment''s subject, for a member of its org, when its current version scanned clean; otherwise null. Read by the view app.stakeholder_pack_file_choices on attachments the caller''s row level security already returns.';
revoke all on function private.pack_file_project_id(uuid) from public, anon;
grant execute on function private.pack_file_project_id(uuid) to authenticated, service_role;

-- The editor's list of files. A security invoker view, so the attachment's own read policy decides which files are
-- offered, on the project itself or on any of its records. The guard below checks the file again when it is added. The
-- project is looked up per row, so the data function always filters by org and project.
create view app.stakeholder_pack_file_choices with (security_invoker = true) as
select private.pack_file_project_id(a.id) as project_id, a.org_id, a.id as attachment_id, a.title
from app.attachments a
where a.deleted_at is null and a.classification in ('Public', 'Internal')
  and private.pack_file_project_id(a.id) is not null;

call private.describe('app.stakeholder_pack_file_choices', 'Files a stakeholder pack can offer (ADR 0141): Public or Internal, clean in their current version, on a project or one of its records, and readable by the caller under row level security.', array[
  'project_id', 'Project of the file''s subject.',
  'org_id', 'Org holding the file.',
  'attachment_id', 'The file.',
  'title', 'The file''s display name.'
]);
revoke all on app.stakeholder_pack_file_choices from public, anon;
grant select on app.stakeholder_pack_file_choices to authenticated, service_role;
revoke select on app.stakeholder_pack_file_choices from xos_backup;

-- An item is inserted by the caller under row level security, so for a file the attachment's read policy decides
-- whether the caller may see it (private.can_read_attachment runs as the caller there, as for 1380's share links).
-- This guard runs as its definer and checks what the policy cannot: the pack, the read-only org, the 30-item limit;
-- for a live link P1's private.manageable_live_link, the project and the link's state; for a file the project, a
-- clean version and the classification, and it logs Share Link Created.
create or replace function private.guard_stakeholder_pack_item()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.current_person_id();
  v_pack app.stakeholder_packs;
  v_link app.live_links;
  v_attachment app.attachments;
  v_version app.attachment_versions;
begin
  if tg_op = 'UPDATE' then
    if not private.in_trusted_operation('stakeholder_pack_service') then
      perform private.refuse('stakeholder_pack_immutable', 'A pack item changes only through the pack RPCs.');
    end if;
    if new.item_kind <> old.item_kind or new.live_link_id is distinct from old.live_link_id
       or new.attachment_id is distinct from old.attachment_id or new.stakeholder_pack_id <> old.stakeholder_pack_id then
      perform private.refuse('stakeholder_pack_immutable', 'A pack item keeps what it shares; add a new item instead.');
    end if;
    return new;
  end if;

  if v_person is null then
    perform private.refuse('stakeholder_pack_person', 'A pack item is added by a signed-in person.');
  end if;
  if num_nonnulls(new.live_link_id, new.attachment_id) <> 1 then
    perform private.refuse('stakeholder_pack_item_subject', 'A pack item is one live link or one file.');
  end if;
  select * into v_pack from app.stakeholder_packs p where p.id = new.stakeholder_pack_id and p.deleted_at is null;
  if v_pack.id is null or not private.can_manage_stakeholder_pack(v_pack.id) then
    raise exception using errcode = '42501', message = 'pack not found';
  end if;
  if v_pack.revoked_at is not null then
    perform private.refuse('stakeholder_pack_revoked', 'This pack is revoked. Make a new pack instead.');
  end if;
  if private.org_read_only(v_pack.org_id) then
    perform private.refuse('org_read_only', 'This organization is canceled and read-only. The Owner can reactivate it in Settings, Danger zone, during the 30 days.');
  end if;
  if (select count(*) from app.stakeholder_pack_items i where i.stakeholder_pack_id = v_pack.id and i.deleted_at is null) >= 30 then
    perform private.refuse('stakeholder_pack_item_limit', 'A pack holds at most 30 items. Remove one before you add another.');
  end if;
  new.title := btrim(new.title);
  new.position := coalesce(new.position, (
    select least(coalesce(max(i.position) + 1, 0), 999)::smallint
    from app.stakeholder_pack_items i where i.stakeholder_pack_id = v_pack.id and i.deleted_at is null));

  if new.live_link_id is not null then
    new.item_kind := 'Live Link';
    -- P1 decides who may share the link: its creator or a holder of its collection's share capability.
    v_link := private.manageable_live_link(new.live_link_id);
    if v_link.project_id <> v_pack.project_id or v_link.revoked_at is not null or v_link.expires_at <= now() then
      perform private.refuse('stakeholder_pack_item_link', 'Choose a live link of this project that is neither revoked nor expired.');
    end if;
    return new;
  end if;

  new.item_kind := 'File';
  select * into v_attachment from app.attachments a where a.id = new.attachment_id and a.deleted_at is null;
  v_version := private.pack_file_version(new.attachment_id);
  if v_attachment.id is null or v_version.id is null or v_attachment.org_id <> v_pack.org_id
     or (private.subject_row(v_attachment.subject_table, v_attachment.subject_id) ->> 'project_id')::uuid is distinct from v_pack.project_id then
    perform private.refuse('stakeholder_pack_item_file', 'Only a file of this project whose current version scanned clean goes in a pack.');
  end if;
  if v_attachment.classification not in ('Public', 'Internal') then
    perform private.refuse('stakeholder_pack_item_classified', 'Only Public or Internal files go in a pack; Confidential and Restricted files never leave by link.');
  end if;
  insert into app.file_access_log (org_id, person_id, bucket_id, object_path, action, classification, watermarked)
  values (v_pack.org_id, v_person, 'attachments', v_version.object_name, 'Share Link Created', v_attachment.classification, false);
  return new;
end;
$$;

comment on function private.guard_stakeholder_pack_item() is 'Stakeholder pack items, inserted by the caller under row level security: the pack is one the caller manages, not revoked, in an org that is not read-only and below the 30-item limit; a live link item needs P1''s private.manageable_live_link and a link of the pack''s project neither revoked nor expired (stakeholder_pack_item_link); a file item needs a file of the pack''s project with a version that scanned clean, classified Public or Internal (stakeholder_pack_item_classified), and logs Share Link Created in app.file_access_log. The database sets the kind and puts the item last. Afterwards an item changes only inside the pack RPCs and keeps what it shares.';
revoke all on function private.guard_stakeholder_pack_item() from public, anon, authenticated;

create trigger t40_guard_stakeholder_pack_item before insert or update on app.stakeholder_pack_items
  for each row execute function private.guard_stakeholder_pack_item();

-- Activity, computed from the events ------------------------------------------------------------------------------------

create view app.stakeholder_pack_recipient_activity with (security_invoker = true) as
select r.id as recipient_id, r.stakeholder_pack_id,
  max(e.occurred_at) filter (where e.action = 'Sent') as last_sent_at,
  count(*) filter (where e.action = 'Opened') as opens,
  min(e.occurred_at) filter (where e.action = 'Opened') as first_opened_at,
  max(e.occurred_at) filter (where e.action = 'Opened') as last_opened_at,
  count(distinct e.item_id) filter (where e.action = 'Viewed') as items_viewed,
  count(*) filter (where e.action = 'Downloaded') as downloads,
  count(*) filter (where e.action = 'Signed') as signatures
from app.stakeholder_pack_recipients r
left join app.stakeholder_pack_events e on e.recipient_id = r.id
where r.deleted_at is null
group by r.id, r.stakeholder_pack_id;

call private.describe('app.stakeholder_pack_recipient_activity', 'What each stakeholder pack recipient did, counted from app.stakeholder_pack_events when read (ADR 0141): the last link sent, opens, the first and last open, distinct live items viewed, downloads and acknowledgements. Nothing stores these counts. Each source table''s own row level security decides.', array[
  'recipient_id', 'Recipient.',
  'stakeholder_pack_id', 'Pack.',
  'last_sent_at', 'When the last sign-in link went out.',
  'opens', 'Opens with the code or a device grant.',
  'first_opened_at', 'First open.',
  'last_opened_at', 'Last open.',
  'items_viewed', 'Distinct live items viewed.',
  'downloads', 'Files downloaded.',
  'signatures', 'Items acknowledged with a typed name.'
]);
revoke all on app.stakeholder_pack_recipient_activity from public, anon;
grant select on app.stakeholder_pack_recipient_activity to authenticated, service_role;
revoke select on app.stakeholder_pack_recipient_activity from xos_backup;

-- Pack RPCs ----------------------------------------------------------------------------------------------------------

create or replace function app.create_stakeholder_pack(
  p_project_id uuid,
  p_name text,
  p_expires_at timestamptz,
  p_message text default null,
  p_note text default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_project app.projects;
  v_id uuid;
begin
  perform private.require_person();
  select * into v_project from app.projects p where p.id = p_project_id and p.deleted_at is null;
  -- Only members of the project's org publish its data: a partner org reaching it through a project share never does.
  if v_project.id is null or not private.is_member(v_project.org_id) then
    raise exception using errcode = '42501', message = 'project not found';
  end if;
  if not private.can_on_project(v_project.id, 'projects.settings.write') then
    raise exception using errcode = '42501', message = 'projects.settings.write is required on the project';
  end if;
  if private.org_read_only(v_project.org_id) then
    perform private.refuse('org_read_only', 'This organization is canceled and read-only. The Owner can reactivate it in Settings, Danger zone, during the 30 days.');
  end if;
  if p_expires_at is null or p_expires_at <= now() or p_expires_at > now() + interval '90 days' then
    perform private.refuse('stakeholder_pack_expiry_range', 'A stakeholder pack expires after now and within 90 days.');
  end if;
  perform private.begin_trusted_operation('stakeholder_pack_service');
  insert into app.stakeholder_packs as p (project_id, name, message, note, expires_at)
  values (v_project.id, btrim(p_name), nullif(btrim(coalesce(p_message, '')), ''), nullif(btrim(coalesce(p_note, '')), ''), p_expires_at)
  returning p.id into v_id;
  perform private.end_trusted_operation('stakeholder_pack_service');
  perform private.emit_event(v_project.org_id, 'stakeholder_pack.created', 'stakeholder_packs', v_id, v_project.id,
    jsonb_build_object('expires_at', p_expires_at));
  return v_id;
end;
$$;

comment on function app.create_stakeholder_pack(uuid, text, timestamptz, text, text) is 'Makes a stakeholder pack on a project (ADR 0141): needs membership of the project''s org (a partner org reaching it through a project share never qualifies) and projects.settings.write on the project, an org that is not read-only, and an expiry after now and within 90 days (stakeholder_pack_expiry_range). The message is shown to recipients; the note never is. Returns the pack id.';
revoke all on function app.create_stakeholder_pack(uuid, text, timestamptz, text, text) from public, anon;
grant execute on function app.create_stakeholder_pack(uuid, text, timestamptz, text, text) to authenticated, service_role;

create or replace function app.update_stakeholder_pack(
  p_pack_id uuid,
  p_name text,
  p_message text,
  p_note text,
  p_expires_at timestamptz
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_pack app.stakeholder_packs := private.manageable_stakeholder_pack(p_pack_id);
begin
  if v_pack.revoked_at is not null then
    perform private.refuse('stakeholder_pack_revoked', 'This pack is revoked. Make a new pack instead.');
  end if;
  if private.org_read_only(v_pack.org_id) then
    perform private.refuse('org_read_only', 'This organization is canceled and read-only. The Owner can reactivate it in Settings, Danger zone, during the 30 days.');
  end if;
  if p_expires_at is null or p_expires_at <= now() or p_expires_at > now() + interval '90 days' then
    perform private.refuse('stakeholder_pack_expiry_range', 'A stakeholder pack expires after now and within 90 days.');
  end if;
  perform private.begin_trusted_operation('stakeholder_pack_service');
  update app.stakeholder_packs
  set name = btrim(p_name), message = nullif(btrim(coalesce(p_message, '')), ''), note = nullif(btrim(coalesce(p_note, '')), ''),
    expires_at = p_expires_at
  where id = v_pack.id;
  perform private.end_trusted_operation('stakeholder_pack_service');
end;
$$;

comment on function app.update_stakeholder_pack(uuid, text, text, text, timestamptz) is 'Changes a stakeholder pack''s name, message, note and expiry (ADR 0141): the expiry may move earlier, or later while it stays within 90 days of now. Reads check the pack''s expiry each time, so an earlier expiry stops every link and device grant at once. Refused for a revoked pack and in a read-only org.';
revoke all on function app.update_stakeholder_pack(uuid, text, text, text, timestamptz) from public, anon;
grant execute on function app.update_stakeholder_pack(uuid, text, text, text, timestamptz) to authenticated, service_role;

create or replace function app.revoke_stakeholder_pack(p_pack_id uuid)
returns timestamptz
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
  v_pack app.stakeholder_packs := private.manageable_stakeholder_pack(p_pack_id);
begin
  if v_pack.revoked_at is not null then
    return v_pack.revoked_at;
  end if;
  perform private.begin_trusted_operation('stakeholder_pack_service');
  update app.stakeholder_packs set revoked_at = now(), revoked_by = v_person where id = v_pack.id;
  perform private.end_trusted_operation('stakeholder_pack_service');
  delete from private.stakeholder_pack_grants g
  where g.recipient_id in (select r.id from app.stakeholder_pack_recipients r where r.stakeholder_pack_id = v_pack.id);
  update private.stakeholder_pack_links l set revoked_at = now()
  where l.revoked_at is null
    and l.recipient_id in (select r.id from app.stakeholder_pack_recipients r where r.stakeholder_pack_id = v_pack.id);
  perform private.emit_event(v_pack.org_id, 'stakeholder_pack.revoked', 'stakeholder_packs', v_pack.id, v_pack.project_id, '{}'::jsonb);
  return now();
end;
$$;

comment on function app.revoke_stakeholder_pack(uuid) is 'Revokes a stakeholder pack so none of its links opens again (ADR 0141): deletes every recipient''s device grants and revokes every emailed link. Idempotent: a revoked pack answers its first revocation time. Allowed in a read-only org, since it withdraws access.';
revoke all on function app.revoke_stakeholder_pack(uuid) from public, anon;
grant execute on function app.revoke_stakeholder_pack(uuid) to authenticated, service_role;

-- Items --------------------------------------------------------------------------------------------------------------

create or replace function app.add_stakeholder_pack_item(
  p_pack_id uuid,
  p_live_link_id uuid default null,
  p_attachment_id uuid default null,
  p_title text default null,
  p_requires_acknowledgement boolean default false
)
returns uuid
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_id uuid;
begin
  -- The caller's own insert, so a file's read policy decides; private.guard_stakeholder_pack_item checks the rest.
  insert into app.stakeholder_pack_items as i (stakeholder_pack_id, live_link_id, attachment_id, title, requires_acknowledgement)
  values (p_pack_id, p_live_link_id, p_attachment_id, p_title, coalesce(p_requires_acknowledgement, false))
  returning i.id into v_id;
  return v_id;
end;
$$;

comment on function app.add_stakeholder_pack_item(uuid, uuid, uuid, text, boolean) is 'Adds one item to a stakeholder pack (ADR 0141), last in order. A live link item needs a P1 link of the pack''s project the caller may manage, neither revoked nor expired (stakeholder_pack_item_link). A file item is inserted as the caller, so only a file the caller can read qualifies, and it must be of the pack''s project with a version that scanned clean and classified Public or Internal (stakeholder_pack_item_classified); adding it logs Share Link Created. At most 30 items. Returns the item id.';
revoke all on function app.add_stakeholder_pack_item(uuid, uuid, uuid, text, boolean) from public, anon;
grant execute on function app.add_stakeholder_pack_item(uuid, uuid, uuid, text, boolean) to authenticated, service_role;

create or replace function app.remove_stakeholder_pack_item(p_item_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_item app.stakeholder_pack_items;
  v_pack app.stakeholder_packs;
begin
  select * into v_item from app.stakeholder_pack_items i where i.id = p_item_id and i.deleted_at is null;
  if v_item.id is null then
    raise exception using errcode = '42501', message = 'pack item not found';
  end if;
  v_pack := private.manageable_stakeholder_pack(v_item.stakeholder_pack_id);
  perform private.begin_trusted_operation('stakeholder_pack_service');
  update app.stakeholder_pack_items set deleted_at = now() where id = v_item.id;
  perform private.end_trusted_operation('stakeholder_pack_service');
end;
$$;

comment on function app.remove_stakeholder_pack_item(uuid) is 'Removes an item from a stakeholder pack (soft delete); recipients stop seeing it at once. Needs projects.settings.write on the pack''s project.';
revoke all on function app.remove_stakeholder_pack_item(uuid) from public, anon;
grant execute on function app.remove_stakeholder_pack_item(uuid) to authenticated, service_role;

create or replace function app.order_stakeholder_pack_items(p_pack_id uuid, p_item_ids uuid[])
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_pack app.stakeholder_packs := private.manageable_stakeholder_pack(p_pack_id);
begin
  if p_item_ids is null or cardinality(p_item_ids) > 30
     or exists (select 1 from unnest(p_item_ids) x (id)
                where not exists (select 1 from app.stakeholder_pack_items i
                                  where i.id = x.id and i.stakeholder_pack_id = v_pack.id and i.deleted_at is null)) then
    perform private.refuse('stakeholder_pack_item_order', 'Order the pack''s own items.');
  end if;
  perform private.begin_trusted_operation('stakeholder_pack_service');
  update app.stakeholder_pack_items i set position = (x.n - 1)::smallint
  from unnest(p_item_ids) with ordinality as x (id, n)
  where i.id = x.id;
  perform private.end_trusted_operation('stakeholder_pack_service');
end;
$$;

comment on function app.order_stakeholder_pack_items(uuid, uuid[]) is 'Sets the order of a stakeholder pack''s items to the order of the ids given (the editor''s drag order). Every id must be a live item of the pack. Needs projects.settings.write on the pack''s project.';
revoke all on function app.order_stakeholder_pack_items(uuid, uuid[]) from public, anon;
grant execute on function app.order_stakeholder_pack_items(uuid, uuid[]) to authenticated, service_role;

-- Recipients ---------------------------------------------------------------------------------------------------------

create or replace function app.add_stakeholder_pack_recipient(
  p_pack_id uuid,
  p_full_name text,
  p_email text,
  p_counterparty_id uuid default null,
  p_label text default null
)
returns table (recipient_id uuid, access_code text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_pack app.stakeholder_packs := private.manageable_stakeholder_pack(p_pack_id);
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_salt bytea := extensions.gen_random_bytes(32);
  v_code text := private.new_live_link_code();
  v_id uuid;
begin
  if v_pack.revoked_at is not null then
    perform private.refuse('stakeholder_pack_revoked', 'This pack is revoked. Make a new pack instead.');
  end if;
  if private.org_read_only(v_pack.org_id) then
    perform private.refuse('org_read_only', 'This organization is canceled and read-only. The Owner can reactivate it in Settings, Danger zone, during the 30 days.');
  end if;
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' or char_length(v_email) > 320 then
    perform private.refuse('stakeholder_pack_recipient_email', 'Enter the recipient''s email address.');
  end if;
  if exists (select 1 from app.stakeholder_pack_recipients r
             where r.stakeholder_pack_id = v_pack.id and r.email = v_email and r.revoked_at is null and r.deleted_at is null) then
    perform private.refuse('stakeholder_pack_recipient_duplicate', 'This pack already has a recipient with that email.');
  end if;
  if (select count(*) from app.stakeholder_pack_recipients r
      where r.stakeholder_pack_id = v_pack.id and r.revoked_at is null and r.deleted_at is null) >= 200 then
    perform private.refuse('stakeholder_pack_recipient_limit', 'A pack has at most 200 recipients.');
  end if;
  if p_counterparty_id is not null and not exists (
    select 1 from app.counterparties c where c.id = p_counterparty_id and c.org_id = v_pack.org_id and c.deleted_at is null) then
    perform private.refuse('stakeholder_pack_recipient_counterparty', 'Choose one of the organization''s suppliers.');
  end if;
  perform private.begin_trusted_operation('stakeholder_pack_service');
  insert into app.stakeholder_pack_recipients as r (stakeholder_pack_id, full_name, email, counterparty_id, label, code_salt, access_code_hash)
  values (v_pack.id, btrim(p_full_name), v_email, p_counterparty_id, nullif(btrim(coalesce(p_label, '')), ''), v_salt,
    private.share_code_hash(encode(v_salt, 'hex'), v_code))
  returning r.id into v_id;
  perform private.end_trusted_operation('stakeholder_pack_service');
  perform private.emit_event(v_pack.org_id, 'stakeholder_pack_recipient.added', 'stakeholder_pack_recipients', v_id, v_pack.project_id,
    jsonb_build_object('stakeholder_pack_id', v_pack.id));
  return query select v_id, v_code;
end;
$$;

comment on function app.add_stakeholder_pack_recipient(uuid, text, text, uuid, text) is 'Adds a recipient to a stakeholder pack (ADR 0141) and returns their 6-digit access code once, to give by phone or message; only its salted hash is kept and no email ever carries it. Refuses a revoked pack, a read-only org, a malformed email, a second live recipient with the same email, more than 200 recipients and a supplier of another org. Needs projects.settings.write on the pack''s project.';
revoke all on function app.add_stakeholder_pack_recipient(uuid, text, text, uuid, text) from public, anon;
grant execute on function app.add_stakeholder_pack_recipient(uuid, text, text, uuid, text) to authenticated, service_role;

create or replace function private.manageable_stakeholder_pack_recipient(p_recipient_id uuid)
returns app.stakeholder_pack_recipients
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_recipient app.stakeholder_pack_recipients;
begin
  select * into v_recipient from app.stakeholder_pack_recipients r where r.id = p_recipient_id and r.deleted_at is null;
  if v_recipient.id is null then
    raise exception using errcode = '42501', message = 'recipient not found';
  end if;
  perform private.manageable_stakeholder_pack(v_recipient.stakeholder_pack_id);
  select * into v_recipient from app.stakeholder_pack_recipients r where r.id = p_recipient_id for update;
  return v_recipient;
end;
$$;

comment on function private.manageable_stakeholder_pack_recipient(uuid) is 'Locks and returns a stakeholder pack recipient whose pack the signed-in person may change (private.manageable_stakeholder_pack); otherwise raises recipient not found or pack not found.';
revoke all on function private.manageable_stakeholder_pack_recipient(uuid) from public, anon, authenticated;

create or replace function app.reset_stakeholder_pack_recipient_code(p_recipient_id uuid)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_recipient app.stakeholder_pack_recipients := private.manageable_stakeholder_pack_recipient(p_recipient_id);
  v_salt bytea := extensions.gen_random_bytes(32);
  v_code text := private.new_live_link_code();
begin
  if v_recipient.revoked_at is not null then
    perform private.refuse('stakeholder_pack_recipient_revoked', 'This recipient is revoked. Add them again instead.');
  end if;
  if private.org_read_only(v_recipient.org_id) then
    perform private.refuse('org_read_only', 'This organization is canceled and read-only. The Owner can reactivate it in Settings, Danger zone, during the 30 days.');
  end if;
  perform private.begin_trusted_operation('stakeholder_pack_service');
  update app.stakeholder_pack_recipients
  set code_salt = v_salt, access_code_hash = private.share_code_hash(encode(v_salt, 'hex'), v_code), failed_attempts = 0
  where id = v_recipient.id;
  perform private.end_trusted_operation('stakeholder_pack_service');
  delete from private.stakeholder_pack_grants g where g.recipient_id = v_recipient.id;
  return v_code;
end;
$$;

comment on function app.reset_stakeholder_pack_recipient_code(uuid) is 'Gives a stakeholder pack recipient a new 6-digit access code, returned once (ADR 0141): a new salt, wrong-code attempts back to 0, which unlocks a recipient locked after 5, and every device grant dropped. Refused for a revoked recipient and in a read-only org.';
revoke all on function app.reset_stakeholder_pack_recipient_code(uuid) from public, anon;
grant execute on function app.reset_stakeholder_pack_recipient_code(uuid) to authenticated, service_role;

create or replace function app.revoke_stakeholder_pack_recipient(p_recipient_id uuid)
returns timestamptz
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
  v_recipient app.stakeholder_pack_recipients := private.manageable_stakeholder_pack_recipient(p_recipient_id);
begin
  if v_recipient.revoked_at is not null then
    return v_recipient.revoked_at;
  end if;
  perform private.begin_trusted_operation('stakeholder_pack_service');
  update app.stakeholder_pack_recipients set revoked_at = now(), revoked_by = v_person where id = v_recipient.id;
  perform private.end_trusted_operation('stakeholder_pack_service');
  delete from private.stakeholder_pack_grants g where g.recipient_id = v_recipient.id;
  update private.stakeholder_pack_links l set revoked_at = now() where l.recipient_id = v_recipient.id and l.revoked_at is null;
  perform private.emit_event(v_recipient.org_id, 'stakeholder_pack_recipient.revoked', 'stakeholder_pack_recipients', v_recipient.id,
    (select p.project_id from app.stakeholder_packs p where p.id = v_recipient.stakeholder_pack_id),
    jsonb_build_object('stakeholder_pack_id', v_recipient.stakeholder_pack_id));
  return now();
end;
$$;

comment on function app.revoke_stakeholder_pack_recipient(uuid) is 'Revokes one stakeholder pack recipient (ADR 0141): deletes their device grants and revokes their emailed links, so no later open, read, download or acknowledgement works. Idempotent. Allowed in a read-only org, since it withdraws access.';
revoke all on function app.revoke_stakeholder_pack_recipient(uuid) from public, anon;
grant execute on function app.revoke_stakeholder_pack_recipient(uuid) to authenticated, service_role;

-- Trash (ADR 0110) ----------------------------------------------------------------------------------------------------

insert into private.trash_excluded_tables (table_name, rationale) values
  ('stakeholder_packs', 'Revoked, replaced, never restored: a revoked pack never opens again; a new pack is made instead.'),
  ('stakeholder_pack_items', 'Revoked, replaced, never restored: a removed item is added again instead.'),
  ('stakeholder_pack_recipients', 'Revoked, replaced, never restored: a revoked recipient is added again with a new code.'),
  ('stakeholder_pack_events', 'An append-only log of what recipients did; it is never deleted by hand.')
on conflict (table_name) do nothing;

select private.sync_trash_tables();

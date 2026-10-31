-- 2780_live_links.sql
-- P1 (RRR-215, ADR 0130; parity gaps G-28 and G-76). Live links show a saved view, or a running order on a display
-- screen, to someone with no account, and update while they watch. Before this migration a saved view could be read
-- only by a member with their own client (0641), and the only no-account link was 1380's file share link.
--   * app.live_links: one row per link. A View link shows one saved view of one project; a Display link shows one
--     running order on a room clock, presenter timer or backstage screen. Every link has an expiry within 90 days
--     and an access code (Section 7.5 invariant 8 as ADR 0033 decision 56 words it: token RPCs require a token and
--     an access code). Tokens (xshv_ for views, xscr_ for screens) and codes are returned once and stored only as
--     SHA-256 hashes, salted as 1380 salts them. Rows are written only by the RPCs below.
--   * Only members of the link's org make links (private.is_member, as 1380), so a partner org that reaches the
--     project through app.project_shares (1205) never publishes the owner org's data; a read-only org makes none.
--   * Allowlist registries: private.live_view_collections names the four collections a link may show and the share
--     and read capabilities of each; private.live_view_fields names every column a link may show, filter, sort or
--     group by. A guard refuses a field whose source column is classified Confidential or Restricted, so only Public
--     and Internal columns are ever exposed (Section 8.3).
--   * private.live_link_channels holds each link's Realtime channel key (2782), private.live_link_grants the device
--     grants a correct code earns (2781), and private.retired_live_link_tokens the hashes of rotated or revoked
--     tokens, kept a year so a stale screen never counts as a failed guess (as 1410).
--   * app.live_link_states computes each link's state (Active, Locked, Expired, Revoked); nothing stores it.
--   * Regenerating draws a new token, code and channel key and drops every device grant; revoking is idempotent and
--     stays possible in a canceled org (Section 14.7), so the read-only guard is never installed on the table.
--   * Live links stay out of Trash (ADR 0110): a revoked or regenerated link is replaced, never restored.

create type app.live_link_kind as enum ('View', 'Display');
comment on type app.live_link_kind is 'What a live link shows (ADR 0130): View, one saved view of a project; Display, one running order on a display screen.';

create type app.display_mode as enum ('Room Clock', 'Presenter Timer', 'Backstage');
comment on type app.display_mode is 'Display screen modes (ADR 0130): Room Clock (time of day and the running cue), Presenter Timer (the current cue counting down) and Backstage (now, next and the following cues).';

-- Secrets ----------------------------------------------------------------------------------------------------------

create or replace function private.new_live_link_token(p_kind app.live_link_kind)
returns text
language sql
volatile
set search_path = ''
as $$
  select case p_kind when 'View' then 'xshv_' else 'xscr_' end || encode(extensions.gen_random_bytes(32), 'hex');
$$;

comment on function private.new_live_link_token(app.live_link_kind) is 'A new live link token: xshv_ (a saved view) or xscr_ (a display screen) and 256 random bits in hex. Only its SHA-256 hash is stored.';
revoke all on function private.new_live_link_token(app.live_link_kind) from public, anon, authenticated;

create or replace function private.new_live_link_code()
returns text
language sql
volatile
set search_path = ''
as $$
  select lpad(((('x' || encode(extensions.gen_random_bytes(4), 'hex'))::bit(32)::bigint) % 1000000)::text, 6, '0');
$$;

comment on function private.new_live_link_code() is 'A new 6-digit access code, drawn as 1380 draws share link codes. Only its hash, salted by the token, is stored.';
revoke all on function private.new_live_link_code() from public, anon, authenticated;

create or replace function private.new_live_link_channel_key()
returns text
language sql
volatile
set search_path = ''
as $$
  select 'xlch_' || encode(extensions.gen_random_bytes(32), 'hex');
$$;

comment on function private.new_live_link_channel_key() is 'A new live link channel key: xlch_ and 256 random bits in hex. The link''s Realtime topic is xlink: and this key (2782).';
revoke all on function private.new_live_link_channel_key() from public, anon, authenticated;

-- Registries -------------------------------------------------------------------------------------------------------

create table private.live_view_collections (
  collection_key text primary key,
  link_kind app.live_link_kind not null default 'View',
  share_capability text not null references app.capabilities (code),
  read_capability text not null references app.capabilities (code),
  max_rows integer not null,
  max_cues integer,
  constraint live_view_collections_key_format check (collection_key ~ '^[a-z][a-z0-9_]*(/[a-z][a-z0-9_]*)?$'),
  constraint live_view_collections_max_rows check (max_rows between 1 and 1000),
  constraint live_view_collections_max_cues check (max_cues is null or max_cues between 1 and 3000)
);

create index live_view_collections_share_capability_idx on private.live_view_collections (share_capability);
create index live_view_collections_read_capability_idx on private.live_view_collections (read_capability);

comment on table private.live_view_collections is 'Collections a live link may show (ADR 0130): the saved view collections a View link may share, and display for Display links. Who may make a link (share_capability), whose read capability the link''s creator must keep (read_capability), and the row caps.';
comment on column private.live_view_collections.collection_key is 'Saved view collection key (apps/atlas lib/views/query.ts collectionKeyFor), or display for display screens.';
comment on column private.live_view_collections.link_kind is 'View for a saved view collection; Display for display screens.';
comment on column private.live_view_collections.share_capability is 'Capability on the project that making, regenerating or revoking a link needs.';
comment on column private.live_view_collections.read_capability is 'Capability on the project the link''s creator must still hold for the link to show anything.';
comment on column private.live_view_collections.max_rows is 'Most rows a link shows: records, running orders or day sheets. A cut list carries the truncated flag.';
comment on column private.live_view_collections.max_cues is 'Most cues per running order, for collections that show cues.';

alter table private.live_view_collections enable row level security;
revoke all on private.live_view_collections from public, anon, authenticated;
grant select on private.live_view_collections to service_role;

insert into private.live_view_collections (collection_key, link_kind, share_capability, read_capability, max_rows, max_cues) values
  ('project/schedule', 'View', 'schedule.timeline.export', 'work.record.read', 500, null),
  ('project/show', 'View', 'show.run_of_show.write', 'show.run_of_show.read', 200, 300),
  ('show/run_of_show', 'View', 'show.run_of_show.write', 'show.run_of_show.read', 200, 300),
  ('show/day_sheets', 'View', 'show.day_sheet.write', 'show.run_of_show.read', 120, null),
  ('display', 'Display', 'show.run_of_show.write', 'show.run_of_show.read', 1, 300);

create table private.live_view_fields (
  collection_key text not null references private.live_view_collections (collection_key),
  field_key text not null,
  part text not null,
  source_table text not null,
  source_columns text[] not null,
  value_type text not null,
  shown boolean not null default true,
  filterable boolean not null default false,
  sortable boolean not null default false,
  groupable boolean not null default false,
  primary key (collection_key, part, field_key),
  constraint live_view_fields_key_format check (field_key ~ '^[a-z][a-z0-9_]*$'),
  constraint live_view_fields_part check (part in ('row', 'cue', 'meta')),
  constraint live_view_fields_table_format check (source_table ~ '^app\.[a-z][a-z0-9_]*$'),
  constraint live_view_fields_columns check (cardinality(source_columns) between 1 and 4),
  constraint live_view_fields_value_type check (value_type in ('text', 'number', 'date', 'instant', 'interval', 'boolean')),
  constraint live_view_fields_flags check (part = 'row' or not (filterable or sortable or groupable))
);

comment on table private.live_view_fields is 'Every field a live link may show, filter, sort or group by (ADR 0130), with the columns it reads. Anything not listed is never exposed, and a saved view that filters, sorts or groups by an unlisted field is refused instead of widened. A source column classified Confidential or Restricted is refused (live_view_field_classified), and a link whose fields are reclassified later stops (live_link_reclassified).';
comment on column private.live_view_fields.collection_key is 'Collection the field belongs to.';
comment on column private.live_view_fields.field_key is 'Key of the field in the link''s JSON and in a saved view''s filters (kind, or f.kind), sorts and grouping.';
comment on column private.live_view_fields.part is 'row for a field of a row, cue for a field of a cue in a running order, meta for the page heading (project, brand).';
comment on column private.live_view_fields.source_table is 'Table the field reads.';
comment on column private.live_view_fields.source_columns is 'Columns of the source table the field reads; each is checked against the column classification registry.';
comment on column private.live_view_fields.value_type is 'How a filter value is compared: text, number, date, instant, interval or boolean.';
comment on column private.live_view_fields.shown is 'True when the field appears in the link''s JSON; false for a sort helper such as next.';
comment on column private.live_view_fields.filterable is 'True when a saved view may filter by the field.';
comment on column private.live_view_fields.sortable is 'True when a saved view may sort by the field.';
comment on column private.live_view_fields.groupable is 'True when a saved view may group by the field.';

alter table private.live_view_fields enable row level security;
revoke all on private.live_view_fields from public, anon, authenticated;
grant select on private.live_view_fields to service_role;

create or replace function private.guard_live_view_field()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_column text;
begin
  foreach v_column in array new.source_columns loop
    if not exists (
      select 1 from pg_catalog.pg_attribute a
      where a.attrelid = to_regclass(new.source_table) and a.attname = v_column and a.attnum > 0 and not a.attisdropped
    ) then
      perform private.refuse('live_view_field_unknown', format('%s.%s is not a column.', new.source_table, v_column));
    end if;
    if exists (
      select 1 from private.column_classifications c
      where c.table_name = new.source_table and c.column_name = v_column and c.classification in ('Confidential', 'Restricted')
    ) then
      perform private.refuse('live_view_field_classified',
        format('%s.%s is classified above Internal, so no live link may show it (Section 8.3).', new.source_table, v_column));
    end if;
  end loop;
  return new;
end;
$$;

comment on function private.guard_live_view_field() is 'Live view fields: every source column exists and is Public or Internal; a Confidential or Restricted column is refused (live_view_field_classified), so a live link never exposes one.';
revoke all on function private.guard_live_view_field() from public, anon, authenticated;

create trigger t40_guard_live_view_field before insert or update on private.live_view_fields
  for each row execute function private.guard_live_view_field();

insert into private.live_view_fields
  (collection_key, field_key, part, source_table, source_columns, value_type, shown, filterable, sortable, groupable) values
  -- Schedule: the project's dated records. Never the owner, the accountable person, the blocker text, the replan
  -- reason, the XYZ tag or the URID.
  ('project/schedule', 'key', 'row', 'app.records', '{record_number}', 'text', true, false, true, false),
  ('project/schedule', 'title', 'row', 'app.records', '{title}', 'text', true, true, true, false),
  ('project/schedule', 'kind', 'row', 'app.records', '{record_kind}', 'text', true, true, false, true),
  ('project/schedule', 'subtype', 'row', 'app.records', '{record_subtype}', 'text', true, true, false, false),
  ('project/schedule', 'state', 'row', 'app.records', '{record_state}', 'text', true, true, true, true),
  ('project/schedule', 'phase', 'row', 'app.records', '{phase_code}', 'text', true, true, false, true),
  ('project/schedule', 'starts_at', 'row', 'app.records', '{starts_at}', 'instant', true, true, false, false),
  ('project/schedule', 'ends_at', 'row', 'app.records', '{ends_at}', 'instant', true, true, false, false),
  ('project/schedule', 'due_at', 'row', 'app.records', '{due_at}', 'instant', true, true, false, false),
  ('project/schedule', 'time_zone', 'row', 'app.records', '{time_zone}', 'text', true, false, false, false),
  ('project/schedule', 'scope_node', 'row', 'app.scope_nodes', '{name}', 'text', true, true, false, false),
  ('project/schedule', 'next', 'row', 'app.records', '{starts_at,due_at}', 'instant', false, false, true, false),
  -- Running orders, on the project Show tab and on Show > Run of show. Never who called a cue, its description or
  -- its cue calls.
  ('project/show', 'name', 'row', 'app.run_of_show', '{name}', 'text', true, true, true, false),
  ('project/show', 'show_date', 'row', 'app.run_of_show', '{show_date}', 'date', true, true, true, false),
  ('project/show', 'position', 'cue', 'app.cues', '{position}', 'number', true, false, false, false),
  ('project/show', 'label', 'cue', 'app.cues', '{label}', 'text', true, false, false, false),
  ('project/show', 'segment', 'cue', 'app.cues', '{segment}', 'text', true, false, false, false),
  ('project/show', 'planned_at', 'cue', 'app.cues', '{planned_at}', 'instant', true, false, false, false),
  ('project/show', 'duration_seconds', 'cue', 'app.cues', '{duration}', 'number', true, false, false, false),
  ('project/show', 'called_at', 'cue', 'app.cues', '{called_at}', 'instant', true, false, false, false),
  ('show/run_of_show', 'name', 'row', 'app.run_of_show', '{name}', 'text', true, true, true, false),
  ('show/run_of_show', 'show_date', 'row', 'app.run_of_show', '{show_date}', 'date', true, true, true, false),
  ('show/run_of_show', 'position', 'cue', 'app.cues', '{position}', 'number', true, false, false, false),
  ('show/run_of_show', 'label', 'cue', 'app.cues', '{label}', 'text', true, false, false, false),
  ('show/run_of_show', 'segment', 'cue', 'app.cues', '{segment}', 'text', true, false, false, false),
  ('show/run_of_show', 'planned_at', 'cue', 'app.cues', '{planned_at}', 'instant', true, false, false, false),
  ('show/run_of_show', 'duration_seconds', 'cue', 'app.cues', '{duration}', 'number', true, false, false, false),
  ('show/run_of_show', 'called_at', 'cue', 'app.cues', '{called_at}', 'instant', true, false, false, false),
  -- Day sheets: published ones only, the body as plain text.
  ('show/day_sheets', 'day', 'row', 'app.day_sheets', '{day}', 'date', true, true, true, false),
  ('show/day_sheets', 'body', 'row', 'app.day_sheets', '{body}', 'text', true, false, false, false),
  ('show/day_sheets', 'published_at', 'row', 'app.day_sheets', '{published_at}', 'instant', true, false, false, false),
  -- Display screens: the running order and its cues.
  ('display', 'name', 'row', 'app.run_of_show', '{name}', 'text', true, false, false, false),
  ('display', 'show_date', 'row', 'app.run_of_show', '{show_date}', 'date', true, false, false, false),
  ('display', 'position', 'cue', 'app.cues', '{position}', 'number', true, false, false, false),
  ('display', 'label', 'cue', 'app.cues', '{label}', 'text', true, false, false, false),
  ('display', 'segment', 'cue', 'app.cues', '{segment}', 'text', true, false, false, false),
  ('display', 'planned_at', 'cue', 'app.cues', '{planned_at}', 'instant', true, false, false, false),
  ('display', 'duration_seconds', 'cue', 'app.cues', '{duration}', 'number', true, false, false, false),
  ('display', 'called_at', 'cue', 'app.cues', '{called_at}', 'instant', true, false, false, false);

-- Every link's heading: the project's name and zone, and the org brand's Public columns.
insert into private.live_view_fields (collection_key, field_key, part, source_table, source_columns, value_type)
select c.collection_key, m.field_key, 'meta', m.source_table, m.source_columns, 'text'
from private.live_view_collections c
cross join (values
  ('project_name', 'app.projects', '{name}'::text[]),
  ('time_zone', 'app.projects', '{time_zone}'::text[]),
  ('brand_name', 'app.org_brands', '{display_name}'::text[]),
  ('brand_logo_light_path', 'app.org_brands', '{logo_light_path}'::text[]),
  ('brand_logo_dark_path', 'app.org_brands', '{logo_dark_path}'::text[]),
  ('brand_accent_hex', 'app.org_brands', '{accent_hex}'::text[]),
  ('brand_suppress_powered_by', 'app.org_brands', '{suppress_powered_by}'::text[])
) as m (field_key, source_table, source_columns);

-- Live links -------------------------------------------------------------------------------------------------------

create table app.live_links (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  project_id uuid not null references app.projects (id),
  link_kind app.live_link_kind not null,
  saved_view_id uuid references app.saved_views (id),
  run_of_show_id uuid references app.run_of_show (id),
  default_mode app.display_mode,
  token_hash bytea not null,
  token_hint text not null,
  access_code_hash bytea not null,
  note text,
  expires_at timestamptz not null,
  failed_attempts smallint not null default 0,
  open_count integer not null default 0,
  last_opened_at timestamptz,
  rotated_at timestamptz,
  revoked_at timestamptz,
  revoked_by uuid references app.people (id),
  constraint live_links_subject check (
    (link_kind = 'View' and saved_view_id is not null and run_of_show_id is null and default_mode is null)
    or (link_kind = 'Display' and run_of_show_id is not null and saved_view_id is null and default_mode is not null)),
  constraint live_links_token_hash_length check (octet_length(token_hash) = 32),
  constraint live_links_code_hash_length check (octet_length(access_code_hash) = 32),
  constraint live_links_token_hint check (token_hint ~ '^[0-9a-f]{4}$'),
  constraint live_links_note_length check (note is null or char_length(btrim(note)) between 1 and 200),
  constraint live_links_failed_attempts check (failed_attempts between 0 and 5),
  constraint live_links_open_count check (open_count >= 0),
  constraint live_links_revoked check ((revoked_at is null) = (revoked_by is null))
);

create unique index live_links_token_key on app.live_links (token_hash);
create index live_links_saved_view_idx on app.live_links (saved_view_id);
create index live_links_run_of_show_idx on app.live_links (run_of_show_id);
create index live_links_revoked_by_idx on app.live_links (revoked_by);

-- Revoking a link withdraws access, so it stays possible while a canceled org is read-only (Section 14.7). The row
-- goes in before install_domain_table, whose read-only guard installer skips an exempt table (1063); the RPCs refuse
-- new links and regeneration in that window themselves.
insert into private.read_only_exempt_tables (table_name, rationale) values
  ('app.live_links', 'Revoking a live link withdraws access; new links and regeneration are refused by the live link RPCs.')
on conflict (table_name) do nothing;

-- A Display link's project is its running order's, stamped before the org is derived from it (t10).
create or replace function private.stamp_live_link_project()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.link_kind = 'Display' then
    new.project_id := (select r.project_id from app.run_of_show r where r.id = new.run_of_show_id);
  end if;
  return new;
end;
$$;

comment on function private.stamp_live_link_project() is 'Before insert or update on live links: a Display link''s project is its running order''s project, as a cue''s is (0412).';
revoke all on function private.stamp_live_link_project() from public, anon, authenticated;

create trigger t05_stamp_live_link_project before insert or update on app.live_links
  for each row execute function private.stamp_live_link_project();

call private.install_domain_table('app.live_links', 'app.projects', 'project_id',
  array['app.saved_views', 'saved_view_id', 'app.run_of_show', 'run_of_show_id']);
call private.describe('app.live_links', 'Live links (ADR 0130): a no-account link to one saved view of a project, or to one running order on a display screen (room clock, presenter timer, backstage), that updates while it is open. Every link has an expiry within 90 days and an access code; the token and the code are returned once and stored only as hashes. Made by app.create_view_link and app.create_display_link, opened by api_public.open_live_link, read by api_public.live_view and api_public.live_display, and changed only by app.regenerate_live_link and app.revoke_live_link. app.live_link_states gives each link''s state.', array[
  'project_id', 'Project the link shows. For a View link the creator picks it; for a Display link it is the running order''s project, stamped by the database.',
  'link_kind', 'View (a saved view) or Display (a running order on a display screen).',
  'saved_view_id', 'Saved view a View link shows; its filters, sorts, grouping and search are read at every view.',
  'run_of_show_id', 'Running order a Display link shows.',
  'default_mode', 'Mode a display screen opens in: Room Clock, Presenter Timer or Backstage. Null for a View link.',
  'token_hash', 'SHA-256 of the link token, set by the database. The token is shown once and never stored. Never readable by signed-in callers.',
  'token_hint', 'Last four characters of the token, to tell links apart.',
  'access_code_hash', 'SHA-256 of the token, a colon and the 6-digit access code, set by the database. Every link has a code. Never readable by signed-in callers.',
  'note', 'What the link is for, as its creator described it. Never shown on the public page.',
  'expires_at', 'When the link stops opening: after it was made and at most 90 days ahead.',
  'failed_attempts', 'Wrong access codes entered since the link was made or regenerated; the link locks at 5.',
  'open_count', 'Successful opens (a correct code), counted on the link.',
  'last_opened_at', 'When the link was last opened successfully.',
  'rotated_at', 'When the link was last regenerated; the previous token, code and device grants stopped working then.',
  'revoked_at', 'When the link was revoked; a revoked link never opens again.',
  'revoked_by', 'Person who revoked the link.'
]);
call private.install_audit_trail('app.live_links');

-- Live links of a project or a running order, for the ping triggers (2782) and the per-subject limit. deleted_at
-- comes from install_domain_table.
create index live_links_project_live_idx on app.live_links (project_id) where revoked_at is null and deleted_at is null;
create index live_links_run_of_show_live_idx on app.live_links (run_of_show_id) where revoked_at is null and deleted_at is null;
call private.install_default_retention('app.live_links', interval '2 years');

-- Signed-in callers read the links of projects where they hold the collection's read capability, in their own orgs,
-- without the hashes. Writes go through the RPCs only.
create or replace function private.live_link_collection_key(p_link_kind app.live_link_kind, p_saved_view_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case p_link_kind
    when 'Display' then 'display'
    else (select v.collection_key from app.saved_views v where v.id = p_saved_view_id)
  end;
$$;

comment on function private.live_link_collection_key(app.live_link_kind, uuid) is 'Collection a live link shows: display for a Display link, else its saved view''s collection key.';
revoke all on function private.live_link_collection_key(app.live_link_kind, uuid) from public, anon;
grant execute on function private.live_link_collection_key(app.live_link_kind, uuid) to authenticated, service_role;

create or replace function private.can_read_live_link(p_org_id uuid, p_project_id uuid, p_link_kind app.live_link_kind, p_saved_view_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.is_member(p_org_id) and coalesce((
    select private.can_on_project(p_project_id, c.read_capability)
    from private.live_view_collections c
    where c.collection_key = private.live_link_collection_key(p_link_kind, p_saved_view_id)), false);
$$;

comment on function private.can_read_live_link(uuid, uuid, app.live_link_kind, uuid) is 'True when the signed-in person is a member of the link''s org and holds its collection''s read capability on the project (show.run_of_show.read for a display screen).';
revoke all on function private.can_read_live_link(uuid, uuid, app.live_link_kind, uuid) from public, anon;
grant execute on function private.can_read_live_link(uuid, uuid, app.live_link_kind, uuid) to authenticated, service_role;

call private.install_policies('app.live_links',
  $$private.can_read_live_link(org_id, project_id, link_kind, saved_view_id)$$);
revoke select on app.live_links from authenticated;
grant select (id, org_id, project_id, link_kind, saved_view_id, run_of_show_id, default_mode, token_hint, note, expires_at,
  failed_attempts, open_count, last_opened_at, rotated_at, revoked_at, revoked_by, created_at, created_by, updated_at,
  updated_by, deleted_at) on app.live_links to authenticated;
revoke insert, update, delete on app.live_links from authenticated;

-- Defense in depth behind the grants: even the service role changes a link only inside the RPCs.
create or replace function private.guard_live_link()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.in_trusted_operation('live_link_service') then
    perform private.refuse('live_link_immutable', 'A live link is made, opened, regenerated and revoked only through its RPCs.');
  end if;
  if tg_op = 'UPDATE' and (new.link_kind <> old.link_kind or new.saved_view_id is distinct from old.saved_view_id
     or new.run_of_show_id is distinct from old.run_of_show_id or new.project_id <> old.project_id) then
    perform private.refuse('live_link_immutable', 'A live link keeps what it shows; make a new link instead.');
  end if;
  if tg_op = 'UPDATE' and old.revoked_at is not null and new.revoked_at is distinct from old.revoked_at then
    perform private.refuse('live_link_revoked', 'A revoked live link stays revoked. Make a new link instead.');
  end if;
  return new;
end;
$$;

comment on function private.guard_live_link() is 'Live links: rows are inserted and changed only inside the live link RPCs (trusted operation live_link_service); a link keeps its kind, subject and project, and a revoked link stays revoked.';
revoke all on function private.guard_live_link() from public, anon, authenticated;

create trigger t40_guard_live_link before insert or update on app.live_links
  for each row execute function private.guard_live_link();

-- Computed state, never stored.
create view app.live_link_states with (security_invoker = true) as
select l.id,
  case
    when l.revoked_at is not null then 'Revoked'
    when l.expires_at <= now() then 'Expired'
    when l.failed_attempts >= 5 then 'Locked'
    else 'Active'
  end as link_state
from app.live_links l
where l.deleted_at is null;

comment on view app.live_link_states is 'State of each live link, computed when read (ADR 0130): Revoked once revoked, else Expired past its expiry, else Locked after 5 wrong access codes, else Active.';
comment on column app.live_link_states.id is 'Live link.';
comment on column app.live_link_states.link_state is 'Active, Locked, Expired or Revoked.';
revoke all on app.live_link_states from public, anon;
grant select on app.live_link_states to authenticated, service_role;
revoke select on app.live_link_states from xos_backup;

-- Private state: channel keys, device grants and retired tokens -----------------------------------------------------

create table private.live_link_channels (
  live_link_id uuid primary key references app.live_links (id),
  channel_key text not null,
  created_at timestamptz not null default now(),
  constraint live_link_channels_key_format check (channel_key ~ '^xlch_[0-9a-f]{64}$')
);

create unique index live_link_channels_key on private.live_link_channels (channel_key);

comment on table private.live_link_channels is 'Each live link''s Realtime channel key (ADR 0130, 2782). The link''s anonymous page joins xlink:<key>, which only the database sends to; regenerating a link draws a new key.';
comment on column private.live_link_channels.live_link_id is 'Live link.';
comment on column private.live_link_channels.channel_key is 'xlch_ and 256 random bits in hex; handed to the page only after the access code and a valid device grant.';
comment on column private.live_link_channels.created_at is 'When the key was drawn.';

alter table private.live_link_channels enable row level security;
revoke all on private.live_link_channels from public, anon, authenticated;
grant select on private.live_link_channels to service_role;

create table private.live_link_grants (
  grant_hash bytea primary key,
  live_link_id uuid not null references app.live_links (id),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  constraint live_link_grants_hash_length check (octet_length(grant_hash) = 32)
);

create index live_link_grants_link_idx on private.live_link_grants (live_link_id);
create index live_link_grants_expires_idx on private.live_link_grants (expires_at);

comment on table private.live_link_grants is 'Device grants (ADR 0130): a correct access code earns the browser a grant, kept in an HttpOnly cookie, that carries its later reads of the link without the code, until the link expires or 7 days pass. Regenerating or revoking the link deletes every grant. Only the SHA-256 of the grant is stored.';
comment on column private.live_link_grants.grant_hash is 'SHA-256 of the grant (xlgr_ and 256 random bits in hex).';
comment on column private.live_link_grants.live_link_id is 'Live link the grant opens.';
comment on column private.live_link_grants.expires_at is 'When the grant stops working: the link''s expiry or 7 days after the open, whichever comes first.';
comment on column private.live_link_grants.created_at is 'When the grant was issued.';

alter table private.live_link_grants enable row level security;
revoke all on private.live_link_grants from public, anon, authenticated;
grant select on private.live_link_grants to service_role;

create table private.retired_live_link_tokens (
  token_hash bytea primary key,
  retired_at timestamptz not null default now(),
  constraint retired_live_link_tokens_hash_length check (octet_length(token_hash) = 32)
);

create index retired_live_link_tokens_retired_idx on private.retired_live_link_tokens (retired_at);

comment on table private.retired_live_link_tokens is 'SHA-256 hashes of live link tokens that were regenerated away or revoked, kept a year so a screen still polling a dead link is answered live_link_invalid without counting as a failed guess against its address (as 1410).';
comment on column private.retired_live_link_tokens.token_hash is 'SHA-256 of the retired token.';
comment on column private.retired_live_link_tokens.retired_at is 'When the token was regenerated away or revoked.';

alter table private.retired_live_link_tokens enable row level security;
revoke all on private.retired_live_link_tokens from public, anon, authenticated;
grant select on private.retired_live_link_tokens to service_role;

select cron.schedule('xos_prune_live_link_tokens', '43 4 * * *', $$
  delete from private.retired_live_link_tokens where retired_at < now() - interval '1 year';
  delete from private.live_link_grants where expires_at < now() - interval '1 day';
$$);

-- Saved view support ------------------------------------------------------------------------------------------------
-- A saved view keeps its page's query (apps/atlas lib/views/query.ts): page parameters with eq (kind and state hold
-- comma-separated lists, read as in), f.<field> conditions with eq, ne, lt, lte, gt, gte, contains or is_null, and
-- cf.<key> custom field conditions. A link applies a page parameter or an f.<field> condition only on a filterable
-- allowlisted field, refuses any cf.* condition (custom fields are out of scope), and ignores month (a calendar's
-- anchor) and live (show mode), which are not filters. A project parameter is allowed only when it names the link's
-- own project.

create or replace function private.live_view_filters(p_saved_view_id uuid, p_project_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_view app.saved_views;
  v_project_key text;
  v_filter record;
  v_field private.live_view_fields;
  v_key text;
  v_operator text;
  v_out jsonb := '[]'::jsonb;
begin
  select * into v_view from app.saved_views v where v.id = p_saved_view_id and v.deleted_at is null;
  if v_view.id is null then
    return null;
  end if;
  select p.project_key into v_project_key from app.projects p where p.id = p_project_id;
  for v_filter in
    select f.field, f.operator::text as operator, f.value_text from app.saved_view_filters f
    where f.saved_view_id = p_saved_view_id and f.deleted_at is null
    order by f.created_at, f.id
  loop
    if v_filter.field in ('month', 'live') then
      continue;
    end if;
    if v_filter.field like 'cf.%' then
      return null;
    end if;
    if v_filter.field = 'project' then
      if v_filter.operator <> 'eq' or v_filter.value_text is distinct from v_project_key then
        return null;
      end if;
      continue;
    end if;
    if v_filter.field like 'f.%' then
      v_key := substr(v_filter.field, 3);
      v_operator := v_filter.operator;
      if v_operator not in ('eq', 'ne', 'lt', 'lte', 'gt', 'gte', 'contains', 'is_null') then
        return null;
      end if;
    else
      v_key := v_filter.field;
      if v_filter.operator <> 'eq' then
        return null;
      end if;
      -- A page parameter is a comma-separated list (listParam in components/work/load.ts).
      v_operator := 'in';
    end if;
    select * into v_field from private.live_view_fields f
    where f.collection_key = v_view.collection_key and f.field_key = v_key and f.part = 'row' and f.filterable;
    if v_field.field_key is null then
      return null;
    end if;
    v_out := v_out || jsonb_build_object('key', v_key, 'operator', v_operator, 'value', coalesce(v_filter.value_text, 'true'),
      'type', v_field.value_type);
  end loop;
  return v_out;
end;
$$;

comment on function private.live_view_filters(uuid, uuid) is 'The filters a live link applies for a saved view on a project, as a JSON list of key, operator, value and type, or null when the view cannot be shown: a cf.* condition, a filter on a field the allowlist does not mark filterable, an operator the field does not take, or a project parameter naming another project. month and live are ignored.';
revoke all on function private.live_view_filters(uuid, uuid) from public, anon, authenticated;

create or replace function private.live_view_supported(p_saved_view_id uuid, p_project_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.live_view_filters(p_saved_view_id, p_project_id) is not null
    and exists (
      select 1 from app.saved_views v
      join private.live_view_collections c on c.collection_key = v.collection_key and c.link_kind = 'View'
      where v.id = p_saved_view_id and v.deleted_at is null
        and (v.group_by_field is null or exists (
          select 1 from private.live_view_fields f
          where f.collection_key = v.collection_key and f.field_key = v.group_by_field and f.groupable))
        and not exists (
          select 1 from app.saved_view_sorts s
          where s.saved_view_id = v.id and s.deleted_at is null
            and not exists (
              select 1 from private.live_view_fields f
              where f.collection_key = v.collection_key and f.field_key = s.field and f.sortable)));
$$;

comment on function private.live_view_supported(uuid, uuid) is 'True when a live link can show the saved view on the project without widening it: its collection is allowlisted, every filter applies (private.live_view_filters), every sort field is sortable and its grouping, if any, groupable.';
revoke all on function private.live_view_supported(uuid, uuid) from public, anon, authenticated;

-- Default expiry of a display screen: the end of the day after the show, in the project's zone (the org's
-- locale.time_zone, then UTC, as 1410 does), at most 90 days ahead; a show already past gets a day from now.
create or replace function private.live_display_default_expiry(p_run_of_show_id uuid)
returns timestamptz
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_show_date date;
  v_zone text;
begin
  select r.show_date, coalesce(nullif(btrim(p.time_zone), ''), private.calendar_feed_setting(r.org_id, null, 'locale.time_zone'), 'UTC')
  into v_show_date, v_zone
  from app.run_of_show r join app.projects p on p.id = r.project_id
  where r.id = p_run_of_show_id;
  if v_show_date is null then
    return null;
  end if;
  if v_show_date < private.zone_today(v_zone) then
    return now() + interval '1 day';
  end if;
  return least(private.calendar_feed_day_start(v_show_date + 2, v_zone), now() + interval '90 days');
end;
$$;

comment on function private.live_display_default_expiry(uuid) is 'Default expiry of a display screen link: the end of the day after the show day in the project''s zone (else the org''s locale.time_zone, else UTC), at most 90 days ahead; a show day already past gets now plus one day.';
revoke all on function private.live_display_default_expiry(uuid) from public, anon, authenticated;

-- Making links ------------------------------------------------------------------------------------------------------

insert into private.domain_event_types (code, subject, description) values
  ('live_link.created', 'live_links', 'A live link to a saved view or a display screen was made.'),
  ('live_link.regenerated', 'live_links', 'A live link was regenerated: a new token and access code, and every device grant dropped.'),
  ('live_link.revoked', 'live_links', 'A live link was revoked.')
on conflict (code) do nothing;

-- Shared by both create RPCs: the expiry rule, the read-only check, the insert and its channel key and event.
create or replace function private.insert_live_link(
  p_kind app.live_link_kind,
  p_org_id uuid,
  p_project_id uuid,
  p_saved_view_id uuid,
  p_run_of_show_id uuid,
  p_default_mode app.display_mode,
  p_expires_at timestamptz,
  p_note text
)
returns table (live_link_id uuid, token text, access_code text, expires_at timestamptz)
language plpgsql
volatile
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_token text := private.new_live_link_token(p_kind);
  v_code text := private.new_live_link_code();
  v_id uuid;
begin
  if private.org_read_only(p_org_id) then
    perform private.refuse('org_read_only', 'This organization is canceled and read-only. The Owner can reactivate it in Settings, Danger zone, during the 30 days.');
  end if;
  if p_expires_at is null then
    perform private.refuse('live_link_expiry', 'A live link needs an expiry date (Section 8.6: Internal links expire).');
  end if;
  if p_expires_at <= now() or p_expires_at > now() + interval '90 days' then
    perform private.refuse('live_link_expiry_range', 'A live link expires after now and within 90 days.');
  end if;
  perform private.begin_trusted_operation('live_link_service');
  insert into app.live_links as l (project_id, link_kind, saved_view_id, run_of_show_id, default_mode, token_hash, token_hint,
    access_code_hash, note, expires_at)
  values (p_project_id, p_kind, p_saved_view_id, p_run_of_show_id, p_default_mode, private.share_token_hash(v_token),
    right(v_token, 4), private.share_code_hash(v_token, v_code), nullif(btrim(coalesce(p_note, '')), ''), p_expires_at)
  returning l.id into v_id;
  perform private.end_trusted_operation('live_link_service');
  insert into private.live_link_channels (live_link_id, channel_key) values (v_id, private.new_live_link_channel_key());
  perform private.emit_event(p_org_id, 'live_link.created', 'live_links', v_id, p_project_id,
    jsonb_build_object('link_kind', p_kind, 'saved_view_id', p_saved_view_id, 'run_of_show_id', p_run_of_show_id,
      'expires_at', p_expires_at));
  return query select v_id, v_token, v_code, p_expires_at;
end;
$$;

comment on function private.insert_live_link(app.live_link_kind, uuid, uuid, uuid, uuid, app.display_mode, timestamptz, text) is 'Makes a live link once the calling RPC has checked who may: refuses a read-only org and an expiry that is missing, past or more than 90 days ahead, draws the token, the access code and the channel key, stores only the hashes, emits live_link.created and returns the token and code once.';
revoke all on function private.insert_live_link(app.live_link_kind, uuid, uuid, uuid, uuid, app.display_mode, timestamptz, text) from public, anon, authenticated;

create or replace function app.create_view_link(
  p_saved_view_id uuid,
  p_project_id uuid,
  p_expires_at timestamptz default null,
  p_note text default null
)
returns table (live_link_id uuid, token text, access_code text, expires_at timestamptz)
language plpgsql
volatile
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_view app.saved_views;
  v_project app.projects;
  v_collection private.live_view_collections;
begin
  perform private.require_person();
  select * into v_view from app.saved_views v
  where v.id = p_saved_view_id and v.id in (select private.readable_saved_view_ids());
  if v_view.id is null then
    raise exception using errcode = '42501', message = 'saved view not found';
  end if;
  select * into v_project from app.projects p where p.id = p_project_id and p.deleted_at is null and p.org_id = v_view.org_id;
  -- Only members of the project's org publish its data: a partner org reaching it through a project share never does.
  if v_project.id is null or not private.is_member(v_project.org_id) then
    raise exception using errcode = '42501', message = 'project not found';
  end if;
  select * into v_collection from private.live_view_collections c
  where c.collection_key = v_view.collection_key and c.link_kind = 'View';
  if v_collection.collection_key is null or not private.live_view_supported(v_view.id, v_project.id) then
    perform private.refuse('live_link_view_unsupported', 'This view cannot be shared live: its page, or one of its filters, sorts or groupings, is not one a live link shows.');
  end if;
  if not private.can_on_project(v_project.id, v_collection.share_capability) then
    perform private.refuse('live_link_capability', format('Sharing this view live needs %s on the project.', v_collection.share_capability));
  end if;
  if (select count(*) from app.live_links l
      where l.saved_view_id = v_view.id and l.revoked_at is null and l.deleted_at is null and l.expires_at > now()) >= 20 then
    perform private.refuse('live_link_limit', 'This view has 20 live links. Revoke one before you add another.');
  end if;
  return query select * from private.insert_live_link('View', v_project.org_id, v_project.id, v_view.id, null, null,
    p_expires_at, p_note);
end;
$$;

comment on function app.create_view_link(uuid, uuid, timestamptz, text) is 'Makes a live link to a saved view the caller can read, on one project of its org (ADR 0130). Needs membership of the org, an allowlisted collection whose filters, sorts and grouping the link can show (live_link_view_unsupported), the collection''s share capability on the project (live_link_capability), an org that is not read-only, an expiry after now and within 90 days, and fewer than 20 live links on the view. Returns the token and the 6-digit access code once; only their hashes are kept.';
revoke all on function app.create_view_link(uuid, uuid, timestamptz, text) from public, anon;
grant execute on function app.create_view_link(uuid, uuid, timestamptz, text) to authenticated, service_role;

create or replace function app.create_display_link(
  p_run_of_show_id uuid,
  p_expires_at timestamptz default null,
  p_default_mode app.display_mode default 'Backstage',
  p_note text default null
)
returns table (live_link_id uuid, token text, access_code text, expires_at timestamptz)
language plpgsql
volatile
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_run app.run_of_show;
begin
  perform private.require_person();
  select * into v_run from app.run_of_show r where r.id = p_run_of_show_id and r.deleted_at is null;
  if v_run.id is null or not private.is_member(v_run.org_id)
     or v_run.project_id not in (select private.project_ids_with('show.run_of_show.read')) then
    raise exception using errcode = '42501', message = 'running order not found';
  end if;
  if not private.can_on_project(v_run.project_id, 'show.run_of_show.write') then
    perform private.refuse('live_link_capability', 'Display screens need show.run_of_show.write on the project.');
  end if;
  if (select count(*) from app.live_links l
      where l.run_of_show_id = v_run.id and l.revoked_at is null and l.deleted_at is null and l.expires_at > now()) >= 20 then
    perform private.refuse('live_link_limit', 'This running order has 20 live links. Revoke one before you add another.');
  end if;
  return query select * from private.insert_live_link('Display', v_run.org_id, v_run.project_id, null, v_run.id,
    coalesce(p_default_mode, 'Backstage'), coalesce(p_expires_at, private.live_display_default_expiry(v_run.id)), p_note);
end;
$$;

comment on function app.create_display_link(uuid, timestamptz, app.display_mode, text) is 'Makes a display screen link to a running order (ADR 0130): needs membership of its org and show.run_of_show.write on the project (live_link_capability), an org that is not read-only, an expiry after now and within 90 days (by default the end of the day after the show in the project''s zone), and fewer than 20 live links on the running order. Returns the token and the 6-digit access code once; only their hashes are kept.';
revoke all on function app.create_display_link(uuid, timestamptz, app.display_mode, text) from public, anon;
grant execute on function app.create_display_link(uuid, timestamptz, app.display_mode, text) to authenticated, service_role;

-- Regenerating and revoking -------------------------------------------------------------------------------------------

-- The link, locked, when the signed-in person may regenerate or revoke it: a member of its org who made it or holds
-- the collection's share capability on the project. Anyone else is told it does not exist.
create or replace function private.manageable_live_link(p_live_link_id uuid)
returns app.live_links
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
  v_link app.live_links;
begin
  select * into v_link from app.live_links l where l.id = p_live_link_id and l.deleted_at is null for update;
  if v_link.id is null or not private.is_member(v_link.org_id)
     or (v_link.created_by is distinct from v_person and not coalesce((
       select private.can_on_project(v_link.project_id, c.share_capability) from private.live_view_collections c
       where c.collection_key = private.live_link_collection_key(v_link.link_kind, v_link.saved_view_id)), false)) then
    raise exception using errcode = '42501', message = 'live link not found';
  end if;
  return v_link;
end;
$$;

comment on function private.manageable_live_link(uuid) is 'Locks and returns a live link the signed-in person may regenerate or revoke: a member of its org who made it or holds its collection''s share capability on the project; otherwise raises live link not found.';
revoke all on function private.manageable_live_link(uuid) from public, anon, authenticated;

create or replace function app.regenerate_live_link(p_live_link_id uuid)
returns table (token text, access_code text, expires_at timestamptz)
language plpgsql
volatile
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_link app.live_links := private.manageable_live_link(p_live_link_id);
  v_token text := private.new_live_link_token(v_link.link_kind);
  v_code text := private.new_live_link_code();
begin
  if v_link.revoked_at is not null then
    perform private.refuse('live_link_revoked', 'A revoked live link stays revoked. Make a new link instead.');
  end if;
  if private.org_read_only(v_link.org_id) then
    perform private.refuse('org_read_only', 'This organization is canceled and read-only. The Owner can reactivate it in Settings, Danger zone, during the 30 days.');
  end if;
  insert into private.retired_live_link_tokens (token_hash) values (v_link.token_hash) on conflict do nothing;
  perform private.begin_trusted_operation('live_link_service');
  update app.live_links
  set token_hash = private.share_token_hash(v_token), token_hint = right(v_token, 4),
    access_code_hash = private.share_code_hash(v_token, v_code), failed_attempts = 0, rotated_at = now()
  where id = v_link.id;
  perform private.end_trusted_operation('live_link_service');
  update private.live_link_channels set channel_key = private.new_live_link_channel_key(), created_at = now()
  where live_link_id = v_link.id;
  delete from private.live_link_grants g where g.live_link_id = v_link.id;
  perform private.emit_event(v_link.org_id, 'live_link.regenerated', 'live_links', v_link.id, v_link.project_id,
    jsonb_build_object('link_kind', v_link.link_kind));
  return query select v_token, v_code, v_link.expires_at;
end;
$$;

comment on function app.regenerate_live_link(uuid) is 'Regenerates a live link (ADR 0130): its creator, or a holder of the collection''s share capability on the project, gets a new token and access code once. The old token is retired (it answers live_link_invalid without counting a failure), the channel key is redrawn, wrong-code attempts reset and every device grant is dropped. Refused for a revoked link and in a read-only org.';
revoke all on function app.regenerate_live_link(uuid) from public, anon;
grant execute on function app.regenerate_live_link(uuid) to authenticated, service_role;

create or replace function app.revoke_live_link(p_live_link_id uuid)
returns timestamptz
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
  v_link app.live_links := private.manageable_live_link(p_live_link_id);
begin
  if v_link.revoked_at is not null then
    return v_link.revoked_at;
  end if;
  insert into private.retired_live_link_tokens (token_hash) values (v_link.token_hash) on conflict do nothing;
  perform private.begin_trusted_operation('live_link_service');
  update app.live_links set revoked_at = now(), revoked_by = v_person where id = v_link.id;
  perform private.end_trusted_operation('live_link_service');
  delete from private.live_link_grants g where g.live_link_id = v_link.id;
  perform private.emit_event(v_link.org_id, 'live_link.revoked', 'live_links', v_link.id, v_link.project_id,
    jsonb_build_object('link_kind', v_link.link_kind));
  return now();
end;
$$;

comment on function app.revoke_live_link(uuid) is 'Revokes a live link so it never opens again (ADR 0130): its creator, or a holder of the collection''s share capability on the project, may. Retires the token and drops every device grant. Idempotent: a revoked link answers its first revocation time. Allowed in a read-only org, since it withdraws access.';
revoke all on function app.revoke_live_link(uuid) from public, anon;
grant execute on function app.revoke_live_link(uuid) to authenticated, service_role;

-- Trash (ADR 0110) ----------------------------------------------------------------------------------------------------

insert into private.trash_excluded_tables (table_name, rationale) values
  ('live_links', 'A revoked or regenerated link never opens again; a new link is made instead.')
on conflict (table_name) do nothing;

select private.sync_trash_tables();

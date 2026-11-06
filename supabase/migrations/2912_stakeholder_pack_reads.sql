-- 2912_stakeholder_pack_reads.sql
-- B2 (RRR-226, ADR 0141). The anonymous side of stakeholder packs (2910): token RPCs in the sense of Section 7.5
-- invariant 8, as ADR 0033 decision 56 words it. Each needs a token and, to open, the recipient's access code; links
-- expire; failures are rate limited; and each answers only the fields the page renders. Execute is granted to anon.
--   * A recipient's emailed link (xpkl_, 2913) opens the pack with their 6-digit code, as P1's open_live_link opens a
--     link: a read-only (GET) call is refused first, then the per-address failure limit (pack_link.failure, 20 per
--     relayed address in 10 minutes) and the hop limit (pack_link.hop_failure, 2000 per reaching address in 15
--     minutes), then the link and the recipient are locked before the code is compared, and 5 wrong codes lock the
--     recipient until the team resets the code. A token never seen counts as a failure; a link superseded by a later
--     email does not.
--   * A correct code earns a device grant (xpkg_), which the Atlas route keeps in an HttpOnly cookie that holds up to
--     8 grants, so a device that opens several packs keeps each. Next week's emailed link opens on that device with the
--     grant and no code, and the open swaps the grant for a fresh one. A grant expires at the earliest of 7 days, the
--     link's expiry and the pack's; every read also checks the pack's expiry and the revocation of the pack and the
--     recipient. The address limits apply only to a call without a valid grant; reads are limited per grant
--     (pack_link.fetch, 600 an hour).
--   * api_public.stakeholder_pack answers the brand's Public columns, the project's name and zone, the pack's name,
--     message and expiry, the recipient's own name and the items; never the note, other recipients, emails or
--     attachment ids. api_public.stakeholder_pack_item shows a live item with P1's payload (2911), read as the live
--     link's creator, which P1's rule 3 makes the deliberate exception, and also counts against the link's own
--     ceiling (live_link.link_fetch). api_public.stakeholder_pack_file issues a 2-minute download ticket for a file
--     item's current clean version. api_public.sign_stakeholder_pack_item records a typed-name acknowledgement once.
--   * api_public.unsubscribe_stakeholder_pack (Atlas's confirm page) and app.unsubscribe_pack_by_token (the
--     email-unsubscribe Edge Function, RFC 8058 one-click) stop a recipient's emails through one private function. The
--     pack still opens. The address also goes on the org's app.suppression_list (0520), so the org's other packs stop
--     mailing it too; private.pack_email_suppressed reads that list with B8's rule.
--   * Download tickets gain a stakeholder pack recipient source, and app.consume_file_download_ticket (latest 2041)
--     answers nothing for a pack ticket once the pack or recipient is revoked, the pack has expired or the file was
--     raised above Internal. Tickets gain org_id, stamped from the attachment version, so deleting the org takes them.
-- Packs keep opening and reading in a read-only org, as P1 links do; stakeholder_pack_events is exempt from the
-- read-only guard (2910).

-- Shared helpers -------------------------------------------------------------------------------------------------------

create or replace function private.pack_link_rate_limited(p_hop text, p_subject text)
returns boolean
language sql
volatile
security definer
set search_path = ''
as $$
  select private.rate_limit_exceeded('pack_link.failure', p_subject, 20, interval '10 minutes')
    or private.rate_limit_exceeded('pack_link.hop_failure', p_hop, 2000, interval '15 minutes');
$$;

comment on function private.pack_link_rate_limited(text, text) is 'True when an address used up its stakeholder pack failures: 20 per relayed address in 10 minutes, or 2000 per reaching address in 15 minutes. Refuses a read-only transaction first, as every failure count does (A69-001).';
revoke all on function private.pack_link_rate_limited(text, text) from public, anon, authenticated;

create or replace function private.note_pack_link_failure(p_hop text, p_subject text)
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  select private.note_rate_event('pack_link.failure', p_subject);
  select private.note_rate_event('pack_link.hop_failure', p_hop);
$$;

comment on function private.note_pack_link_failure(text, text) is 'Counts one failed stakeholder pack lookup or wrong code against the relayed and the reaching address.';
revoke all on function private.note_pack_link_failure(text, text) from public, anon, authenticated;

-- The first of up to 8 grants the device sent that is the recipient's and still valid.
create or replace function private.stakeholder_pack_grant(p_grants text[], p_recipient_id uuid)
returns bytea
language sql
stable
security definer
set search_path = ''
as $$
  select g.grant_hash
  from unnest((coalesce(p_grants, '{}'::text[]))[1:8]) with ordinality as x (value, n)
  join private.stakeholder_pack_grants g on g.grant_hash = private.share_token_hash(x.value)
  where x.value ~ '^xpkg_[0-9a-f]{64}$' and g.recipient_id = p_recipient_id and g.expires_at > now()
  order by x.n
  limit 1;
$$;

comment on function private.stakeholder_pack_grant(text[], uuid) is 'Hash of the first of up to 8 device grants (newest first, as the grant cookie keeps them) that belongs to the recipient and has not expired; null when none does.';
revoke all on function private.stakeholder_pack_grant(text[], uuid) from public, anon, authenticated;

-- Which of the grants a device presented no longer open anything, so its cookie can drop them. They are the caller's own.
create or replace function private.dead_stakeholder_pack_grants(p_grants text[])
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(x.value), '[]'::jsonb)
  from unnest((coalesce(p_grants, '{}'::text[]))[1:8]) as x (value)
  where not exists (select 1 from private.stakeholder_pack_grants g
    where g.grant_hash = private.share_token_hash(x.value) and g.expires_at > now());
$$;

comment on function private.dead_stakeholder_pack_grants(text[]) is 'Those of up to 8 grants a device presented that no longer open a pack: swapped, deleted or expired. Echoes only what the caller sent, so its grant cookie can drop them rather than let them push out a live one.';
revoke all on function private.dead_stakeholder_pack_grants(text[]) from public, anon, authenticated;

-- Why a link no longer opens the pack, or null. A superseded link answers pack_link_invalid without counting a failure.
create or replace function private.stakeholder_pack_state_reason(
  p_link private.stakeholder_pack_links,
  p_recipient app.stakeholder_pack_recipients,
  p_pack app.stakeholder_packs
)
returns text
language sql
stable
set search_path = ''
as $$
  select case
    when p_pack.id is null or p_pack.revoked_at is not null or p_pack.deleted_at is not null then 'pack_revoked'
    when p_recipient.id is null or p_recipient.revoked_at is not null or p_recipient.deleted_at is not null then 'pack_recipient_revoked'
    when p_link.revoked_at is not null then 'pack_link_invalid'
    when p_link.expires_at <= now() or p_pack.expires_at <= now() then 'pack_link_expired'
  end;
$$;

comment on function private.stakeholder_pack_state_reason(private.stakeholder_pack_links, app.stakeholder_pack_recipients, app.stakeholder_packs) is 'Why an emailed stakeholder pack link no longer opens the pack: pack_revoked, pack_recipient_revoked, pack_link_invalid (superseded by a later email or revoked), pack_link_expired (the link''s or the pack''s expiry); null when it still opens.';
revoke all on function private.stakeholder_pack_state_reason(private.stakeholder_pack_links, app.stakeholder_pack_recipients, app.stakeholder_packs) from public, anon, authenticated;

-- The page heading: the org brand's Public columns, the project's name and zone, the pack's name, message and expiry.
create or replace function private.stakeholder_pack_meta(p_pack app.stakeholder_packs)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'project_name', p.name,
    'time_zone', coalesce(nullif(btrim(p.time_zone), ''), private.org_setting_text(p_pack.org_id, 'locale.time_zone'), 'UTC'),
    'brand_name', coalesce(b.display_name, o.name),
    'brand_logo_light_path', b.logo_light_path,
    'brand_logo_dark_path', b.logo_dark_path,
    'brand_accent_hex', b.accent_hex,
    'brand_suppress_powered_by', coalesce(b.suppress_powered_by, false),
    'pack_name', p_pack.name,
    'message', p_pack.message,
    'expires_at', p_pack.expires_at)
  from app.projects p
  join app.organizations o on o.id = p_pack.org_id
  left join app.org_brands b on b.org_id = p_pack.org_id and b.deleted_at is null
  where p.id = p_pack.project_id;
$$;

comment on function private.stakeholder_pack_meta(app.stakeholder_packs) is 'Heading of a stakeholder pack page: the project''s name and zone (else the org''s locale.time_zone, else UTC), the org brand''s Public columns (name, logos, accent, whether Powered by XOS is suppressed), the pack''s name, message and expiry. Never the pack''s note.';
revoke all on function private.stakeholder_pack_meta(app.stakeholder_packs) from public, anon, authenticated;

-- Whether an item can be shown now, or why not (pack_item_unavailable). A live item needs its link unrevoked, unexpired
-- and readable by its creator; a file item needs the file still Public or Internal with a clean version, and the person
-- who added it still a member of the org, as P1 requires of a link's creator.
create or replace function private.stakeholder_pack_item_reason(p_item app.stakeholder_pack_items, p_pack app.stakeholder_packs)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_link app.live_links;
  v_collection private.live_view_collections;
begin
  if p_item.id is null or p_item.deleted_at is not null or p_item.stakeholder_pack_id <> p_pack.id then
    return 'pack_item_unavailable';
  end if;
  if p_item.item_kind = 'Live Link' then
    select * into v_link from app.live_links l where l.id = p_item.live_link_id;
    if v_link.id is null or v_link.revoked_at is not null or v_link.deleted_at is not null or v_link.expires_at <= now() then
      return 'pack_item_unavailable';
    end if;
    select * into v_collection from private.live_view_collections c
    where c.collection_key = private.live_link_collection_key(v_link.link_kind, v_link.saved_view_id);
    if v_collection.collection_key is null or exists (
      select 1 from private.live_view_fields f
      cross join lateral unnest(f.source_columns) as col (name)
      join private.column_classifications cc on cc.table_name = f.source_table and cc.column_name = col.name
      where f.collection_key = v_collection.collection_key and cc.classification in ('Confidential', 'Restricted')
    ) or private.live_link_owner_reason(v_link, v_collection) is not null then
      return 'pack_item_unavailable';
    end if;
    return null;
  end if;
  if not exists (
    select 1 from app.attachments a
    where a.id = p_item.attachment_id and a.deleted_at is null and a.classification in ('Public', 'Internal')
      and (private.pack_file_version(a.id)).id is not null
  ) or not exists (
    select 1 from app.memberships m
    where m.person_id = p_item.created_by and m.org_id = p_pack.org_id and m.deleted_at is null
      and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now())
  ) then
    return 'pack_item_unavailable';
  end if;
  return null;
end;
$$;

comment on function private.stakeholder_pack_item_reason(app.stakeholder_pack_items, app.stakeholder_packs) is 'Null when a stakeholder pack item can be shown now, else pack_item_unavailable: a live item whose link is revoked, expired or deleted, whose collection''s fields were classified above Internal, or whose creator lost membership or the read capability (private.live_link_owner_reason); a file item whose file is deleted, raised above Internal or whose current version is not clean, or whose adder is no longer a member of the org.';
revoke all on function private.stakeholder_pack_item_reason(app.stakeholder_pack_items, app.stakeholder_packs) from public, anon, authenticated;

create or replace function private.log_stakeholder_pack_event(
  p_pack_id uuid,
  p_recipient_id uuid,
  p_action app.pack_event_action,
  p_item_id uuid default null,
  p_signer_name text default null
)
returns timestamptz
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_at timestamptz;
begin
  insert into app.stakeholder_pack_events as e (stakeholder_pack_id, recipient_id, item_id, action, signer_name)
  values (p_pack_id, p_recipient_id, p_item_id, p_action, p_signer_name)
  returning e.occurred_at into v_at;
  return v_at;
end;
$$;

comment on function private.log_stakeholder_pack_event(uuid, uuid, app.pack_event_action, uuid, text) is 'Appends one stakeholder pack event (Sent, Opened, Viewed, Downloaded, Signed or Unsubscribed) and answers when it happened.';
revoke all on function private.log_stakeholder_pack_event(uuid, uuid, app.pack_event_action, uuid, text) from public, anon, authenticated;

-- Issues a device grant for a recipient: the earliest of 7 days, the link's expiry and the pack's.
create or replace function private.issue_stakeholder_pack_grant(
  p_org_id uuid,
  p_recipient_id uuid,
  p_link_expires_at timestamptz,
  p_pack_expires_at timestamptz,
  out o_grant text,
  out o_expires_at timestamptz
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  delete from private.stakeholder_pack_grants g where g.expires_at < now() - interval '1 day';
  o_grant := 'xpkg_' || encode(extensions.gen_random_bytes(32), 'hex');
  o_expires_at := least(p_link_expires_at, p_pack_expires_at, now() + interval '7 days');
  insert into private.stakeholder_pack_grants (grant_hash, org_id, recipient_id, expires_at)
  values (private.share_token_hash(o_grant), p_org_id, p_recipient_id, o_expires_at);
end;
$$;

comment on function private.issue_stakeholder_pack_grant(uuid, uuid, timestamptz, timestamptz) is 'Issues a stakeholder pack device grant (xpkg_ and 256 random bits; only its SHA-256 is kept) valid until the earliest of 7 days, the link''s expiry and the pack''s, and prunes grants expired more than a day.';
revoke all on function private.issue_stakeholder_pack_grant(uuid, uuid, timestamptz, timestamptz) from public, anon, authenticated;

-- Opening a pack ------------------------------------------------------------------------------------------------------

create or replace function api_public.open_stakeholder_pack(
  p_token text,
  p_access_code text default null,
  p_client_address text default null,
  p_grants text[] default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_subjects record;
  v_hash bytea;
  v_link private.stakeholder_pack_links;
  v_recipient app.stakeholder_pack_recipients;
  v_pack app.stakeholder_packs;
  v_old_grant bytea;
  v_reason text;
  v_issued record;
begin
  perform private.require_read_write();
  select * into v_subjects from private.live_link_subjects(p_client_address);
  if p_token is not null and p_token ~ '^xpkl_[0-9a-f]{64}$' then
    v_hash := private.share_token_hash(p_token);
    select * into v_link from private.stakeholder_pack_links l where l.token_hash = v_hash for update;
  end if;
  if v_link.id is not null then
    select * into v_recipient from app.stakeholder_pack_recipients r where r.id = v_link.recipient_id for update;
    select * into v_pack from app.stakeholder_packs p where p.id = v_recipient.stakeholder_pack_id;
    if nullif(btrim(coalesce(p_access_code, '')), '') is null then
      v_old_grant := private.stakeholder_pack_grant(p_grants, v_recipient.id);
    end if;
  end if;
  -- The address limits stop guessing, so a device that already proved the code is never blanked by them.
  if v_old_grant is null and private.pack_link_rate_limited(v_subjects.o_hop, v_subjects.o_subject) then
    return private.live_link_refusal('pack_link_rate_limited');
  end if;
  if v_link.id is null then
    perform private.note_pack_link_failure(v_subjects.o_hop, v_subjects.o_subject);
    return private.live_link_refusal('pack_link_invalid');
  end if;
  v_reason := private.stakeholder_pack_state_reason(v_link, v_recipient, v_pack);
  if v_reason is not null then
    return private.live_link_refusal(v_reason);
  end if;

  if v_old_grant is null then
    if v_recipient.failed_attempts >= 5 then
      perform private.note_pack_link_failure(v_subjects.o_hop, v_subjects.o_subject);
      return private.live_link_refusal('pack_locked');
    end if;
    if nullif(btrim(coalesce(p_access_code, '')), '') is null then
      return private.live_link_refusal('pack_access_code_required');
    end if;
    if v_recipient.access_code_hash <> private.share_code_hash(encode(v_recipient.code_salt, 'hex'), p_access_code) then
      perform private.begin_trusted_operation('stakeholder_pack_service');
      update app.stakeholder_pack_recipients r set failed_attempts = least(r.failed_attempts + 1, 5) where r.id = v_recipient.id;
      perform private.end_trusted_operation('stakeholder_pack_service');
      perform private.note_pack_link_failure(v_subjects.o_hop, v_subjects.o_subject);
      return private.live_link_refusal(case when v_recipient.failed_attempts + 1 >= 5 then 'pack_locked' else 'pack_access_code' end);
    end if;
  end if;

  -- A grant the device earned on an earlier email opens this one; it is swapped for a fresh grant. A correct code replaces
  -- this recipient's grants the device presented in the same way.
  delete from private.stakeholder_pack_grants g
  where g.recipient_id = v_recipient.id
    and g.grant_hash in (select private.share_token_hash(x.value) from unnest((coalesce(p_grants, '{}'::text[]))[1:8]) as x (value));

  select * into v_issued from private.issue_stakeholder_pack_grant(v_pack.org_id, v_recipient.id, v_link.expires_at, v_pack.expires_at);
  perform private.log_stakeholder_pack_event(v_pack.id, v_recipient.id, 'Opened');
  return jsonb_build_object('status', 'ok', 'grant', v_issued.o_grant, 'grant_expires_at', v_issued.o_expires_at,
    'dead_grants', private.dead_stakeholder_pack_grants(p_grants));
end;
$$;

comment on function api_public.open_stakeholder_pack(text, text, text, text[]) is 'Opens a stakeholder pack from an emailed link without an account (ADR 0141; Section 7.5 invariant 8). Refuses a read-only (GET) call first; then, unless a valid device grant of the same recipient comes with it, the address failure limits (20 per relayed address p_client_address in 10 minutes, 2000 per reaching address in 15; pack_link_rate_limited); then locks the link and the recipient and checks them: unknown (pack_link_invalid, counted), pack_revoked, pack_recipient_revoked, superseded (pack_link_invalid, not counted), pack_link_expired, locked after 5 wrong codes (pack_locked), pack_access_code_required, or a wrong code (pack_access_code, counted). A correct code, or with no code one of up to 8 grants in p_grants that is the recipient''s, earns a fresh device grant valid until the earliest of 7 days, the link''s expiry and the pack''s (the recipient''s grants the device presented are deleted), and logs Opened. Answers JSON: status refused with the reason, or status ok with the grant, its expiry and dead_grants, those the device presented that no longer open anything.';
revoke all on function api_public.open_stakeholder_pack(text, text, text, text[]) from public;
grant execute on function api_public.open_stakeholder_pack(text, text, text, text[]) to anon, authenticated, service_role;

-- Reading a pack ------------------------------------------------------------------------------------------------------

create or replace function private.stakeholder_pack_reader(
  p_token text,
  p_grants text[],
  p_client_address text,
  out o_link private.stakeholder_pack_links,
  out o_recipient app.stakeholder_pack_recipients,
  out o_pack app.stakeholder_packs,
  out o_reason text
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_subjects record;
  v_grant bytea;
begin
  perform private.require_read_write();
  select * into v_subjects from private.live_link_subjects(p_client_address);
  if p_token is not null and p_token ~ '^xpkl_[0-9a-f]{64}$' then
    select * into o_link from private.stakeholder_pack_links l where l.token_hash = private.share_token_hash(p_token);
  end if;
  if o_link.id is not null then
    select * into o_recipient from app.stakeholder_pack_recipients r where r.id = o_link.recipient_id;
    select * into o_pack from app.stakeholder_packs p where p.id = o_recipient.stakeholder_pack_id;
    v_grant := private.stakeholder_pack_grant(p_grants, o_recipient.id);
  end if;
  if v_grant is null and private.pack_link_rate_limited(v_subjects.o_hop, v_subjects.o_subject) then
    o_reason := 'pack_link_rate_limited';
    return;
  end if;
  if o_link.id is null then
    perform private.note_pack_link_failure(v_subjects.o_hop, v_subjects.o_subject);
    o_reason := 'pack_link_invalid';
    return;
  end if;
  o_reason := private.stakeholder_pack_state_reason(o_link, o_recipient, o_pack);
  if o_reason is not null then
    return;
  end if;
  if v_grant is null then
    o_reason := 'pack_grant';
    return;
  end if;
  if private.rate_limit_exceeded('pack_link.fetch', encode(v_grant, 'hex'), 600, interval '1 hour') then
    o_reason := 'pack_link_rate_limited';
    return;
  end if;
  perform private.note_rate_event('pack_link.fetch', encode(v_grant, 'hex'));
end;
$$;

comment on function private.stakeholder_pack_reader(text, text[], text) is 'Checks a stakeholder pack read: refuses a read-only transaction first, then the address failure limits (only without a valid device grant), the emailed link (pack_link_invalid, counted when unknown), the pack, the recipient and the expiries (private.stakeholder_pack_state_reason), the device grant (pack_grant), and 600 reads an hour per grant (pack_link_rate_limited). Answers the link, recipient and pack, or the reason.';
revoke all on function private.stakeholder_pack_reader(text, text[], text) from public, anon, authenticated;

create or replace function api_public.stakeholder_pack(p_token text, p_grants text[], p_client_address text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_read record;
  v_pack app.stakeholder_packs;
  v_recipient app.stakeholder_pack_recipients;
  v_items jsonb;
begin
  select * into v_read from private.stakeholder_pack_reader(p_token, p_grants, p_client_address);
  if v_read.o_reason is not null then
    return private.live_link_refusal(v_read.o_reason);
  end if;
  v_pack := v_read.o_pack;
  v_recipient := v_read.o_recipient;
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', i.id,
      'title', i.title,
      'kind', i.item_kind,
      'available', private.stakeholder_pack_item_reason(i, v_pack) is null,
      'requires_acknowledgement', i.requires_acknowledgement,
      'signed_at', (select min(e.occurred_at) from app.stakeholder_pack_events e
                    where e.recipient_id = v_recipient.id and e.item_id = i.id and e.action = 'Signed'))
    order by i.position, i.id), '[]'::jsonb)
  into v_items
  from app.stakeholder_pack_items i
  where i.stakeholder_pack_id = v_pack.id and i.deleted_at is null;
  return jsonb_build_object(
    'status', 'ok',
    'meta', private.stakeholder_pack_meta(v_pack),
    'recipient_name', v_recipient.full_name,
    'items', v_items);
end;
$$;

comment on function api_public.stakeholder_pack(text, text[], text) is 'Reads a stakeholder pack with its device grant (ADR 0141; Section 7.5 invariant 8). Refuses as private.stakeholder_pack_reader does. Answers JSON: meta (the brand''s Public columns, the project''s name and zone, the pack''s name, message and expiry), the recipient''s own name, and the items in order with id, title, kind, whether each is available now, whether it asks for an acknowledgement and when this recipient acknowledged it. Never the note, other recipients, emails or attachment ids.';
revoke all on function api_public.stakeholder_pack(text, text[], text) from public;
grant execute on function api_public.stakeholder_pack(text, text[], text) to anon, authenticated, service_role;

create or replace function api_public.stakeholder_pack_item(p_token text, p_grants text[], p_item_id uuid, p_client_address text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_read record;
  v_pack app.stakeholder_packs;
  v_recipient app.stakeholder_pack_recipients;
  v_item app.stakeholder_pack_items;
  v_link app.live_links;
  v_collection private.live_view_collections;
  v_payload jsonb;
begin
  select * into v_read from private.stakeholder_pack_reader(p_token, p_grants, p_client_address);
  if v_read.o_reason is not null then
    return private.live_link_refusal(v_read.o_reason);
  end if;
  v_pack := v_read.o_pack;
  v_recipient := v_read.o_recipient;
  select * into v_item from app.stakeholder_pack_items i
  where i.id = p_item_id and i.stakeholder_pack_id = v_pack.id and i.deleted_at is null and i.item_kind = 'Live Link';
  if v_item.id is null or private.stakeholder_pack_item_reason(v_item, v_pack) is not null then
    return private.live_link_refusal('pack_item_unavailable');
  end if;
  select * into v_link from app.live_links l where l.id = v_item.live_link_id;
  select * into v_collection from private.live_view_collections c
  where c.collection_key = private.live_link_collection_key(v_link.link_kind, v_link.saved_view_id);
  -- P1's per-link ceiling counts the pack's reads of the link too.
  if private.rate_limit_exceeded('live_link.link_fetch', v_link.id::text, 60000, interval '1 hour') then
    return private.live_link_refusal('pack_link_rate_limited');
  end if;
  perform private.note_rate_event('live_link.link_fetch', v_link.id::text);
  -- Read as the live link's creator (P1 rule 3's deliberate exception), through the same payload the link shows.
  v_payload := case v_link.link_kind
    when 'View' then private.live_view_payload(v_link, v_collection)
    else private.live_display_payload(v_link, v_collection)
  end;
  if v_payload ->> 'status' is distinct from 'ok' then
    return private.live_link_refusal('pack_item_unavailable');
  end if;
  if not exists (
    select 1 from app.stakeholder_pack_events e
    where e.recipient_id = v_recipient.id and e.item_id = v_item.id and e.action = 'Viewed'
      and e.occurred_at > now() - interval '1 hour'
  ) then
    perform private.log_stakeholder_pack_event(v_pack.id, v_recipient.id, 'Viewed', v_item.id);
  end if;
  return v_payload || jsonb_build_object('item', jsonb_build_object('id', v_item.id, 'title', v_item.title));
end;
$$;

comment on function api_public.stakeholder_pack_item(text, text[], uuid, text) is 'Reads one live item of a stakeholder pack with the recipient''s device grant (ADR 0141): refuses as private.stakeholder_pack_reader does, and pack_item_unavailable when the item is not a live item of the pack, its link is revoked, expired or deleted, its fields were reclassified, or its creator lost access. Answers P1''s payload for the link (private.live_view_payload or private.live_display_payload, read as the link''s creator; the same rows the link shows, with its Realtime channel) and the item''s id and title. Counts against P1''s per-link ceiling and logs Viewed at most once per recipient, item and hour.';
revoke all on function api_public.stakeholder_pack_item(text, text[], uuid, text) from public;
grant execute on function api_public.stakeholder_pack_item(text, text[], uuid, text) to anon, authenticated, service_role;

-- Download tickets: a stakeholder pack recipient source -----------------------------------------------------------------

alter table private.file_download_tickets
  add column org_id uuid references app.organizations (id),
  add column stakeholder_pack_recipient_id uuid references app.stakeholder_pack_recipients (id),
  drop constraint file_download_tickets_one_source,
  add constraint file_download_tickets_one_source check (num_nonnulls(share_link_id, person_id, stakeholder_pack_recipient_id) = 1);

-- Org deletion (1351) follows these foreign keys into the tickets and refuses rows without an org. The issuers of 1380
-- and 2041 stay as they are: the org is stamped from the attachment version.
update private.file_download_tickets t set org_id = v.org_id
from app.attachment_versions v where v.id = t.attachment_version_id;

alter table private.file_download_tickets alter column org_id set not null;

create or replace function private.stamp_file_download_ticket_org()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.org_id := (select v.org_id from app.attachment_versions v where v.id = new.attachment_version_id);
  return new;
end;
$$;

comment on function private.stamp_file_download_ticket_org() is 'Before insert on download tickets: the ticket''s org is its attachment version''s, so deleting the org takes the ticket with it (1351).';
revoke all on function private.stamp_file_download_ticket_org() from public, anon, authenticated;

create trigger t05_stamp_org before insert on private.file_download_tickets
  for each row execute function private.stamp_file_download_ticket_org();

create index file_download_tickets_org_idx on private.file_download_tickets (org_id);
create index file_download_tickets_pack_recipient_idx on private.file_download_tickets (stakeholder_pack_recipient_id);

comment on table private.file_download_tickets is 'Single-use handovers to the file-download Edge Function (Section 8.6): one stored object, valid 2 minutes, consumed once by app.consume_file_download_ticket. Issued by api_public.open_share_link for a share link, by app.record_file_download for an in-app download that must carry the watermark (2041), and by api_public.stakeholder_pack_file for a stakeholder pack recipient (2912). Only the SHA-256 of the ticket is stored.';
comment on column private.file_download_tickets.org_id is 'Org of the attachment version, stamped by the database (2912); deleting the org takes the ticket with it.';
comment on column private.file_download_tickets.stakeholder_pack_recipient_id is 'Stakeholder pack recipient whose download issued the ticket (api_public.stakeholder_pack_file, 2912); null for the other sources.';

create or replace function api_public.stakeholder_pack_file(p_token text, p_grants text[], p_item_id uuid, p_client_address text default null)
returns table (refusal text, ticket text, filename text, content_type text, size_bytes bigint)
language plpgsql
volatile
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_read record;
  v_pack app.stakeholder_packs;
  v_recipient app.stakeholder_pack_recipients;
  v_item app.stakeholder_pack_items;
  v_attachment app.attachments;
  v_version app.attachment_versions;
  v_ticket text;
begin
  select * into v_read from private.stakeholder_pack_reader(p_token, p_grants, p_client_address);
  if v_read.o_reason is not null then
    return query select v_read.o_reason, null::text, null::text, null::text, null::bigint;
    return;
  end if;
  v_pack := v_read.o_pack;
  v_recipient := v_read.o_recipient;
  select * into v_item from app.stakeholder_pack_items i
  where i.id = p_item_id and i.stakeholder_pack_id = v_pack.id and i.deleted_at is null and i.item_kind = 'File';
  if v_item.id is null or private.stakeholder_pack_item_reason(v_item, v_pack) is not null then
    return query select 'pack_item_unavailable'::text, null::text, null::text, null::text, null::bigint;
    return;
  end if;
  select * into v_attachment from app.attachments a where a.id = v_item.attachment_id;
  v_version := private.pack_file_version(v_attachment.id);

  delete from private.file_download_tickets t where t.expires_at < now() - interval '1 day';
  v_ticket := 'xdlt_' || encode(extensions.gen_random_bytes(32), 'hex');
  insert into private.file_download_tickets (ticket_hash, stakeholder_pack_recipient_id, attachment_version_id, expires_at)
  values (private.share_token_hash(v_ticket), v_recipient.id, v_version.id, now() + interval '2 minutes');
  perform private.log_stakeholder_pack_event(v_pack.id, v_recipient.id, 'Downloaded', v_item.id);
  insert into app.file_access_log (org_id, person_id, bucket_id, object_path, action, classification, watermarked)
  values (v_attachment.org_id, null, 'attachments', v_version.object_name, 'Share Link Opened', v_attachment.classification, false);
  return query select null::text, v_ticket, v_version.filename, v_version.content_type, v_version.size_bytes;
end;
$$;

comment on function api_public.stakeholder_pack_file(text, text[], uuid, text) is 'Downloads one file item of a stakeholder pack with the recipient''s device grant (ADR 0141): refuses as private.stakeholder_pack_reader does (the reason in refusal), and pack_item_unavailable when the item is not a file item of the pack, the file is deleted, raised above Internal or its current version is not clean, or its adder left the org. Issues a single-use download ticket (2 minutes) for the file''s current version, which the Atlas route trades at the file-download Edge Function; logs Downloaded in the pack''s events and Share Link Opened in app.file_access_log (no person, the file''s classification, no watermark), as 1380 logs a no-account open.';
revoke all on function api_public.stakeholder_pack_file(text, text[], uuid, text) from public;
grant execute on function api_public.stakeholder_pack_file(text, text[], uuid, text) to anon, authenticated, service_role;

create or replace function api_public.sign_stakeholder_pack_item(
  p_token text,
  p_grants text[],
  p_item_id uuid,
  p_signer_name text,
  p_client_address text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_read record;
  v_pack app.stakeholder_packs;
  v_recipient app.stakeholder_pack_recipients;
  v_item app.stakeholder_pack_items;
  v_name text := btrim(coalesce(p_signer_name, ''));
  v_first timestamptz;
  v_at timestamptz;
begin
  select * into v_read from private.stakeholder_pack_reader(p_token, p_grants, p_client_address);
  if v_read.o_reason is not null then
    return private.live_link_refusal(v_read.o_reason);
  end if;
  v_pack := v_read.o_pack;
  v_recipient := v_read.o_recipient;
  select * into v_item from app.stakeholder_pack_items i
  where i.id = p_item_id and i.stakeholder_pack_id = v_pack.id and i.deleted_at is null;
  if v_item.id is null or not v_item.requires_acknowledgement then
    return private.live_link_refusal('pack_item_not_acknowledgeable');
  end if;
  if private.stakeholder_pack_item_reason(v_item, v_pack) is not null then
    return private.live_link_refusal('pack_item_unavailable');
  end if;
  if char_length(v_name) not between 1 and 200 then
    return private.live_link_refusal('pack_signer_name');
  end if;
  -- One acknowledgement per recipient and item; the recipient row lock serializes two at once.
  perform 1 from app.stakeholder_pack_recipients r where r.id = v_recipient.id for update;
  select min(e.occurred_at) into v_first from app.stakeholder_pack_events e
  where e.recipient_id = v_recipient.id and e.item_id = v_item.id and e.action = 'Signed';
  if v_first is not null then
    return jsonb_build_object('status', 'refused', 'reason', 'already_signed', 'signed_at', v_first);
  end if;
  v_at := private.log_stakeholder_pack_event(v_pack.id, v_recipient.id, 'Signed', v_item.id, v_name);
  perform private.emit_event(v_pack.org_id, 'stakeholder_pack.signed', 'stakeholder_packs', v_pack.id,
    v_pack.project_id, jsonb_build_object('recipient_id', v_recipient.id, 'item_id', v_item.id));
  return jsonb_build_object('status', 'ok', 'signed_at', v_at);
end;
$$;

comment on function api_public.sign_stakeholder_pack_item(text, text[], uuid, text, text) is 'Acknowledges one stakeholder pack item with the name the recipient typed (ADR 0141): refuses as private.stakeholder_pack_reader does, pack_item_not_acknowledgeable for an item that does not ask for it, pack_item_unavailable, and pack_signer_name for a name not 1 to 200 characters. Once per recipient and item: a repeat answers already_signed with the first time. Logs Signed with the name and emits stakeholder_pack.signed. A typed-name acknowledgement is a receipt, not a signature of a contract.';
revoke all on function api_public.sign_stakeholder_pack_item(text, text[], uuid, text, text) from public;
grant execute on function api_public.sign_stakeholder_pack_item(text, text[], uuid, text, text) to anon, authenticated, service_role;

-- Unsubscribing --------------------------------------------------------------------------------------------------------

-- Whether the org sends this address nothing, with B8's rule (ADR 0147 decision 7): a live, unlifted row for a hard
-- bounce, complaint, STOP or manual entry, or an unsubscribe with no category.
create or replace function private.pack_email_suppressed(p_org_id uuid, p_email text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from app.suppression_list s
    where s.org_id = p_org_id and s.channel = 'Email' and s.address = lower(btrim(p_email))
      and s.lifted_at is null and s.deleted_at is null
      and (s.reason in ('Hard Bounce', 'Complaint', 'STOP', 'Manual') or (s.reason = 'Unsubscribe' and s.category_code is null)));
$$;

comment on function private.pack_email_suppressed(uuid, text) is 'True when an org''s app.suppression_list stops stakeholder pack email to an address: a live, unlifted row for a hard bounce, complaint, STOP or manual entry, or an unsubscribe with no category. An unsubscribe limited to one notification category does not stop pack email.';
revoke all on function private.pack_email_suppressed(uuid, text) from public, anon, authenticated;

-- The one effect of both unsubscribe paths: finds the link by its unsubscribe token, sets unsubscribed_at, logs it and
-- adds the address to the org's list once. Answers the first unsubscribe time, or null for a token never seen.
create or replace function private.unsubscribe_pack_recipient(p_unsubscribe_token text)
returns timestamptz
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_link private.stakeholder_pack_links;
  v_recipient app.stakeholder_pack_recipients;
begin
  if p_unsubscribe_token is null or p_unsubscribe_token !~ '^xpku_[0-9a-f]{64}$' then
    return null;
  end if;
  select * into v_link from private.stakeholder_pack_links l where l.unsubscribe_hash = private.share_token_hash(p_unsubscribe_token);
  if v_link.id is null then
    return null;
  end if;
  select * into v_recipient from app.stakeholder_pack_recipients r where r.id = v_link.recipient_id for update;
  if v_recipient.unsubscribed_at is not null then
    return v_recipient.unsubscribed_at;
  end if;
  perform private.begin_trusted_operation('stakeholder_pack_service');
  update app.stakeholder_pack_recipients r set unsubscribed_at = now() where r.id = v_recipient.id
  returning r.unsubscribed_at into v_recipient.unsubscribed_at;
  perform private.end_trusted_operation('stakeholder_pack_service');
  perform private.log_stakeholder_pack_event(v_recipient.stakeholder_pack_id, v_recipient.id, 'Unsubscribed');
  insert into app.suppression_list (org_id, channel, address, reason, category_code)
  select v_recipient.org_id, 'Email', v_recipient.email, 'Unsubscribe', null
  where not exists (
    select 1 from app.suppression_list s
    where s.org_id = v_recipient.org_id and s.channel = 'Email' and s.address = v_recipient.email and s.reason = 'Unsubscribe'
      and s.category_code is null and s.lifted_at is null and s.deleted_at is null);
  return v_recipient.unsubscribed_at;
end;
$$;

comment on function private.unsubscribe_pack_recipient(text) is 'The effect of a stakeholder pack unsubscribe, once: sets the recipient''s unsubscribed_at, logs Unsubscribed and adds the address to the org''s app.suppression_list with no category, unless an equal live row exists, so the org''s other packs stop mailing it too. Answers the first unsubscribe time; null for a token never seen.';
revoke all on function private.unsubscribe_pack_recipient(text) from public, anon, authenticated;

create or replace function api_public.unsubscribe_stakeholder_pack(p_unsubscribe_token text, p_client_address text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_subjects record;
  v_at timestamptz;
begin
  perform private.require_read_write();
  select * into v_subjects from private.live_link_subjects(p_client_address);
  if private.pack_link_rate_limited(v_subjects.o_hop, v_subjects.o_subject) then
    return private.live_link_refusal('pack_link_rate_limited');
  end if;
  v_at := private.unsubscribe_pack_recipient(p_unsubscribe_token);
  if v_at is null then
    perform private.note_pack_link_failure(v_subjects.o_hop, v_subjects.o_subject);
    return private.live_link_refusal('pack_link_invalid');
  end if;
  return jsonb_build_object('status', 'ok', 'unsubscribed_at', v_at);
end;
$$;

comment on function api_public.unsubscribe_stakeholder_pack(text, text) is 'Stops a stakeholder pack recipient''s emails from the xpku_ token in an email''s visible Stop these emails link, for Atlas''s confirm page (ADR 0141). Refuses a read-only (GET) call first and an address that used up its pack failures; an unknown token counts a failure (pack_link_invalid). Idempotent: a repeat answers the first time. Scheduled sends skip the recipient from then on, the org''s other packs skip the address, and the pack still opens with their code.';
revoke all on function api_public.unsubscribe_stakeholder_pack(text, text) from public;
grant execute on function api_public.unsubscribe_stakeholder_pack(text, text) to anon, authenticated, service_role;

create or replace function app.unsubscribe_pack_by_token(p_token text)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  return private.unsubscribe_pack_recipient(p_token) is not null;
end;
$$;

comment on function app.unsubscribe_pack_by_token(text) is 'One-click unsubscribe from a stakeholder pack email (service role, called by the email-unsubscribe Edge Function for an RFC 8058 POST; ADR 0141). Same effect as api_public.unsubscribe_stakeholder_pack through private.unsubscribe_pack_recipient. It counts no failures: behind the Edge Function the reaching address is the function''s own, so counting would let 20 bad tokens stop every recipient''s unsubscribe, and the token is 256 bits with an idempotent, low-harm effect. Answers false for a token never seen.';
revoke all on function app.unsubscribe_pack_by_token(text) from public, anon, authenticated;
grant execute on function app.unsubscribe_pack_by_token(text) to service_role;

-- Consuming a ticket (latest 2041): a pack ticket stops with its pack, its recipient or its file's classification ----

drop function app.consume_file_download_ticket(text, boolean);

create function app.consume_file_download_ticket(p_ticket text, p_watermarks boolean default false)
returns table (bucket_id text, object_name text, filename text, content_type text, size_bytes bigint, watermark boolean)
language plpgsql
volatile
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_ticket private.file_download_tickets;
  v_version app.attachment_versions;
  v_attachment app.attachments;
  v_link app.share_links;
  v_recipient app.stakeholder_pack_recipients;
  v_pack app.stakeholder_packs;
  v_watermark boolean;
begin
  select * into v_ticket from private.file_download_tickets t where t.ticket_hash = private.share_token_hash(p_ticket) for update;
  if v_ticket.id is null or v_ticket.used_at is not null or v_ticket.expires_at <= now() then
    return;
  end if;
  select * into v_version from app.attachment_versions v where v.id = v_ticket.attachment_version_id;
  select * into v_attachment from app.attachments a where a.id = v_version.attachment_id;
  -- The rule of the file as it is now, not as it was when the ticket was issued.
  v_watermark := coalesce(private.watermark_required(v_attachment.classification, v_version.content_type), false);
  if v_watermark and not coalesce(p_watermarks, false) then
    return;
  end if;
  update private.file_download_tickets t set used_at = now() where t.id = v_ticket.id;
  if v_version.id is null or v_version.deleted_at is not null or v_version.scan_status <> 'Clean'
     or v_attachment.id is null or v_attachment.deleted_at is not null then
    return;
  end if;
  if v_ticket.share_link_id is not null then
    select * into v_link from app.share_links l where l.id = v_ticket.share_link_id;
    if v_link.id is null or v_link.revoked_at is not null or v_link.deleted_at is not null
       or v_attachment.classification = 'Restricted' then
      return;
    end if;
  end if;
  if v_ticket.stakeholder_pack_recipient_id is not null then
    select * into v_recipient from app.stakeholder_pack_recipients r where r.id = v_ticket.stakeholder_pack_recipient_id;
    select * into v_pack from app.stakeholder_packs p where p.id = v_recipient.stakeholder_pack_id;
    if v_recipient.id is null or v_recipient.revoked_at is not null or v_recipient.deleted_at is not null
       or v_pack.id is null or v_pack.revoked_at is not null or v_pack.deleted_at is not null or v_pack.expires_at <= now()
       or v_attachment.classification not in ('Public', 'Internal') then
      return;
    end if;
  end if;
  return query select 'attachments'::text, v_version.object_name, v_version.filename, v_version.content_type,
    v_version.size_bytes, v_watermark;
end;
$$;

comment on function app.consume_file_download_ticket(text, boolean) is 'Service role only (the file-download Edge Function): consumes a download ticket once, within its 2 minutes, and answers the stored object to send and whether the copy must carry the watermark, by the file''s classification now. A copy that must carry it is answered only when p_watermarks says the caller marks it, which the function says only for the Atlas web shell proven by the handover secret (2041); otherwise nothing is answered and the ticket stays unused. An unknown, used or expired ticket, a deleted file, a share link revoked since or whose file was raised to Restricted, or a stakeholder pack ticket whose pack or recipient was revoked, whose pack expired or whose file was raised above Internal (2912) answers nothing.';
revoke all on function app.consume_file_download_ticket(text, boolean) from public, anon, authenticated;
grant execute on function app.consume_file_download_ticket(text, boolean) to service_role;

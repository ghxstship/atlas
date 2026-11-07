-- 6280_links_end_with_their_project.sql
-- Owner decision of 2026-11-06 (ADR 0142): a link tied to a project stops opening when its project ends. A project has
-- ended when it is Complete or Canceled in its lifecycle, or archived, or in Trash: the opposite of the live project test
-- 3070 and 1471 already use. Reopening or restoring the project lets its unexpired links open again. The refusal comes
-- before the lockout and the code and says only that the link has ended: *_link_ended, with no project detail, and the
-- approval link's read answers no org or email for it. Each family has one check at its choke point: the advance and
-- signing token resolvers, the live link open and reader (views and screens), the showcaller open and reader, and the
-- approval link's state. File shares come in 6281.

create or replace function private.project_link_open(p_project_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_project_id is null or exists (
    select 1 from app.projects p
    where p.id = p_project_id and p.deleted_at is null and p.archived_at is null
      and p.project_state in ('Proposed', 'Active', 'Blocked'));
$$;

comment on function private.project_link_open(uuid) is 'True unless the project a link belongs to is Complete, Canceled, archived or in Trash (ADR 0142). A link with no project stays open.';
revoke all on function private.project_link_open(uuid) from public, anon, authenticated;

create or replace function private.resolve_advance_token(p_token text, p_access_code text)
returns table (token_id uuid, reason text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_token app.advance_recipient_tokens;
begin
  perform private.require_read_write();
  select * into v_token from app.advance_recipient_tokens t where t.token_hash = private.advance_token_hash(p_token) for update;
  if v_token.id is null or v_token.deleted_at is not null or v_token.revoked_at is not null or not exists (
    select 1 from app.advance_recipients r join app.advance_packets p on p.id = r.advance_packet_id
    where r.id = v_token.advance_recipient_id and r.deleted_at is null and p.deleted_at is null) then
    return query select null::uuid, 'advance_token_invalid'::text;
    return;
  end if;
  if not private.project_link_open((
    select p.project_id from app.advance_recipients r join app.advance_packets p on p.id = r.advance_packet_id
    where r.id = v_token.advance_recipient_id)) then
    return query select null::uuid, 'advance_link_ended'::text;
    return;
  end if;
  if v_token.failed_attempts >= 5 then
    return query select null::uuid, 'advance_token_locked'::text;
    return;
  end if;
  if v_token.access_code_hash <> private.advance_code_hash(p_token, p_access_code) then
    update app.advance_recipient_tokens t set failed_attempts = least(t.failed_attempts + 1, 5) where t.id = v_token.id;
    return query select null::uuid,
      (case when v_token.failed_attempts + 1 >= 5 then 'advance_token_locked' else 'advance_access_code' end)::text;
    return;
  end if;
  if v_token.expires_at <= now() then
    return query select null::uuid, 'advance_token_expired'::text;
    return;
  end if;
  return query select v_token.id, null::text;
end;
$$;

create or replace function private.resolve_document_token(p_token text, p_access_code text)
returns table (token_id uuid, reason text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_token app.engagement_document_tokens;
begin
  perform private.require_read_write();
  select * into v_token from app.engagement_document_tokens t where t.token_hash = private.document_token_hash(p_token) for update;
  if v_token.id is null or v_token.deleted_at is not null or v_token.revoked_at is not null or not exists (
    select 1 from app.engagement_documents d where d.id = v_token.engagement_document_id and d.deleted_at is null) then
    return query select null::uuid, 'document_token_invalid'::text;
    return;
  end if;
  if not private.project_link_open((
    select e.project_id from app.engagement_documents d join app.engagements e on e.id = d.engagement_id
    where d.id = v_token.engagement_document_id)) then
    return query select null::uuid, 'document_link_ended'::text;
    return;
  end if;
  if v_token.failed_attempts >= 5 then
    return query select null::uuid, 'document_token_locked'::text;
    return;
  end if;
  if v_token.access_code_hash <> private.document_code_hash(p_token, p_access_code) then
    update app.engagement_document_tokens t set failed_attempts = least(t.failed_attempts + 1, 5) where t.id = v_token.id;
    return query select null::uuid,
      (case when v_token.failed_attempts + 1 >= 5 then 'document_token_locked' else 'document_access_code' end)::text;
    return;
  end if;
  if v_token.expires_at <= now() then
    return query select null::uuid, 'document_token_expired'::text;
    return;
  end if;
  return query select v_token.id, null::text;
end;
$$;

create or replace function private.agreement_by_token(p_token text, p_access_code text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_agreement app.agreements;
begin
  perform private.require_read_write();
  select * into v_agreement from app.agreements a
  where a.token_hash = extensions.digest(coalesce(p_token, ''), 'sha256') for update;
  if v_agreement.id is null or v_agreement.deleted_at is not null or v_agreement.agreement_state <> 'Sent'
     or v_agreement.token_expires_at <= now() or v_agreement.failed_attempts >= 5 then
    return null;
  end if;
  if not private.project_link_open(v_agreement.project_id) then
    return null;
  end if;
  if v_agreement.access_code_hash <> extensions.crypt(coalesce(p_access_code, ''), v_agreement.access_code_hash) then
    perform private.begin_trusted_operation('agreement_signing');
    update app.agreements set failed_attempts = least(failed_attempts + 1, 5) where id = v_agreement.id;
    perform private.end_trusted_operation('agreement_signing');
    return null;
  end if;
  return v_agreement.id;
end;
$$;

create or replace function api_public.open_live_link(p_token text, p_access_code text default null, p_client_address text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_subjects record;
  v_hash bytea;
  v_link app.live_links;
  v_grant text;
  v_grant_expires timestamptz;
begin
  perform private.require_read_write();
  select * into v_subjects from private.live_link_subjects(p_client_address);
  if private.live_link_rate_limited(v_subjects.o_hop, v_subjects.o_subject) then
    return private.live_link_refusal('live_link_rate_limited');
  end if;

  if p_token is not null and p_token ~ '^xs(hv|cr)_[0-9a-f]{64}$' then
    v_hash := private.share_token_hash(p_token);
    select * into v_link from app.live_links l where l.token_hash = v_hash for update;
  end if;
  if v_link.id is null then
    -- A regenerated or revoked token is a screen left open, not a guess.
    if v_hash is null or not exists (select 1 from private.retired_live_link_tokens r where r.token_hash = v_hash) then
      perform private.note_live_link_failure(v_subjects.o_hop, v_subjects.o_subject);
    end if;
    return private.live_link_refusal('live_link_invalid');
  end if;
  if v_link.revoked_at is not null or v_link.deleted_at is not null then
    return private.live_link_refusal('live_link_invalid');
  end if;
  if not private.project_link_open(v_link.project_id) then
    return private.live_link_refusal('live_link_ended');
  end if;
  if v_link.failed_attempts >= 5 then
    perform private.note_live_link_failure(v_subjects.o_hop, v_subjects.o_subject);
    return private.live_link_refusal('live_link_locked');
  end if;
  if v_link.expires_at <= now() then
    return private.live_link_refusal('live_link_expired');
  end if;
  if nullif(btrim(coalesce(p_access_code, '')), '') is null then
    return private.live_link_refusal('live_link_access_code_required');
  end if;
  if v_link.access_code_hash <> private.share_code_hash(p_token, p_access_code) then
    perform private.begin_trusted_operation('live_link_service');
    update app.live_links l set failed_attempts = least(l.failed_attempts + 1, 5) where l.id = v_link.id;
    perform private.end_trusted_operation('live_link_service');
    perform private.note_live_link_failure(v_subjects.o_hop, v_subjects.o_subject);
    return private.live_link_refusal(case when v_link.failed_attempts + 1 >= 5 then 'live_link_locked' else 'live_link_access_code' end);
  end if;

  delete from private.live_link_grants g where g.expires_at < now() - interval '1 day';
  v_grant := 'xlgr_' || encode(extensions.gen_random_bytes(32), 'hex');
  v_grant_expires := least(v_link.expires_at, now() + interval '7 days');
  insert into private.live_link_grants (grant_hash, live_link_id, expires_at)
  values (private.share_token_hash(v_grant), v_link.id, v_grant_expires);

  perform private.begin_trusted_operation('live_link_service');
  update app.live_links l set open_count = l.open_count + 1, last_opened_at = now() where l.id = v_link.id;
  perform private.end_trusted_operation('live_link_service');

  return jsonb_build_object('status', 'ok', 'grant', v_grant, 'grant_expires_at', v_grant_expires, 'kind', v_link.link_kind);
end;
$$;

create or replace function private.live_link_reader(
  p_token text,
  p_grant text,
  p_client_address text,
  p_kind app.live_link_kind,
  out o_link app.live_links,
  out o_collection private.live_view_collections,
  out o_reason text
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_subjects record;
  v_hash bytea;
  v_grant_hash bytea;
  v_granted boolean;
  v_user uuid;
  v_claims text := current_setting('request.jwt.claims', true);
begin
  select * into v_subjects from private.live_link_subjects(p_client_address);
  if p_token is not null and p_token ~ (case p_kind when 'View' then '^xshv_[0-9a-f]{64}$' else '^xscr_[0-9a-f]{64}$' end) then
    v_hash := private.share_token_hash(p_token);
    select * into o_link from app.live_links l where l.token_hash = v_hash and l.link_kind = p_kind;
  end if;
  v_grant_hash := case when p_grant ~ '^xlgr_[0-9a-f]{64}$' then private.share_token_hash(p_grant) end;
  v_granted := o_link.id is not null and v_grant_hash is not null and exists (
    select 1 from private.live_link_grants g
    where g.grant_hash = v_grant_hash and g.live_link_id = o_link.id and g.expires_at > now()
  );
  -- The address failure limits stop guessing, so they apply only to a fetch without a valid grant: a device that
  -- already proved the code keeps reading, and nobody sharing its address (a venue's network, or the Atlas server's
  -- own egress) can blank its screen by spending that address's failures.
  if not v_granted and private.live_link_rate_limited(v_subjects.o_hop, v_subjects.o_subject) then
    o_reason := 'live_link_rate_limited';
    return;
  end if;
  if o_link.id is null then
    if v_hash is null or not exists (select 1 from private.retired_live_link_tokens r where r.token_hash = v_hash) then
      perform private.note_live_link_failure(v_subjects.o_hop, v_subjects.o_subject);
    end if;
    o_reason := 'live_link_invalid';
    return;
  end if;
  if o_link.revoked_at is not null or o_link.deleted_at is not null then
    o_reason := 'live_link_invalid';
  elsif o_link.expires_at <= now() then
    o_reason := 'live_link_expired';
  elsif not private.project_link_open(o_link.project_id) then
    o_reason := 'live_link_ended';
  end if;
  -- A link locked by wrong codes keeps serving the devices that already proved the code: the lock stops guessing, and
  -- must not let anyone holding the address blank every screen.
  if o_reason is not null then
    return;
  end if;

  if not v_granted then
    o_reason := 'live_link_grant';
    return;
  end if;
  -- Per grant, so one screen cannot exhaust its neighbors; per link, a ceiling for the link as a whole.
  if private.rate_limit_exceeded('live_link.fetch', encode(v_grant_hash, 'hex'), 1200, interval '1 hour')
     or private.rate_limit_exceeded('live_link.link_fetch', o_link.id::text, 60000, interval '1 hour') then
    o_reason := 'live_link_rate_limited';
    return;
  end if;
  perform private.note_rate_event('live_link.fetch', encode(v_grant_hash, 'hex'));
  perform private.note_rate_event('live_link.link_fetch', o_link.id::text);

  select * into o_collection from private.live_view_collections c
  where c.collection_key = private.live_link_collection_key(o_link.link_kind, o_link.saved_view_id);
  if o_collection.collection_key is null then
    o_reason := 'live_link_view_unsupported';
    return;
  end if;
  if exists (
    select 1 from private.live_view_fields f
    cross join lateral unnest(f.source_columns) as col (name)
    join private.column_classifications cc on cc.table_name = f.source_table and cc.column_name = col.name
    where f.collection_key = o_collection.collection_key and cc.classification in ('Confidential', 'Restricted')
  ) then
    o_reason := 'live_link_reclassified';
    return;
  end if;

  select p.user_id into v_user from app.people p where p.id = o_link.created_by and p.deleted_at is null;
  if v_user is null then
    o_reason := 'live_link_owner_access';
    return;
  end if;
  -- From here the link reads as its creator: the helpers the row level security policies use decide access.
  perform set_config('request.jwt.claims', json_build_object('sub', v_user, 'role', 'authenticated')::text, true);
  if not private.is_member(o_link.org_id) or not private.can_on_project(o_link.project_id, o_collection.read_capability) then
    perform set_config('request.jwt.claims', coalesce(v_claims, ''), true);
    o_reason := 'live_link_owner_access';
  end if;
end;
$$;

create or replace function api_public.open_showcaller_link(p_token text, p_access_code text default null, p_client_address text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_subjects record;
  v_hash bytea;
  v_link app.showcaller_links;
  v_grant text;
  v_grant_expires timestamptz;
  v_person_refusal text;
begin
  perform private.require_read_write();
  v_person_refusal := private.showcaller_person_refusal(null);
  if v_person_refusal is not null then
    return private.live_link_refusal(v_person_refusal);
  end if;
  select * into v_subjects from private.live_link_subjects(p_client_address);
  if private.live_link_rate_limited(v_subjects.o_hop, v_subjects.o_subject) then
    return private.live_link_refusal('showcaller_link_rate_limited');
  end if;

  if p_token is not null and p_token ~ '^xscl_[0-9a-f]{64}$' then
    v_hash := private.share_token_hash(p_token);
    select * into v_link from app.showcaller_links l where l.token_hash = v_hash for update;
  end if;
  if v_link.id is null then
    if v_hash is null or not exists (select 1 from private.retired_showcaller_link_tokens r where r.token_hash = v_hash) then
      perform private.note_live_link_failure(v_subjects.o_hop, v_subjects.o_subject);
    end if;
    return private.live_link_refusal('showcaller_link_invalid');
  end if;
  if v_link.revoked_at is not null or v_link.deleted_at is not null then
    return private.live_link_refusal('showcaller_link_invalid');
  end if;
  -- Before the lockout and the code: someone off the project learns neither and uses up no attempts.
  v_person_refusal := private.showcaller_person_refusal(v_link.project_id);
  if v_person_refusal is not null then
    return private.live_link_refusal(v_person_refusal);
  end if;
  if not private.project_link_open(v_link.project_id) then
    return private.live_link_refusal('showcaller_link_ended');
  end if;
  if v_link.failed_attempts >= 5 then
    perform private.note_live_link_failure(v_subjects.o_hop, v_subjects.o_subject);
    return private.live_link_refusal('showcaller_link_locked');
  end if;
  if v_link.expires_at <= now() then
    return private.live_link_refusal('showcaller_link_expired');
  end if;
  if nullif(btrim(coalesce(p_access_code, '')), '') is null then
    return private.live_link_refusal('showcaller_link_access_code_required');
  end if;
  if v_link.access_code_hash <> private.share_code_hash(p_token, p_access_code) then
    perform private.begin_trusted_operation('showcaller_link_service');
    update app.showcaller_links l set failed_attempts = least(l.failed_attempts + 1, 5) where l.id = v_link.id;
    perform private.end_trusted_operation('showcaller_link_service');
    perform private.note_live_link_failure(v_subjects.o_hop, v_subjects.o_subject);
    return private.live_link_refusal(case when v_link.failed_attempts + 1 >= 5 then 'showcaller_link_locked' else 'showcaller_link_access_code' end);
  end if;

  delete from private.showcaller_link_grants g where g.expires_at < now() - interval '1 day';
  if (select count(*) from private.showcaller_link_grants g where g.showcaller_link_id = v_link.id and g.expires_at > now()) >= 5 then
    return private.live_link_refusal('showcaller_link_devices');
  end if;
  v_grant := 'xcgr_' || encode(extensions.gen_random_bytes(32), 'hex');
  v_grant_expires := least(v_link.expires_at, now() + interval '48 hours');
  insert into private.showcaller_link_grants (grant_hash, showcaller_link_id, org_id, expires_at)
  values (private.share_token_hash(v_grant), v_link.id, v_link.org_id, v_grant_expires);

  perform private.begin_trusted_operation('showcaller_link_service');
  update app.showcaller_links l set open_count = l.open_count + 1, last_opened_at = now() where l.id = v_link.id;
  perform private.end_trusted_operation('showcaller_link_service');

  return jsonb_build_object('status', 'ok', 'grant', v_grant, 'grant_expires_at', v_grant_expires);
end;
$$;

create or replace function private.showcaller_link_reader(
  p_token text,
  p_grant text,
  p_client_address text,
  p_write boolean,
  out o_link app.showcaller_links,
  out o_grant_hash text,
  out o_grant_expires_at timestamptz,
  out o_reason text
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_subjects record;
  v_hash bytea;
  v_grant_hash bytea;
  v_user uuid;
  v_claims text := current_setting('request.jwt.claims', true);
  v_ok boolean;
begin
  perform private.require_read_write();
  o_reason := private.showcaller_person_refusal(null);
  if o_reason is not null then
    return;
  end if;
  select * into v_subjects from private.live_link_subjects(p_client_address);
  if p_token is not null and p_token ~ '^xscl_[0-9a-f]{64}$' then
    v_hash := private.share_token_hash(p_token);
    select * into o_link from app.showcaller_links l where l.token_hash = v_hash;
  end if;
  v_grant_hash := case when p_grant ~ '^xcgr_[0-9a-f]{64}$' then private.share_token_hash(p_grant) end;
  if o_link.id is not null and v_grant_hash is not null then
    select g.expires_at into o_grant_expires_at from private.showcaller_link_grants g
    where g.grant_hash = v_grant_hash and g.showcaller_link_id = o_link.id and g.expires_at > now();
  end if;
  -- The address limits stop guessing, so a device that already proved the code is never blanked by its address.
  if o_grant_expires_at is null and private.live_link_rate_limited(v_subjects.o_hop, v_subjects.o_subject) then
    o_reason := 'showcaller_link_rate_limited';
    return;
  end if;
  if o_link.id is null then
    -- A regenerated or revoked token is a portal left open, not a guess; anything else counts.
    if v_hash is null or not exists (select 1 from private.retired_showcaller_link_tokens r where r.token_hash = v_hash) then
      perform private.note_live_link_failure(v_subjects.o_hop, v_subjects.o_subject);
    end if;
    o_reason := 'showcaller_link_invalid';
    return;
  end if;
  if o_link.revoked_at is not null or o_link.deleted_at is not null then
    o_reason := 'showcaller_link_invalid';
    return;
  end if;
  if o_link.expires_at <= now() then
    o_reason := 'showcaller_link_expired';
    return;
  end if;
  o_reason := private.showcaller_person_refusal(o_link.project_id);
  if o_reason is not null then
    return;
  end if;
  if not private.project_link_open(o_link.project_id) then
    o_reason := 'showcaller_link_ended';
    return;
  end if;
  -- A link locked by wrong codes keeps serving the devices that proved the code.
  if o_grant_expires_at is null then
    o_reason := 'showcaller_link_grant';
    return;
  end if;
  o_grant_hash := encode(v_grant_hash, 'hex');
  if p_write then
    if private.rate_limit_exceeded('showcaller_link.write', o_grant_hash, 1800, interval '1 hour') then
      o_reason := 'showcaller_link_rate_limited';
      return;
    end if;
    perform private.note_rate_event('showcaller_link.write', o_grant_hash);
  else
    if private.rate_limit_exceeded('showcaller_link.read', o_grant_hash, 7200, interval '1 hour')
       or private.rate_limit_exceeded('showcaller_link.link_read', o_link.id::text, 40000, interval '1 hour') then
      o_reason := 'showcaller_link_rate_limited';
      return;
    end if;
    perform private.note_rate_event('showcaller_link.read', o_grant_hash);
    perform private.note_rate_event('showcaller_link.link_read', o_link.id::text);
  end if;

  if exists (
    select 1 from private.showcaller_portal_columns() pc
    join private.column_classifications cc on cc.table_name = pc.table_name and cc.column_name = pc.column_name
    where cc.classification in ('Confidential', 'Restricted')
  ) then
    o_reason := 'showcaller_link_reclassified';
    return;
  end if;
  if not exists (select 1 from app.run_of_show r join app.projects p on p.id = r.project_id
                 where r.id = o_link.run_of_show_id and r.deleted_at is null and p.deleted_at is null) then
    o_reason := 'showcaller_link_run_removed';
    return;
  end if;

  -- The creator still answers for the link: a member with both capabilities. Checked as the creator, then the claims
  -- go back; reads and writes run as anon.
  select p.user_id into v_user from app.people p where p.id = o_link.created_by and p.deleted_at is null;
  if v_user is null then
    o_reason := 'showcaller_link_owner_access';
    return;
  end if;
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', v_user, 'role', 'authenticated')::text, true);
    v_ok := private.is_member(o_link.org_id)
      and private.can_on_project(o_link.project_id, 'show.run_of_show.write')
      and private.can_on_project(o_link.project_id, 'show.cue.call');
    perform set_config('request.jwt.claims', coalesce(v_claims, ''), true);
  exception when others then
    perform set_config('request.jwt.claims', coalesce(v_claims, ''), true);
    raise;
  end;
  if not coalesce(v_ok, false) then
    o_reason := 'showcaller_link_owner_access';
  end if;
end;
$$;

create or replace function private.approval_link_state(p_token private.notification_action_tokens)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when p_token.id is null or p_token.subject_table <> 'subject_approvals' then 'invalid'
    when p_token.revoked_at is not null and n.archived_at is null and n.deleted_at is null then 'invalid'
    when p_token.sign_in_required then 'sign_in'
    when n.id is not null and not private.project_link_open(n.project_id) then 'ended'
    when p_token.failed_attempts >= 5 then 'locked'
    when p_token.revoked_at is not null or n.archived_at is not null or n.deleted_at is not null
      or exists (select 1 from private.notification_action_tokens t where t.notification_id = p_token.notification_id and t.used_at is not null)
      or private.subject_approval_state(p_token.subject_id) is distinct from 'In Review'
      or private.subject_approval_current_step(p_token.subject_id) is distinct from (n.message_args ->> 'stepOrder')::smallint
      then 'used'
    when p_token.expires_at <= now() then 'expired'
    else 'ready'
  end
  from (select null) x
  left join app.notifications n on n.id = p_token.notification_id and n.created_at = p_token.notification_created_at;
$$;

create or replace function api_public.read_approval_link(p_token text)
returns table (link_state text, action text, org_name text, masked_email text, expires_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_token private.notification_action_tokens := private.find_notification_action_token(p_token);
  v_state text := private.approval_link_state(v_token);
begin
  if v_state in ('invalid', 'sign_in', 'ended') then
    return query select v_state, null::text, null::text, null::text, null::timestamptz;
    return;
  end if;
  return query select v_state, v_token.action,
    (select o.name from app.organizations o where o.id = v_token.org_id),
    private.mask_email(private.recipient_address(v_token.recipient_person_id, 'Email')),
    v_token.expires_at;
end;
$$;

create or replace function api_public.preview_approval_link(p_token text, p_access_code text)
returns table (outcome text, attempts_left smallint, title text, current_step_name text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_token private.notification_action_tokens;
  v_state text;
  v_check record;
begin
  perform private.require_read_write();
  v_token := private.approval_link_token_for_update(p_token);
  v_state := private.approval_link_state(v_token);
  if v_state in ('invalid', 'sign_in') then
    return query select 'notification_action_invalid'::text, null::smallint, null::text, null::text;
    return;
  end if;
  if v_state = 'ended' then
    return query select 'approval_link_ended'::text, null::smallint, null::text, null::text;
    return;
  end if;
  if v_state = 'locked' then
    return query select 'approval_link_locked'::text, 0::smallint, null::text, null::text;
    return;
  end if;
  select * into v_check from private.check_approval_link_code(v_token, p_access_code);
  if v_check.outcome <> 'ok' then
    return query select v_check.outcome, v_check.attempts_left, null::text, null::text;
    return;
  end if;
  if v_state = 'used' then
    return query select 'notification_action_used'::text, v_check.attempts_left, null::text, null::text;
    return;
  end if;
  if v_state = 'expired' then
    return query select 'notification_action_expired'::text, v_check.attempts_left, null::text, null::text;
    return;
  end if;
  return query select 'ok'::text, v_check.attempts_left, private.subject_approval_title(v_token.subject_id),
    (select s.current_step_name from app.subject_approvals a
     cross join lateral private.subject_approval_progress(a.id, a.approval_rule_id, a.canceled_at, a.created_at) s
     where a.id = v_token.subject_id);
end;
$$;

create or replace function api_public.use_approval_link(p_token text, p_access_code text, p_comment text default null)
returns table (outcome text, attempts_left smallint, notification_id uuid)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_token private.notification_action_tokens;
  v_state text;
  v_check record;
  v_comment text := nullif(btrim(coalesce(p_comment, '')), '');
begin
  perform private.require_read_write();
  v_token := private.approval_link_token_for_update(p_token);
  v_state := private.approval_link_state(v_token);
  if v_state in ('invalid', 'sign_in') then
    return query select 'notification_action_invalid'::text, null::smallint, null::uuid;
    return;
  end if;
  if v_state = 'ended' then
    return query select 'approval_link_ended'::text, null::smallint, null::uuid;
    return;
  end if;
  if v_state = 'locked' then
    return query select 'approval_link_locked'::text, 0::smallint, null::uuid;
    return;
  end if;
  select * into v_check from private.check_approval_link_code(v_token, p_access_code);
  if v_check.outcome <> 'ok' then
    return query select v_check.outcome, v_check.attempts_left, null::uuid;
    return;
  end if;
  if v_state = 'used' then
    return query select 'notification_action_used'::text, v_check.attempts_left, null::uuid;
    return;
  end if;
  if v_state = 'expired' then
    return query select 'notification_action_expired'::text, v_check.attempts_left, null::uuid;
    return;
  end if;
  if v_token.action = 'reject' and v_comment is null then
    return query select 'notification_action_reason'::text, v_check.attempts_left, null::uuid;
    return;
  end if;
  -- Use the code and every link of the notification first: the decision retires the step's other links.
  update private.notification_action_codes c set used_at = now()
  where c.used_at is null and c.revoked_at is null
    and c.token_id in (select t.id from private.notification_action_tokens t where t.notification_id = v_token.notification_id);
  update private.notification_action_tokens t set used_at = now()
  where t.notification_id = v_token.notification_id and t.used_at is null;
  -- Every rule of the decision still decides; its refusals propagate, and roll back the uses above.
  perform private.decide_subject_approval_as(v_token.subject_id, v_token.recipient_person_id, v_token.action = 'approve',
    v_comment, 'Email link');
  update app.notifications n set read_at = coalesce(n.read_at, now()), archived_at = coalesce(n.archived_at, now())
  where n.id = v_token.notification_id and n.created_at = v_token.notification_created_at;
  return query select 'decided'::text, v_check.attempts_left, v_token.notification_id;
end;
$$;

create or replace function api_public.request_approval_link_code(p_token text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_token private.notification_action_tokens;
  v_state text;
  v_siblings uuid[];
  v_note app.notifications;
  v_org_name text;
  v_code_note uuid;
begin
  perform private.require_read_write();
  v_token := private.approval_link_token_for_update(p_token);
  v_state := private.approval_link_state(v_token);
  if v_state in ('invalid', 'sign_in') then
    perform private.refuse('notification_action_invalid', 'This link does not work. Open the item from your Inbox.');
  elsif v_state = 'locked' then
    perform private.refuse('approval_link_locked', 'Too many wrong codes. This link is locked; sign in to decide.');
  elsif v_state = 'used' then
    perform private.refuse('notification_action_used', 'This was already handled.');
  elsif v_state = 'ended' then
    perform private.refuse('approval_link_ended', 'This link has ended.');
  elsif v_state = 'expired' then
    perform private.refuse('notification_action_expired', 'This link has expired. Open the item from your Inbox.');
  end if;
  select array_agg(t.id) into v_siblings from private.notification_action_tokens t where t.notification_id = v_token.notification_id;
  -- One code request a minute and five an hour, across every link of the notification.
  if exists (select 1 from app.notifications n
             where n.kind = 'approval.link_code' and n.subject_table = 'notification_action_tokens' and n.subject_id = any (v_siblings)
               and n.created_at > now() - interval '60 seconds')
     or (select count(*) from app.notifications n
         where n.kind = 'approval.link_code' and n.subject_table = 'notification_action_tokens' and n.subject_id = any (v_siblings)
           and n.created_at > now() - interval '1 hour') >= 5 then
    perform private.refuse('approval_link_code_too_soon', 'A code was sent a moment ago. Wait a minute, then ask again; at most five codes are sent an hour.');
  end if;
  select * into v_note from app.notifications n where n.id = v_token.notification_id and n.created_at = v_token.notification_created_at;
  v_org_name := (select o.name from app.organizations o where o.id = v_token.org_id);
  v_code_note := private.notify(v_token.org_id, v_token.recipient_person_id, 'approval.link_code', 'notification_action_tokens',
    v_token.id, v_note.project_id,
    jsonb_build_object('title', v_note.message_args ->> 'title', 'orgName', v_org_name, 'actorName', v_org_name));
  if v_code_note is null or not exists (select 1 from app.notification_deliveries d
                                        where d.notification_id = v_code_note and d.channel = 'Email') then
    perform private.refuse('approval_link_email_off', 'Your approval emails are turned off, so no code can be sent. Sign in to decide.');
  end if;
  -- The code's notice never shows in the Inbox, Gateway Home, the API or Compass; the dispatcher still sends its email.
  update app.notifications set archived_at = now() where id = v_code_note;
end;
$$;

-- 2200_one_tap_actions.sql
-- A127 (RRR-172), Section 11.10 rule 5 ("act where notifications arrive"), trace row S11.10-06, ADR 0106.
--   * private.notification_action_tokens and the Vault key xos_notification_action_key: signed, single-use links an
--     email carries for the actions its Inbox item offers (approve, reject with a reason, accept). Only a SHA-256 hash
--     of each token is stored; the token is signed with the key, so a forged one is refused before any lookup
--   * app.mint_notification_action_tokens: the email sender mints them at dispatch (service role)
--   * app.read_notification_action and app.use_notification_action: the confirm page in Atlas or Gateway reads what a
--     link does without acting (a GET never acts) and acts on a press, for the signed-in recipient only and only in
--     the app the link was sent for, through app.act_on_notification, so every rule and step-up still decides
--   * app.act_on_notification takes accept and decline for shift and engagement offers and reply for a message, which
--     Compass's push actions send through notifications.act; Done and the new actions reach every recipient who may
--     still see the notification (private.is_my_notification), so an external party acts too (approve and reject
--     still need membership)
--   * app.my_notifications_awaiting_answer: the shifts and offers still waiting on the person, which Gateway's For Your
--     Information list leaves out
--   * app.decline_shift: the worker declines a published shift, which returns to Draft for the scheduler
--   * offer.sent: the applicant is told when an org sends or revises an offer; while it waits on them the org counts as
--     one they work with (private.party_org_ids), so the notice reaches them by email and push, and they keep the
--     notice itself after they answer (private.offer_notice_mine, in the notifications policy)
--   * shift notices say the shift's state (shiftState), so a push offers Accept only on a shift still to accept
--   * inbox snoozes are the recipient's own wherever the notification came from, so Gateway's For Your Information
--     list snoozes an external party's notifications too

-- 1. The signing key -------------------------------------------------------------------------------------------------------

do $$
begin
  if not exists (select 1 from vault.secrets s where s.name = 'xos_notification_action_key') then
    perform vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'xos_notification_action_key',
      'Signs one-tap action links in notification emails (Section 11.10 rule 5, ADR 0106). Generated per environment; rotating it invalidates every open link.');
  end if;
end $$;

create or replace function private.notification_action_key()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select s.decrypted_secret from vault.decrypted_secrets s where s.name = 'xos_notification_action_key';
$$;

comment on function private.notification_action_key() is 'The Vault key that signs one-tap action links in notification emails (ADR 0106). Never granted to signed-in callers.';
revoke all on function private.notification_action_key() from public, anon, authenticated;

create or replace function private.notification_action_signature(p_nonce text, p_action text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select left(encode(extensions.hmac(convert_to('notification_action.' || p_nonce || '.' || p_action, 'UTF8'),
    convert_to(private.notification_action_key(), 'UTF8'), 'sha256'), 'hex'), 32);
$$;

comment on function private.notification_action_signature(text, text) is 'HMAC-SHA256 of a link''s nonce and action under xos_notification_action_key, the first 32 hex digits: the signature half of an action token (ADR 0106).';
revoke all on function private.notification_action_signature(text, text) from public, anon, authenticated;

-- 2. Tokens ------------------------------------------------------------------------------------------------------------------

create table private.notification_action_tokens (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  notification_id uuid not null,
  notification_created_at timestamptz not null,
  delivery_id uuid not null,
  recipient_person_id uuid not null references app.people (id),
  kind text not null,
  action text not null,
  subject_table text not null,
  subject_id uuid not null,
  audience text not null,
  token_hash bytea not null,
  expires_at timestamptz not null,
  used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  constraint notification_action_tokens_action check (action in ('approve', 'reject', 'accept')),
  constraint notification_action_tokens_audience check (audience in ('Atlas', 'Gateway')),
  constraint notification_action_tokens_hash_length check (octet_length(token_hash) = 32),
  constraint notification_action_tokens_expiry check (expires_at > created_at)
);

create unique index notification_action_tokens_hash_key on private.notification_action_tokens (token_hash);
create index notification_action_tokens_notification_idx on private.notification_action_tokens (notification_id);
create index notification_action_tokens_delivery_idx on private.notification_action_tokens (delivery_id);
create index notification_action_tokens_recipient_idx on private.notification_action_tokens (recipient_person_id);
create index notification_action_tokens_org_idx on private.notification_action_tokens (org_id);
create index notification_action_tokens_expires_idx on private.notification_action_tokens (expires_at);

alter table private.notification_action_tokens enable row level security;
revoke all on private.notification_action_tokens from public, anon, authenticated;
grant select, insert, update, delete on private.notification_action_tokens to service_role;

comment on table private.notification_action_tokens is 'One-tap action links in notification emails (Section 11.10 rule 5, ADR 0106): one row per action an email offers. Only the SHA-256 of the token is stored; the token itself is signed with xos_notification_action_key. Single use: acting through any link of a notification uses them all. Read and written only by the action token functions.';
comment on column private.notification_action_tokens.id is 'Token row id, UUID v7.';
comment on column private.notification_action_tokens.org_id is 'Org of the notification.';
comment on column private.notification_action_tokens.notification_id is 'Notification the link acts on.';
comment on column private.notification_action_tokens.notification_created_at is 'Creation time of the notification, its partition key.';
comment on column private.notification_action_tokens.delivery_id is 'Email delivery the link was minted for; a retried delivery revokes the links of its earlier attempt.';
comment on column private.notification_action_tokens.recipient_person_id is 'The only person who may use the link: the notification''s recipient, signed in.';
comment on column private.notification_action_tokens.kind is 'Notification kind, such as approval.requested.';
comment on column private.notification_action_tokens.action is 'What the link does: approve, reject (asks for a reason) or accept.';
comment on column private.notification_action_tokens.subject_table is 'Table of the record the notification is about.';
comment on column private.notification_action_tokens.subject_id is 'Record the notification is about.';
comment on column private.notification_action_tokens.audience is 'App whose confirm page the link opens: Atlas for members, Gateway for external parties and applicants.';
comment on column private.notification_action_tokens.token_hash is 'SHA-256 of the whole token; the token is never stored.';
comment on column private.notification_action_tokens.expires_at is 'When the link stops working: 7 days after it was minted.';
comment on column private.notification_action_tokens.used_at is 'When the notification was acted on through one of its links; every link of the notification is used then.';
comment on column private.notification_action_tokens.revoked_at is 'When a later attempt of the same delivery replaced the link.';
comment on column private.notification_action_tokens.created_at is 'When the link was minted.';

create or replace function private.notification_action_token_hash(p_token text)
returns bytea
language sql
immutable
set search_path = ''
as $$
  select extensions.digest(coalesce(p_token, ''), 'sha256');
$$;

comment on function private.notification_action_token_hash(text) is 'SHA-256 of an action token, the only form stored.';
revoke all on function private.notification_action_token_hash(text) from public, anon, authenticated;

create or replace function private.find_notification_action_token(p_token text)
returns private.notification_action_tokens
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_parts text[] := regexp_match(coalesce(p_token, ''), '^xact_([0-9a-f]{48})\.([0-9a-f]{32})$');
  v_row private.notification_action_tokens;
begin
  if v_parts is null then
    return null;
  end if;
  select * into v_row from private.notification_action_tokens t
  where t.token_hash = private.notification_action_token_hash(p_token);
  -- The signature binds the token to its action: a token whose signature does not match is refused as unknown.
  if v_row.id is null or private.notification_action_signature(v_parts[1], v_row.action) <> v_parts[2] then
    return null;
  end if;
  return v_row;
end;
$$;

comment on function private.find_notification_action_token(text) is 'The token row of an action link, or null for a malformed token, an unknown one or one whose signature does not match its action (ADR 0106).';
revoke all on function private.find_notification_action_token(text) from public, anon, authenticated;

-- 3. What an email may offer ----------------------------------------------------------------------------------------------

create or replace function private.notification_link_actions(p_notification_id uuid)
returns table (action text, audience text)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_note app.notifications;
  v_shift app.shifts;
begin
  select * into v_note from app.notifications n
  where n.id = p_notification_id and n.deleted_at is null and n.archived_at is null;
  if v_note.id is null or v_note.subject_id is null then
    return;
  end if;
  if v_note.kind = 'approval.requested' then
    if (v_note.subject_table = 'approval_instances' and exists (
          select 1 from app.approval_instances a where a.id = v_note.subject_id and a.deleted_at is null and a.approval_state = 'In Review'))
       or (v_note.subject_table = 'timesheets' and exists (
          select 1 from app.timesheets t where t.id = v_note.subject_id and t.deleted_at is null and t.timesheet_state = 'Submitted')) then
      return query values ('approve'::text, 'Atlas'::text), ('reject', 'Atlas');
    end if;
  elsif v_note.kind in ('shift.assigned', 'shift.changed') and v_note.subject_table = 'app.shifts' then
    select * into v_shift from app.shifts s where s.id = v_note.subject_id and s.deleted_at is null;
    if v_shift.shift_state = 'Published'
       and private.shift_worker_person_id(v_shift.membership_id, v_shift.engagement_id) = v_note.recipient_person_id then
      return query select 'accept'::text, (case when v_shift.membership_id is null then 'Gateway' else 'Atlas' end)::text;
    end if;
  elsif v_note.kind = 'offer.sent' and v_note.subject_table = 'app.offers' then
    if exists (select 1 from app.offers o where o.id = v_note.subject_id and o.deleted_at is null and o.offer_state = 'Sent') then
      return query values ('accept'::text, 'Gateway'::text);
    end if;
  end if;
end;
$$;

comment on function private.notification_link_actions(uuid) is 'The actions an email of a notification carries links for, with the app that confirms them, exactly where its Inbox item or push offers them now: approve and reject for an approval or a timesheet awaiting a decision (Atlas), accept for a published shift the recipient works (Atlas for a member, Gateway for an engaged worker) and for an offer awaiting the applicant (Gateway). None once the notification is Done.';
revoke all on function private.notification_link_actions(uuid) from public, anon, authenticated;

-- 4. Minting at dispatch -------------------------------------------------------------------------------------------------------

create or replace function app.mint_notification_action_tokens(p_delivery_id uuid)
returns table (action text, token text, audience text, expires_at timestamptz)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_delivery app.notification_deliveries;
  v_note app.notifications;
  v_offer record;
  v_nonce text;
  v_token text;
  v_expires timestamptz := now() + interval '7 days';
begin
  select * into v_delivery from app.notification_deliveries d where d.id = p_delivery_id and d.channel = 'Email';
  if v_delivery.id is null then
    return;
  end if;
  select * into v_note from app.notifications n
  where n.id = v_delivery.notification_id and n.created_at = v_delivery.notification_created_at;
  -- A retried delivery mints fresh links; the earlier attempt's links stop working.
  update private.notification_action_tokens t set revoked_at = now()
  where t.delivery_id = p_delivery_id and t.used_at is null and t.revoked_at is null;
  -- Links long past their expiry are of no use to anyone.
  delete from private.notification_action_tokens t where t.expires_at < now() - interval '30 days';
  for v_offer in select * from private.notification_link_actions(v_note.id) loop
    v_nonce := encode(extensions.gen_random_bytes(24), 'hex');
    v_token := 'xact_' || v_nonce || '.' || private.notification_action_signature(v_nonce, v_offer.action);
    insert into private.notification_action_tokens (org_id, notification_id, notification_created_at, delivery_id,
      recipient_person_id, kind, action, subject_table, subject_id, audience, token_hash, expires_at)
    values (v_note.org_id, v_note.id, v_note.created_at, p_delivery_id, v_note.recipient_person_id, v_note.kind,
      v_offer.action, v_note.subject_table, v_note.subject_id, v_offer.audience,
      private.notification_action_token_hash(v_token), v_expires);
    action := v_offer.action;
    token := v_token;
    audience := v_offer.audience;
    expires_at := v_expires;
    return next;
  end loop;
end;
$$;

comment on function app.mint_notification_action_tokens(uuid) is 'Email dispatch API (service role): mints the signed, single-use links an email delivery carries for the actions its notification offers now (private.notification_link_actions), each valid 7 days, and revokes the links of an earlier attempt of the same delivery. Returns each action, its token (shown here only), the app whose confirm page opens it, and the expiry. None for an email that offers no action (ADR 0106).';
revoke all on function app.mint_notification_action_tokens(uuid) from public, anon, authenticated;
grant execute on function app.mint_notification_action_tokens(uuid) to service_role;

-- 5. The confirm page ---------------------------------------------------------------------------------------------------------

create or replace function app.read_notification_action(p_token text, p_app text)
returns table (
  link_state text, action text, kind text, title text, org_name text, org_slug text, audience text,
  expires_at timestamptz, notification_id uuid
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
  v_token private.notification_action_tokens := private.find_notification_action_token(p_token);
  v_note app.notifications;
begin
  if v_token.id is null or v_token.revoked_at is not null then
    return query select 'invalid'::text, null::text, null::text, null::text, null::text, null::text, null::text, null::timestamptz, null::uuid;
    return;
  end if;
  -- Someone else's link says nothing about what it does.
  if v_token.recipient_person_id <> v_person then
    return query select 'not_yours'::text, null::text, null::text, null::text, null::text, null::text, null::text, null::timestamptz, null::uuid;
    return;
  end if;
  -- A link is confirmed only in the app it was sent for: Atlas applies the org's security settings to a member, and
  -- Gateway does not, so a member's link opened on Gateway's host does nothing there.
  if p_app is distinct from v_token.audience then
    return query select 'elsewhere'::text, null::text, null::text, null::text, null::text, null::text, v_token.audience, null::timestamptz, null::uuid;
    return;
  end if;
  select * into v_note from app.notifications n
  where n.id = v_token.notification_id and n.created_at = v_token.notification_created_at;
  return query select
    (case when v_token.used_at is not null or v_note.archived_at is not null or v_note.deleted_at is not null then 'used'
          when v_token.expires_at <= now() then 'expired'
          else 'ready' end)::text,
    v_token.action, v_token.kind, v_note.message_args ->> 'title',
    (select o.name from app.organizations o where o.id = v_token.org_id),
    (select o.slug from app.organizations o where o.id = v_token.org_id),
    v_token.audience, v_token.expires_at, v_token.notification_id;
end;
$$;

comment on function app.read_notification_action(text, text) is 'The confirm page of a one-tap email link (ADR 0106): what the link does, for the signed-in recipient only, without acting. p_app is the app whose confirm page asks (Atlas or Gateway). link_state is ready, used (acted on through this or another link, or Done in the Inbox), expired, elsewhere (the link is confirmed in the other app, named in audience; nothing else is said), not_yours (signed in as someone else; nothing else is said) or invalid (unknown, forged or replaced).';
revoke all on function app.read_notification_action(text, text) from public, anon;
grant execute on function app.read_notification_action(text, text) to authenticated, service_role;

create or replace function app.use_notification_action(p_token text, p_app text, p_comment text default null)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
  v_token private.notification_action_tokens := private.find_notification_action_token(p_token);
  v_note app.notifications;
begin
  if v_token.id is null or v_token.revoked_at is not null then
    perform private.refuse('notification_action_invalid', 'This link does not work. Open the item from your Inbox.');
  end if;
  if v_token.recipient_person_id <> v_person then
    perform private.refuse('notification_action_not_yours', 'This link was sent to someone else. Sign in as the person it was sent to.');
  end if;
  if p_app is distinct from v_token.audience then
    perform private.refuse('notification_action_elsewhere',
      format('This link opens in %s. Use the button in the email.', v_token.audience));
  end if;
  select * into v_token from private.notification_action_tokens t where t.id = v_token.id for update;
  select * into v_note from app.notifications n
  where n.id = v_token.notification_id and n.created_at = v_token.notification_created_at;
  if v_token.used_at is not null or v_note.archived_at is not null or v_note.deleted_at is not null then
    perform private.refuse('notification_action_used', 'This was already handled.');
  end if;
  if v_token.expires_at <= now() then
    perform private.refuse('notification_action_expired', 'This link has expired. Open the item from your Inbox.');
  end if;
  if v_token.action = 'reject' and nullif(btrim(coalesce(p_comment, '')), '') is null then
    perform private.refuse('notification_action_reason', 'Say why when you reject.');
  end if;
  -- The in-app action decides: every approval, timesheet, shift and offer rule, and step-up, as from the Inbox.
  perform app.act_on_notification(v_token.notification_id, v_token.action, nullif(btrim(coalesce(p_comment, '')), ''));
  update private.notification_action_tokens t set used_at = now()
  where t.notification_id = v_token.notification_id and t.used_at is null;
  return v_token.notification_id;
end;
$$;

comment on function app.use_notification_action(text, text, text) is 'Acts through a one-tap email link (ADR 0106), on the confirm page''s press, never on opening it: only the signed-in recipient, only in the app the link was sent for (p_app: Atlas for a member, whose org''s security settings Atlas applies; Gateway for an external party or an applicant), once, before it expires; a rejection needs a reason. Runs app.act_on_notification as the person, so every rule and step-up still decides, and a refusal leaves the link unused. Using it uses every link of the notification. Returns the notification id.';
revoke all on function app.use_notification_action(text, text, text) from public, anon;
grant execute on function app.use_notification_action(text, text, text) to authenticated, service_role;

create or replace function app.my_notifications_awaiting_answer()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select n.id from app.notifications n
  where n.recipient_person_id = private.current_person_id()
    and n.kind in ('shift.assigned', 'shift.changed', 'offer.sent')
    and n.archived_at is null and n.deleted_at is null
    and exists (select 1 from private.notification_link_actions(n.id) a where a.action = 'accept');
$$;

comment on function app.my_notifications_awaiting_answer() is 'The signed-in person''s live notifications that still wait on their answer: a published shift they work, or an offer awaiting them (the ones whose email offers Accept now, private.notification_link_actions). Gateway leaves them out of For Your Information, where Done would retire their email links while the shift or offer is still unanswered (ADR 0106).';
revoke all on function app.my_notifications_awaiting_answer() from public, anon;
grant execute on function app.my_notifications_awaiting_answer() to authenticated, service_role;

-- 6. Declining a shift ---------------------------------------------------------------------------------------------------------

create or replace function app.decline_shift(p_shift_id uuid, p_reason text default null)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
  v_shift app.shifts;
  v_reason text := coalesce(nullif(btrim(coalesce(p_reason, '')), ''), 'No reason given.');
  v_assigned boolean;
begin
  select * into v_shift from app.shifts s where s.id = p_shift_id and s.deleted_at is null for update;
  -- The shift's member, or its engaged worker while the operational area is open. Every test is written so it is never
  -- null: an open or engaged shift has no membership, and `null in (...)` would let anyone through a negated check.
  v_assigned := v_shift.id is not null and (
    (v_shift.membership_id is not null
      and exists (select 1 from private.my_membership_ids() m (id) where m.id = v_shift.membership_id))
    or (v_shift.membership_id is null and v_shift.engagement_id is not null
      and exists (select 1 from app.engagements e where e.id = v_shift.engagement_id and e.person_id = v_person)
      and exists (select 1 from private.my_engagement_ids('operational') x (id) where x.id = v_shift.engagement_id)));
  if not coalesce(v_assigned, false) then
    raise exception using errcode = '42501', message = 'only the person assigned declines a shift';
  end if;
  if v_shift.shift_state <> 'Published' then
    perform private.refuse('shift_decline_state', 'Only a published shift you have not accepted can be declined.');
  end if;
  return private.transition_lifecycle('shift', 'app.shifts', 'shift_state', 'app.shift_state_transitions',
    'shift_id', p_shift_id, 'Published', 'Draft', left('Declined by the worker: ' || v_reason, 500));
end;
$$;

comment on function app.decline_shift(uuid, text) is 'The person assigned to a Published shift (its member, or its engaged worker while the operational area is open) declines it: the shift returns to Draft with the reason in its ledger, for the scheduler to reassign and publish again. Returns the ledger entry id.';
revoke all on function app.decline_shift(uuid, text) from public, anon;
grant execute on function app.decline_shift(uuid, text) to authenticated, service_role;

-- 7. Acting where notifications arrive (from 1140) ------------------------------------------------------------------------------

create or replace function app.act_on_notification(p_notification_id uuid, p_action text, p_comment text default null)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
  v_note app.notifications;
  v_shift app.shifts;
  v_comment text := nullif(btrim(coalesce(p_comment, '')), '');
  v_conversation uuid;
begin
  select * into v_note from app.notifications n
  where n.id = p_notification_id and n.recipient_person_id = v_person and n.deleted_at is null;
  -- Approving and rejecting are a member's. Done and answering a shift, an offer or a message are the recipient's while
  -- the notification is still theirs to see (private.is_my_notification: a member, an external party or an applicant
  -- the org works with, as row level security on notifications reads it) (A127).
  if v_note.id is null or not coalesce(case when p_action in ('approve', 'reject')
                                            then v_note.org_id in (select private.my_org_ids())
                                            else private.is_my_notification(v_note.id) end, false) then
    raise exception using errcode = '42501', message = 'notification not found';
  end if;
  if p_action is null or p_action not in ('approve', 'reject', 'done', 'accept', 'decline', 'reply') then
    perform private.refuse('inbox_action_unknown', 'An Inbox item is approved, rejected, accepted, declined, answered or marked Done.');
  end if;
  if p_action in ('approve', 'reject') then
    if v_note.kind <> 'approval.requested' or v_note.subject_table not in ('approval_instances', 'timesheets') then
      perform private.refuse('inbox_action_not_offered', 'Only an approval request is approved or rejected from the Inbox.');
    end if;
    if v_note.subject_table = 'timesheets' then
      if p_action = 'reject' and v_comment is null then
        perform private.refuse('timesheet_rejection_reason', 'Say why when you reject a timesheet.');
      end if;
      perform app.decide_timesheet(v_note.subject_id,
        (case when p_action = 'approve' then 'Approved' else 'Rejected' end)::app.approval_decision,
        coalesce(v_comment, 'Approved from a notification.'));
    else
      perform app.decide_approval(v_note.subject_id, p_action = 'approve', p_comment);
    end if;
  elsif p_action in ('accept', 'decline') then
    if v_note.kind in ('shift.assigned', 'shift.changed') and v_note.subject_table = 'app.shifts' then
      select * into v_shift from app.shifts s where s.id = v_note.subject_id;
      if p_action = 'decline' then
        perform app.decline_shift(v_note.subject_id, v_comment);
      elsif v_shift.membership_id is null and v_shift.engagement_id is not null then
        perform app.accept_engaged_shift(v_note.subject_id, 'Accepted from a notification.');
      else
        perform app.accept_shift(v_note.subject_id, 'Accepted from a notification.');
      end if;
    elsif v_note.kind = 'offer.sent' and v_note.subject_table = 'app.offers' then
      if p_action = 'accept' then
        perform app.accept_offer(v_note.subject_id);
      else
        perform app.decline_offer(v_note.subject_id, coalesce(v_comment, 'Declined from a notification.'));
      end if;
    else
      perform private.refuse('inbox_action_not_offered', 'Only a shift or an offer is accepted or declined from a notification.');
    end if;
  elsif p_action = 'reply' then
    v_conversation := case when v_note.message_args ->> 'conversation_id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                           then (v_note.message_args ->> 'conversation_id')::uuid end;
    if v_note.kind <> 'message.received' or v_conversation is null then
      perform private.refuse('inbox_action_not_offered', 'Only a message is answered from a notification.');
    end if;
    if v_comment is null then
      perform private.refuse('notification_reply_empty', 'Write a reply first.');
    end if;
    perform app.send_chat_message(v_conversation, v_comment);
  end if;
  update app.notifications set read_at = coalesce(read_at, now()), archived_at = now()
  where id = v_note.id and created_at = v_note.created_at;
  return v_note.id;
end;
$$;
comment on function app.act_on_notification(uuid, text, text) is 'Acts on a notification where it arrives (Section 11.10 rule 5), for its recipient only, while it is still theirs to see (private.is_my_notification): approve or reject the approval or the timesheet an approval request asks for (a member''s; app.decide_approval and app.decide_timesheet decide every rule); accept or decline a published shift (app.accept_shift, app.accept_engaged_shift, app.decline_shift) or an offer awaiting the applicant (app.accept_offer, app.decline_offer); reply to a message (app.send_chat_message, the reply in p_comment); or mark it Done. A refusal names its rule and the item stays; a handled or Done item leaves the Inbox. Push notification actions call it through the API (notifications.act) and one-tap email links through app.use_notification_action. Returns the notification id.';
revoke all on function app.act_on_notification(uuid, text, text) from public, anon;
grant execute on function app.act_on_notification(uuid, text, text) to authenticated, service_role;

-- 8. Offers reach the applicant -----------------------------------------------------------------------------------------------

-- From 1131: an applicant whose offer waits on them works with the org that sent it, for notices about it.
create or replace function private.party_org_ids(p_person_id uuid)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select e.org_id from app.engagements e
  where e.person_id = p_person_id and e.deleted_at is null
  union
  select c.org_id from app.counterparties c
  join app.account_memberships m on m.org_id = c.organization_id and m.person_id = p_person_id and m.deleted_at is null
    and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now())
  where c.deleted_at is null
  union
  select a.org_id from app.applications a
  join app.offers o on o.application_id = a.id and o.deleted_at is null and o.offer_state in ('Sent', 'Countered')
  where a.applicant_person_id = p_person_id and a.deleted_at is null;
$$;
comment on function private.party_org_ids(uuid) is 'Orgs a person works with as an external party: through an engagement of their own, an active membership in an external account the org holds as a counterparty, or an application of their own with an offer still open (A127), so the offer''s notices reach them.';
revoke all on function private.party_org_ids(uuid) from public, anon, authenticated;

-- An applicant keeps their own offer's notices once they answer it. Accepting or declining ends the offer's wait, so
-- the org no longer counts through private.party_org_ids, and without this the notice would leave their reach the
-- moment they act on it: a push Accept would act and then find nothing to show.
create or replace function private.offer_notice_mine(p_kind text, p_subject_table text, p_subject_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_kind = 'offer.sent' and p_subject_table = 'app.offers' and exists (
    select 1 from app.offers o
    join app.applications a on a.id = o.application_id and a.deleted_at is null
    where o.id = p_subject_id and o.deleted_at is null and a.applicant_person_id = private.current_person_id()
  );
$$;
comment on function private.offer_notice_mine(text, text, uuid) is 'True for an offer.sent notification about an offer on the signed-in person''s own application, whatever the offer''s state (A127), for the notifications read policy: an applicant keeps the notice after accepting or declining. It never answers for anyone else.';
revoke all on function private.offer_notice_mine(text, text, uuid) from public, anon;
grant execute on function private.offer_notice_mine(text, text, uuid) to authenticated, service_role;

-- From 1461: the read and update policy and private.is_my_notification also admit the applicant's own offer notices.
call private.install_policies('app.notifications',
  $$recipient_person_id = (select private.current_person_id())
    and (org_id in (select private.my_org_ids()) or org_id in (select private.my_party_org_ids())
      or (kind = 'opportunity.matched' and private.marketplace_notice_open_to_me(kind, subject_table, subject_id))
      or (kind = 'offer.sent' and private.offer_notice_mine(kind, subject_table, subject_id)))$$,
  null,
  $$recipient_person_id = (select private.current_person_id())
    and (org_id in (select private.my_org_ids()) or org_id in (select private.my_party_org_ids())
      or (kind = 'opportunity.matched' and private.marketplace_notice_open_to_me(kind, subject_table, subject_id))
      or (kind = 'offer.sent' and private.offer_notice_mine(kind, subject_table, subject_id)))$$);

create or replace function private.is_my_notification(p_notification_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from app.notifications n
    where n.id = p_notification_id and n.recipient_person_id = private.current_person_id()
      and (n.org_id in (select private.my_org_ids()) or n.org_id in (select private.my_party_org_ids())
        or (n.kind = 'opportunity.matched' and private.marketplace_notice_open_to_me(n.kind, n.subject_table, n.subject_id))
        or (n.kind = 'offer.sent' and private.offer_notice_mine(n.kind, n.subject_table, n.subject_id)))
  );
$$;
comment on function private.is_my_notification(uuid) is 'True when the signed-in person is the recipient of a notification and still belongs to its org, works with it as an external party (1131), for a marketplace match may still see the listing it is about (A89), or for an offer notice is the applicant the offer was made to (A127). Takes the id as an argument (ADR 0016 rule 14).';
revoke all on function private.is_my_notification(uuid) from public, anon;
grant execute on function private.is_my_notification(uuid) to authenticated;

create or replace function private.notify_offer_sent()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_application app.applications;
  v_opportunity app.opportunities;
begin
  select a.* into v_application from app.applications a
  join app.offers o on o.application_id = a.id
  where o.id = new.offer_id;
  if v_application.applicant_person_id is null then
    return null;
  end if;
  select * into v_opportunity from app.opportunities o where o.id = v_application.opportunity_id;
  perform private.notify(new.org_id, v_application.applicant_person_id, 'offer.sent', 'app.offers', new.offer_id,
    v_opportunity.project_id,
    jsonb_build_object('title', v_opportunity.title,
      'orgName', (select o.name from app.organizations o where o.id = new.org_id),
      'gatewayPath', '/work/applications'));
  return null;
end;
$$;
comment on function private.notify_offer_sent() is 'Tells the applicant when an org sends an offer or revises its terms (offer.sent, A127): the org''s version of the terms is in force and waits on them. Arguments: title (the listing), orgName and gatewayPath. An account''s application has no one person to tell.';
revoke all on function private.notify_offer_sent() from public, anon, authenticated;

create trigger t92_notify_offer_sent after insert on app.offer_versions
  for each row when (new.proposed_side = 'Organization')
  execute function private.notify_offer_sent();

-- 9. Shift notices say whether the shift waits on its worker (from 1394) -------------------------------------------------------

create or replace function private.notify_shift_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_worker uuid;
  v_kind text;
begin
  if new.deleted_at is not null or new.shift_state not in ('Published', 'Accepted') or new.ends_at <= now() then
    return null;
  end if;
  v_worker := private.shift_worker_person_id(new.membership_id, new.engagement_id);
  if v_worker is null or v_worker is not distinct from private.current_person_id() then
    return null;
  end if;
  if old.shift_state not in ('Published', 'Accepted')
     or v_worker is distinct from private.shift_worker_person_id(old.membership_id, old.engagement_id) then
    v_kind := 'shift.assigned';
  elsif new.starts_at is distinct from old.starts_at or new.ends_at is distinct from old.ends_at then
    v_kind := 'shift.changed';
  else
    return null;
  end if;
  perform private.notify(new.org_id, v_worker, v_kind, 'app.shifts', new.id, new.project_id,
    jsonb_build_object('title', private.shift_notification_title(new.id),
      'startsAt', to_char(new.starts_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
      'endsAt', to_char(new.ends_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
      'shiftState', new.shift_state::text));
  return null;
end;
$$;
comment on function private.notify_shift_change() is 'Tells a shift''s worker about it (1394): shift.assigned when a shift is published with them or a published or accepted shift becomes theirs (a reassignment, an approved swap or an approved claim), shift.changed when a published or accepted shift''s times move. Arguments: title, startsAt and endsAt as ISO instants, so a change to a shift starting within 12 hours bypasses quiet hours, and shiftState (A127), so a push offers Accept and Decline only on a shift still Published. Draft, canceled, deleted and finished shifts tell nobody, nor does a person''s own act, such as claiming an open shift first-come.';
revoke all on function private.notify_shift_change() from public, anon, authenticated;

-- 10. Snoozes are the recipient's own (from 1064) -------------------------------------------------------------------------------

call private.install_policies('app.inbox_snoozes',
  $$person_id = (select private.current_person_id()) and private.is_my_notification(notification_id)$$,
  $$person_id = (select private.current_person_id()) and private.is_my_notification(notification_id)$$);

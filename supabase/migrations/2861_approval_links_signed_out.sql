-- 2861_approval_links_signed_out.sql
-- P9 Signed-out decisions from an email link (RRR-223, gap G-31, ADR 0138; narrows ADR 0106's rejected alternative
-- "Let the link alone authorize, without a sign-in"). An outside approver on an engagement step that allows it decides
-- from the email's one-tap link without signing in. Section 7.5 invariant 8 (ADR 0033 decision 56) still holds: the
-- decision needs the link token and a 6-digit access code emailed on demand, minted at dispatch, stored only as a hash
-- salted by the token's stored hash, valid 10 minutes, with a lock after 5 wrong codes, and the token-only read returns
-- only what the page renders before the code.
--
--   * private.notification_action_tokens (A127, 2200) gains sign_in_required and failed_attempts. A token is signed-out
--     only for an engagement step with signed_out_links whose approver has no membership in the org: members always
--     sign in, so the org's security settings apply to them and their email digests never hold an approval.
--   * Tokens are bound to one action (A127 signs the action), so attempts, the lock, code requests and live codes are
--     counted per notification: a wrong code on the Approve or the Reject link counts toward one limit of 5, and a lock
--     locks both.
--   * private.notification_action_codes: the codes, by hash only. approval.link_code is the email that carries one
--     (Email only, transactional template approval_link_code); it is archived as soon as it is queued, so it never shows
--     in the Inbox, Gateway Home, the API notifications list or Compass, and the dispatcher still sends it.
--   * api_public.read_approval_link (token only: what the link does, the org, a masked email, its expiry),
--     api_public.request_approval_link_code, api_public.preview_approval_link (token and code: the request's title and
--     step) and api_public.use_approval_link (token and code: the decision). Refusals that count an attempt come back
--     as rows, as 0430's private.resolve_advance_token does, so the count sticks.
--   * From A127 (2200): private.notification_link_actions offers approve and reject for approval.reminder too and for
--     subject approvals; app.mint_notification_action_tokens marks signed-out tokens; app.act_on_notification decides
--     subject approvals and approval reminders, for an outside step approver as well as a member.
--   * From 1064: app.inbox_items leaves out approval.link_code, puts approval.reminder in Needs You, and carries a
--     subject approval's state, subject and step.

-- 1. Token columns ---------------------------------------------------------------------------------------------------------

alter table private.notification_action_tokens
  add column sign_in_required boolean not null default true,
  add column failed_attempts smallint not null default 0,
  add constraint notification_action_tokens_failed_attempts check (failed_attempts between 0 and 5);

comment on column private.notification_action_tokens.sign_in_required is 'False only for an outside approver of an engagement step that lets them decide from email (signed_out_links) and who has no membership in the org: their link works signed out with an emailed access code (P9, ADR 0138). True for everyone else, who signs in.';
comment on column private.notification_action_tokens.failed_attempts is 'Wrong access codes entered through any link of the same notification, 0 to 5; every link of the notification holds the same count, and at 5 every one of them is locked (P9).';

-- 2. Access codes ------------------------------------------------------------------------------------------------------------

create table private.notification_action_codes (
  id uuid primary key default private.uuid_v7(),
  token_id uuid not null references private.notification_action_tokens (id) on delete cascade,
  delivery_id uuid not null,
  code_hash bytea not null,
  expires_at timestamptz not null,
  used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  constraint notification_action_codes_hash_length check (octet_length(code_hash) = 32),
  constraint notification_action_codes_expiry check (expires_at > created_at)
);

create index notification_action_codes_token_idx on private.notification_action_codes (token_id);
create index notification_action_codes_delivery_idx on private.notification_action_codes (delivery_id);

alter table private.notification_action_codes enable row level security;
revoke all on private.notification_action_codes from public, anon, authenticated;
grant select, insert, update, delete on private.notification_action_codes to service_role;

comment on table private.notification_action_codes is 'Access codes of signed-out approval links (P9, Section 7.5 invariant 8): a 6-digit code minted when its email is sent, stored only as SHA-256 of the token''s stored hash, a colon and the code, valid 10 minutes, used once. Read and written only by the approval link functions.';
comment on column private.notification_action_codes.id is 'Code row id, UUID v7.';
comment on column private.notification_action_codes.token_id is 'The link whose code request sent it; the code works on every link of the same notification.';
comment on column private.notification_action_codes.delivery_id is 'Email delivery of approval.link_code that carried the code.';
comment on column private.notification_action_codes.code_hash is 'SHA-256 of the token row''s token_hash, a colon byte and the code: salted by the token''s stored hash, since the raw token is never stored. The code is never stored.';
comment on column private.notification_action_codes.expires_at is 'When the code stops working: 10 minutes after it was minted.';
comment on column private.notification_action_codes.used_at is 'When a decision used the code.';
comment on column private.notification_action_codes.revoked_at is 'When a newer code for the same notification replaced it.';
comment on column private.notification_action_codes.created_at is 'When the code was minted.';

create or replace function private.approval_link_code_hash(p_token_hash bytea, p_code text)
returns bytea
language sql
immutable
set search_path = ''
as $$
  select extensions.digest(p_token_hash || convert_to(':' || coalesce(p_code, ''), 'UTF8'), 'sha256');
$$;

comment on function private.approval_link_code_hash(bytea, text) is 'The stored form of an approval link''s access code: SHA-256 of the token''s stored hash, a colon and the code (P9). Not private.advance_code_hash: the raw link token is never stored, so the code is salted by its hash.';
revoke all on function private.approval_link_code_hash(bytea, text) from public, anon, authenticated;

create or replace function private.mask_email(p_email text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case when p_email is null or position('@' in p_email) < 2 then null
              else left(p_email, 1) || '***@' || split_part(p_email, '@', 2) end;
$$;

comment on function private.mask_email(text) is 'An email address with all but its first letter hidden, such as j***@venue.com, for the signed-out link page (P9).';
revoke all on function private.mask_email(text) from public, anon, authenticated;

-- 3. What an email may offer (from 2200) --------------------------------------------------------------------------------------

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
  if v_note.kind in ('approval.requested', 'approval.reminder') then
    if (v_note.subject_table = 'approval_instances' and exists (
          select 1 from app.approval_instances a where a.id = v_note.subject_id and a.deleted_at is null and a.approval_state = 'In Review'))
       or (v_note.subject_table = 'timesheets' and exists (
          select 1 from app.timesheets t where t.id = v_note.subject_id and t.deleted_at is null and t.timesheet_state = 'Submitted')) then
      return query values ('approve'::text, 'Atlas'::text), ('reject', 'Atlas');
    elsif v_note.subject_table = 'subject_approvals'
          and private.subject_approval_current_step(v_note.subject_id) is not distinct from (v_note.message_args ->> 'stepOrder')::smallint
          and private.is_subject_step_approver(v_note.subject_id, v_note.recipient_person_id) then
      -- P9: an outside approver answering through the step's engagement confirms in Gateway; a member in Atlas.
      return query select a.action, (case when exists (
          select 1 from private.subject_step_answers_by_engagement(v_note.subject_id, v_note.recipient_person_id))
          and not exists (select 1 from app.memberships m
                          where m.org_id = v_note.org_id and m.person_id = v_note.recipient_person_id and m.deleted_at is null
                            and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now()))
        then 'Gateway' else 'Atlas' end)::text
        from (values ('approve'::text), ('reject')) a (action);
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

comment on function private.notification_link_actions(uuid) is 'The actions an email of a notification carries links for, with the app that confirms them, exactly where its Inbox item or push offers them now: approve and reject for an approval request or reminder about an approval or a timesheet awaiting a decision (Atlas) or about a subject approval (P9) whose step the notification asked about is still current and the recipient may still decide (Gateway for an outside approver answering through the step''s engagement who is no member of the org, Atlas otherwise), accept for a published shift the recipient works (Atlas for a member, Gateway for an engaged worker) and for an offer awaiting the applicant (Gateway). None once the notification is Done.';
revoke all on function private.notification_link_actions(uuid) from public, anon, authenticated;

-- 4. Minting at dispatch (from 2200) -------------------------------------------------------------------------------------------

create or replace function private.notification_link_signed_out(p_note app.notifications)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_note.subject_table = 'subject_approvals' and p_note.kind in ('approval.requested', 'approval.reminder')
    and coalesce((select bool_or(x.signed_out_links)
                  from private.subject_step_answers_by_engagement(p_note.subject_id, p_note.recipient_person_id) x), false)
    and not exists (select 1 from app.memberships m
                    where m.org_id = p_note.org_id and m.person_id = p_note.recipient_person_id and m.deleted_at is null
                      and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now()));
$$;

comment on function private.notification_link_signed_out(app.notifications) is 'True when a notification''s links may work without a sign-in (P9, ADR 0138): an approval request or reminder about a subject approval whose current step is an engagement step with signed_out_links the recipient answers through, and the recipient has no active membership in the org. Members always sign in.';
revoke all on function private.notification_link_signed_out(app.notifications) from public, anon, authenticated;

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
  v_signed_out boolean;
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
  v_signed_out := private.notification_link_signed_out(v_note);
  for v_offer in select * from private.notification_link_actions(v_note.id) loop
    v_nonce := encode(extensions.gen_random_bytes(24), 'hex');
    v_token := 'xact_' || v_nonce || '.' || private.notification_action_signature(v_nonce, v_offer.action);
    insert into private.notification_action_tokens (org_id, notification_id, notification_created_at, delivery_id,
      recipient_person_id, kind, action, subject_table, subject_id, audience, token_hash, expires_at, sign_in_required)
    values (v_note.org_id, v_note.id, v_note.created_at, p_delivery_id, v_note.recipient_person_id, v_note.kind,
      v_offer.action, v_note.subject_table, v_note.subject_id, v_offer.audience,
      private.notification_action_token_hash(v_token), v_expires, not (coalesce(v_signed_out, false) and v_offer.audience = 'Gateway'));
    action := v_offer.action;
    token := v_token;
    audience := v_offer.audience;
    expires_at := v_expires;
    return next;
  end loop;
end;
$$;

comment on function app.mint_notification_action_tokens(uuid) is 'Email dispatch API (service role): mints the signed, single-use links an email delivery carries for the actions its notification offers now (private.notification_link_actions), each valid 7 days, and revokes the links of an earlier attempt of the same delivery. A link works signed out, with an emailed access code, only for an outside approver of an engagement step that allows it (private.notification_link_signed_out, P9). Returns each action, its token (shown here only), the app whose confirm page opens it, and the expiry. None for an email that offers no action (ADR 0106).';
revoke all on function app.mint_notification_action_tokens(uuid) from public, anon, authenticated;
grant execute on function app.mint_notification_action_tokens(uuid) to service_role;

-- 5. Acting where notifications arrive (from 2200) ------------------------------------------------------------------------------

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
  -- Approving and rejecting are a member's, or an outside approver's whom a subject approval's current step names (P9).
  -- Done and answering a shift, an offer or a message are the recipient's while the notification is still theirs to see
  -- (private.is_my_notification: a member, an external party or an applicant the org works with, as row level security
  -- on notifications reads it) (A127).
  if v_note.id is null or not coalesce(case when p_action in ('approve', 'reject')
                                            then v_note.org_id in (select private.my_org_ids())
                                                 or (v_note.subject_table = 'subject_approvals'
                                                     and private.is_subject_step_approver(v_note.subject_id, v_person))
                                            else private.is_my_notification(v_note.id) end, false) then
    raise exception using errcode = '42501', message = 'notification not found';
  end if;
  if p_action is null or p_action not in ('approve', 'reject', 'done', 'accept', 'decline', 'reply') then
    perform private.refuse('inbox_action_unknown', 'An Inbox item is approved, rejected, accepted, declined, answered or marked Done.');
  end if;
  if p_action in ('approve', 'reject') then
    if v_note.kind not in ('approval.requested', 'approval.reminder')
       or v_note.subject_table not in ('approval_instances', 'timesheets', 'subject_approvals') then
      perform private.refuse('inbox_action_not_offered', 'Only an approval request is approved or rejected from the Inbox.');
    end if;
    if v_note.subject_table = 'timesheets' then
      if p_action = 'reject' and v_comment is null then
        perform private.refuse('timesheet_rejection_reason', 'Say why when you reject a timesheet.');
      end if;
      perform app.decide_timesheet(v_note.subject_id,
        (case when p_action = 'approve' then 'Approved' else 'Rejected' end)::app.approval_decision,
        coalesce(v_comment, 'Approved from a notification.'));
    elsif v_note.subject_table = 'subject_approvals' then
      perform private.decide_subject_approval_as(v_note.subject_id, v_person, p_action = 'approve', v_comment, 'App');
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
comment on function app.act_on_notification(uuid, text, text) is 'Acts on a notification where it arrives (Section 11.10 rule 5), for its recipient only, while it is still theirs to see (private.is_my_notification): approve or reject what an approval request or reminder asks for (P9): an approval or a timesheet (a member''s; app.decide_approval and app.decide_timesheet decide every rule) or a pass, dock booking or equipment approval (a member''s, or the outside approver''s its current step names; private.decide_subject_approval_as); accept or decline a published shift (app.accept_shift, app.accept_engaged_shift, app.decline_shift) or an offer awaiting the applicant (app.accept_offer, app.decline_offer); reply to a message (app.send_chat_message, the reply in p_comment); or mark it Done. A refusal names its rule and the item stays; a handled or Done item leaves the Inbox. Push notification actions call it through the API (notifications.act) and one-tap email links through app.use_notification_action. Returns the notification id.';
revoke all on function app.act_on_notification(uuid, text, text) from public, anon;
grant execute on function app.act_on_notification(uuid, text, text) to authenticated, service_role;

-- 6. The signed-out link ------------------------------------------------------------------------------------------------------------

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

comment on function private.approval_link_state(private.notification_action_tokens) is 'State of a signed-out approval link (P9): invalid (unknown, forged, about something else, or replaced by a retried email), sign_in (the link needs a sign-in), locked (5 wrong codes across the notification''s links), used (acted on through a link of the notification, Done in the Inbox, or the step it asked about was decided or withdrawn), expired, or ready.';
revoke all on function private.approval_link_state(private.notification_action_tokens) from public, anon, authenticated;

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
  if v_state in ('invalid', 'sign_in') then
    return query select v_state, null::text, null::text, null::text, null::timestamptz;
    return;
  end if;
  return query select v_state, v_token.action,
    (select o.name from app.organizations o where o.id = v_token.org_id),
    private.mask_email(private.recipient_address(v_token.recipient_person_id, 'Email')),
    v_token.expires_at;
end;
$$;

comment on function api_public.read_approval_link(text) is 'The signed-out approval page before the access code (P9, Section 7.5 invariant 8): with the link token alone, what the link does (approve or reject), the org, the recipient''s masked email and the link''s expiry, and nothing else: the request''s title names the pass holder and appears only after the code (api_public.preview_approval_link). link_state is ready, used, expired, locked, sign_in (the page sends the person to sign in; nothing else is said) or invalid (nothing else is said). Never acts and counts nothing.';
revoke all on function api_public.read_approval_link(text) from public;
grant execute on function api_public.read_approval_link(text) to anon, authenticated, service_role;

create or replace function private.approval_link_token_for_update(p_token text)
returns private.notification_action_tokens
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_token private.notification_action_tokens := private.find_notification_action_token(p_token);
begin
  if v_token.id is null then
    return null;
  end if;
  -- Every link of the notification shares one count, so lock them all, in a fixed order.
  perform 1 from private.notification_action_tokens t where t.notification_id = v_token.notification_id order by t.id for update;
  select * into v_token from private.notification_action_tokens t where t.id = v_token.id;
  return v_token;
end;
$$;

comment on function private.approval_link_token_for_update(text) is 'The token row of a signed-out approval link, after locking every link of its notification (P9), or null for an unknown, malformed or forged token.';
revoke all on function private.approval_link_token_for_update(text) from public, anon, authenticated;

create or replace function private.check_approval_link_code(p_token private.notification_action_tokens, p_access_code text)
returns table (outcome text, attempts_left smallint)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_code uuid;
  v_attempts smallint;
begin
  select c.id into v_code from private.notification_action_codes c
  join private.notification_action_tokens t on t.id = c.token_id
  where t.notification_id = p_token.notification_id and c.used_at is null and c.revoked_at is null and c.expires_at > now()
    and coalesce(p_access_code, '') ~ '^[0-9]{6}$'
    and c.code_hash = private.approval_link_code_hash(t.token_hash, p_access_code)
  limit 1;
  if v_code is null then
    update private.notification_action_tokens t set failed_attempts = least(t.failed_attempts + 1, 5)
    where t.notification_id = p_token.notification_id;
    v_attempts := least(p_token.failed_attempts + 1, 5);
    return query select (case when v_attempts >= 5 then 'approval_link_locked' else 'approval_link_code_wrong' end)::text,
      (5 - v_attempts)::smallint;
    return;
  end if;
  return query select 'ok'::text, (5 - p_token.failed_attempts)::smallint;
end;
$$;

comment on function private.check_approval_link_code(private.notification_action_tokens, text) is 'Checks an access code against the live codes of every link of the token''s notification (P9). A wrong or expired code adds one to the shared failed_attempts of every link of the notification and returns approval_link_code_wrong with the attempts left, or approval_link_locked at the fifth; the increment is kept because nothing is raised. ok otherwise.';
revoke all on function private.check_approval_link_code(private.notification_action_tokens, text) from public, anon, authenticated;

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

comment on function api_public.request_approval_link_code(text) is 'The signed-out approval page''s Email me a code (P9): queues approval.link_code to the link''s recipient (subject the token row; message arguments title, orgName and actorName, never a code), archived at once so it shows nowhere but the email. The code is minted when the email is sent (app.mint_approval_link_code). Refuses a link that is not ready (notification_action_invalid, notification_action_used, notification_action_expired, approval_link_locked), more than one request a minute or five an hour across the notification''s links (approval_link_code_too_soon), and a recipient whose approval emails are off (approval_link_email_off). Sends nothing when it refuses.';
revoke all on function api_public.request_approval_link_code(text) from public;
grant execute on function api_public.request_approval_link_code(text) to anon, authenticated, service_role;

create or replace function app.mint_approval_link_code(p_delivery_id uuid)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_delivery app.notification_deliveries;
  v_note app.notifications;
  v_token private.notification_action_tokens;
  v_code text;
begin
  select * into v_delivery from app.notification_deliveries d where d.id = p_delivery_id and d.channel = 'Email';
  select * into v_note from app.notifications n
  where n.id = v_delivery.notification_id and n.created_at = v_delivery.notification_created_at;
  if v_note.id is null or v_note.kind <> 'approval.link_code' or v_note.subject_table <> 'notification_action_tokens' then
    return null;
  end if;
  select * into v_token from private.notification_action_tokens t where t.id = v_note.subject_id;
  if private.approval_link_state(v_token) <> 'ready' then
    return null;
  end if;
  -- One live code per notification: a newer code replaces every earlier unused one.
  update private.notification_action_codes c set revoked_at = now()
  where c.used_at is null and c.revoked_at is null
    and c.token_id in (select t.id from private.notification_action_tokens t where t.notification_id = v_token.notification_id);
  v_code := lpad(((('x' || encode(extensions.gen_random_bytes(4), 'hex'))::bit(32)::bigint) % 1000000)::text, 6, '0');
  insert into private.notification_action_codes (token_id, delivery_id, code_hash, expires_at)
  values (v_token.id, p_delivery_id, private.approval_link_code_hash(v_token.token_hash, v_code), now() + interval '10 minutes');
  return v_code;
end;
$$;

comment on function app.mint_approval_link_code(uuid) is 'Email dispatch API (service role): mints the 6-digit access code an approval.link_code email carries, while the dispatcher renders it (P9). Revokes every earlier unused code of the notification''s links, stores only the code''s hash salted by the token''s stored hash, valid 10 minutes, and returns the code once. NULL when the delivery is not such an email or its link is no longer ready.';
revoke all on function app.mint_approval_link_code(uuid) from public, anon, authenticated;
grant execute on function app.mint_approval_link_code(uuid) to service_role;

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

comment on function api_public.preview_approval_link(text, text) is 'The signed-out approval page after the access code (P9): with the link token and a live code, the request''s title and the step it waits on. The code is checked as api_public.use_approval_link checks it, so a wrong code counts toward the lock of 5. Refusals come back as one row with outcome notification_action_invalid, approval_link_locked, approval_link_code_wrong (with attempts_left), notification_action_used or notification_action_expired; ok otherwise. Never decides and never uses the code.';
revoke all on function api_public.preview_approval_link(text, text) from public;
grant execute on function api_public.preview_approval_link(text, text) to anon, authenticated, service_role;

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

comment on function api_public.use_approval_link(text, text, text) is 'Decides through a signed-out approval link (P9, ADR 0138): with the link token and a live access code, approves or rejects (the link''s own action; a rejection needs a reason) the step the notification asked about, as the link''s recipient, through private.decide_subject_approval_as with decided_via Email link, and uses the code and every link of the notification. Refusals that leave the approval undecided come back as one row, in this order, so a counted attempt sticks: notification_action_invalid (unknown, forged, replaced or needing a sign-in), approval_link_locked (5 wrong codes), approval_link_code_wrong (a wrong or expired code, counted, with attempts_left), notification_action_used (handled, or the step is no longer current), notification_action_expired, notification_action_reason. Refusals of the decision''s own rules propagate as errors. Returns decided and the notification id.';
revoke all on function api_public.use_approval_link(text, text, text) from public;
grant execute on function api_public.use_approval_link(text, text, text) to anon, authenticated, service_role;

-- 7. The Inbox (from 1064) ------------------------------------------------------------------------------------------------------------

create or replace view app.inbox_items with (security_invoker = true) as
select n.id, n.org_id, n.created_at, n.kind, n.actor_person_id, n.subject_table, n.subject_id, n.project_id,
  n.message_args, n.read_at,
  case when n.kind in ('approval.requested', 'approval.reminder', 'mention.created', 'assignment.created') then 'Needs You' else 'For Your Information' end as section,
  a.document_type, a.subject_reference, a.amount_minor, a.currency_code, a.approval_state, a.current_step, a.approval_policy_id,
  sa.approval_state as subject_approval_state, sa.subject as subject_approval_subject, sa.current_step as subject_approval_current_step
from app.notifications n
left join app.approval_instances a on n.subject_table = 'approval_instances' and a.id = n.subject_id and a.deleted_at is null
left join app.subject_approval_status sa on n.subject_table = 'subject_approvals' and sa.id = n.subject_id
where n.archived_at is null and n.deleted_at is null and n.kind <> 'approval.link_code'
  and not exists (select 1 from app.inbox_snoozes s where s.notification_id = n.id and s.deleted_at is null and s.snoozed_until > now());

call private.describe('app.inbox_items', 'The signed-in person''s Inbox (Section 11.10 rule 5): live notifications that are not Done or snoozed, sorted into Needs You (approval requests and reminders, mentions, assignments) and For Your Information, with the approval an approval request is about: a spend approval''s document, or a pass, dock booking or equipment approval''s computed state (P9). Access-code emails of signed-out approval links never show. Read with the person''s own row level security.', array[
  'section', 'Needs You or For Your Information.',
  'subject_approval_state', 'For a request or reminder about a pass, dock booking or equipment approval: its computed state now (P9).',
  'subject_approval_subject', 'For such a request: Pass, Delivery or Equipment.',
  'subject_approval_current_step', 'For such a request: the step it waits on while In Review.'
]);

revoke all on app.inbox_items from public, anon;
grant select on app.inbox_items to authenticated, service_role;
revoke select on app.inbox_items from xos_backup;

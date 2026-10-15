-- 0430_advancing_tokens_and_review.sql
-- A10 Advancing (ADR 0022 range 0430 to 0439), on A03's 0351 advancing tables:
--   * sending a packet is an act of its own: app.send_advance_packet needs advancing.packet.send, sends
--     once, and only a packet with sections and recipients; a sent packet's section list is fixed
--   * submissions are answers on the record: they reach only sent packets from recipients of the same
--     packet, never change after they arrive, and are reviewed once as Accepted or Returned (with a
--     reason) by someone other than the person who submitted them (sod_advance_submitter)
--   * recipient tokens for the Gateway advance form without an account (Section 4.4.6, ADR 0006 item 5):
--     a token and an access code, both stored only as SHA-256 hashes, bound to the recipient's email,
--     with expiry, revocation, first use, a lock after 5 wrong access codes, and a claim that links
--     every token sent to a verified email to the person who signs in with it (journey 50)
--   * domain events for packets, submissions, tokens, riders and reconciliations, which feed the
--     audit ledger, the activity feed and webhooks (A18, 0501)
-- Retention: 0501 gives every table that exists before it, including the one added here, its default
-- retention row, so no install_default_retention call is needed in this range.

-- Separation of duties and domain event catalog ------------------------------------------------------------

insert into private.separation_of_duties_rules (code, enforced_on, description) values
  ('sod_advance_submitter', 'Advance submissions', 'The person who submitted an advance answer cannot review it.')
on conflict (code) do nothing;

insert into private.domain_event_types (code, subject, description) values
  ('advance_packet.created', 'advance_packets', 'An advance packet was created.'),
  ('advance_packet.sent', 'advance_packets', 'An advance packet was sent to its recipients.'),
  ('advance_submission.received', 'advance_submissions', 'A recipient answered a section of an advance packet.'),
  ('advance_submission.reviewed', 'advance_submissions', 'An advance answer was reviewed: Accepted, or Returned with a reason.'),
  ('advance_token.issued', 'advance_recipient_tokens', 'A token link and access code were issued to an advance recipient.'),
  ('advance_token.claimed', 'advance_recipient_tokens', 'A person signed in with the email an advance token was sent to and claimed it.'),
  ('rider.created', 'riders', 'A rider was recorded for a project.'),
  ('rider_line.fulfilled', 'rider_lines', 'An ask of a rider was fulfilled.'),
  ('reconciliation.recorded', 'reconciliations', 'Requirements were reconciled against capabilities.')
on conflict (code) do nothing;

-- Review outcome --------------------------------------------------------------------------------------------

create type app.advance_review_outcome as enum ('Accepted', 'Returned');
comment on type app.advance_review_outcome is 'Outcome of reviewing an advance answer: Accepted, or Returned to the recipient with a reason to answer again.';

alter table app.advance_submissions
  add column review_outcome app.advance_review_outcome,
  add column return_reason text,
  add constraint advance_submissions_review_outcome_pair check ((reviewed_at is null) = (review_outcome is null)),
  add constraint advance_submissions_return_reason check (
    (review_outcome = 'Returned' and return_reason is not null and char_length(btrim(return_reason)) between 1 and 1000)
    or (review_outcome is distinct from 'Returned' and return_reason is null)),
  add constraint advance_submissions_body_length check (char_length(btrim(body)) between 1 and 20000);
comment on column app.advance_submissions.review_outcome is 'Accepted, or Returned to the recipient; NULL until reviewed. Set with reviewed_at and reviewed_by.';
comment on column app.advance_submissions.return_reason is 'Why the answer was returned, shown to the recipient; required when Returned and only then.';

-- Recipient tokens ---------------------------------------------------------------------------------------------

create table app.advance_recipient_tokens (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  advance_recipient_id uuid not null references app.advance_recipients (id),
  recipient_email text not null,
  token_hash bytea not null,
  access_code_hash bytea not null,
  expires_at timestamptz not null,
  used_at timestamptz,
  revoked_at timestamptz,
  failed_attempts smallint not null default 0,
  claimed_by uuid references app.people (id),
  claimed_at timestamptz,
  constraint advance_recipient_tokens_email_format check (recipient_email = lower(btrim(recipient_email)) and recipient_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' and char_length(recipient_email) <= 320),
  constraint advance_recipient_tokens_token_hash_length check (octet_length(token_hash) = 32),
  constraint advance_recipient_tokens_code_hash_length check (octet_length(access_code_hash) = 32),
  constraint advance_recipient_tokens_attempts check (failed_attempts between 0 and 5),
  constraint advance_recipient_tokens_claim_pair check ((claimed_by is null) = (claimed_at is null))
);
create unique index advance_recipient_tokens_token_hash_key on app.advance_recipient_tokens (token_hash);
create index advance_recipient_tokens_recipient_idx on app.advance_recipient_tokens (advance_recipient_id);
create index advance_recipient_tokens_email_idx on app.advance_recipient_tokens (recipient_email) where claimed_by is null;
create index advance_recipient_tokens_claimed_by_idx on app.advance_recipient_tokens (claimed_by);
call private.install_domain_table('app.advance_recipient_tokens', 'app.advance_recipients', 'advance_recipient_id');
call private.install_policies('app.advance_recipient_tokens',
  $$advance_recipient_id in (select r.id from app.advance_recipients r join app.advance_packets p on p.id = r.advance_packet_id
    where p.project_id in (select private.project_ids_with('advancing.packet.send')))$$);
call private.describe('app.advance_recipient_tokens', 'Token links that let an advance recipient answer in Gateway without an account (Section 4.4.6). Only SHA-256 hashes of the token and access code are stored; both are shown once. Written only by the advance token RPCs.', array[
  'advance_recipient_id', 'Recipient the token answers for.',
  'recipient_email', 'Email the link was sent to, lower case. A person who signs in with this email, confirmed, may claim the token.',
  'token_hash', 'SHA-256 of the token. Never readable by signed-in callers.',
  'access_code_hash', 'SHA-256 of the token, a colon and the 6-digit access code. Never readable by signed-in callers.',
  'expires_at', 'When the link stops taking answers.',
  'used_at', 'First answer submitted with the link.',
  'revoked_at', 'When the link was revoked; issuing a new link for the recipient revokes the old one.',
  'failed_attempts', 'Wrong access codes entered; the link locks at 5.',
  'claimed_by', 'Person who claimed the link by signing in with its email.',
  'claimed_at', 'When it was claimed.'
]);
-- The hashes stay out of reach even of the people who issue tokens.
revoke select on app.advance_recipient_tokens from authenticated;
grant select (id, org_id, advance_recipient_id, recipient_email, expires_at, used_at, revoked_at, failed_attempts,
  claimed_by, claimed_at, created_at, created_by, updated_at, updated_by, deleted_at)
  on app.advance_recipient_tokens to authenticated;

alter table app.advance_submissions
  add column advance_recipient_token_id uuid references app.advance_recipient_tokens (id);
create index advance_submissions_token_idx on app.advance_submissions (advance_recipient_token_id);
comment on column app.advance_submissions.advance_recipient_token_id is 'Token link the answer came through, when the recipient answered in Gateway without signing in; NULL for answers recorded in Atlas.';

-- Guards ------------------------------------------------------------------------------------------------------

create or replace function private.guard_advance_packet()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.sent_at is not null and not private.in_trusted_operation('send_advance_packet') then
      perform private.refuse('advance_packet_send', 'A packet is created as a draft and sent with app.send_advance_packet.');
    end if;
  elsif new.sent_at is distinct from old.sent_at then
    if old.sent_at is not null then
      perform private.refuse('advance_packet_sent', 'A sent packet stays sent.');
    elsif not private.in_trusted_operation('send_advance_packet') then
      perform private.refuse('advance_packet_send', 'Send a packet with app.send_advance_packet.');
    end if;
  end if;
  return new;
end;
$$;
comment on function private.guard_advance_packet() is 'A packet is sent only through app.send_advance_packet, and a sent packet stays sent.';
revoke all on function private.guard_advance_packet() from public, anon, authenticated;
create trigger t40_guard_advance_packet before insert or update on app.advance_packets
  for each row execute function private.guard_advance_packet();

create or replace function private.guard_advance_section()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (select 1 from app.advance_packets p where p.id = new.advance_packet_id and p.sent_at is not null)
     and (tg_op = 'INSERT' or new.position is distinct from old.position or new.deleted_at is distinct from old.deleted_at
          or new.advance_packet_id is distinct from old.advance_packet_id) then
    perform private.refuse('advance_packet_sections_fixed', 'The sections of a sent packet are fixed; wording may still be corrected.');
  end if;
  return new;
end;
$$;
comment on function private.guard_advance_section() is 'Once a packet is sent, sections are not added, removed or reordered; titles and prompts may be corrected.';
revoke all on function private.guard_advance_section() from public, anon, authenticated;
create trigger t40_guard_advance_section before insert or update on app.advance_sections
  for each row execute function private.guard_advance_section();

create or replace function private.guard_advance_submission()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_packet uuid;
  v_sent timestamptz;
  v_submitter uuid;
  v_reviewer uuid;
begin
  if tg_op = 'INSERT' then
    select p.id, p.sent_at into v_packet, v_sent
    from app.advance_sections s join app.advance_packets p on p.id = s.advance_packet_id
    where s.id = new.advance_section_id and s.deleted_at is null and p.deleted_at is null;
    if v_packet is null then
      perform private.refuse('advance_section_open', 'Answers go to a live section of a live packet.');
    end if;
    if v_sent is null then
      perform private.refuse('advance_packet_unsent', 'A packet takes answers once it is sent.');
    end if;
    if not exists (select 1 from app.advance_recipients r
                   where r.id = new.advance_recipient_id and r.advance_packet_id = v_packet and r.deleted_at is null) then
      perform private.refuse('advance_recipient_packet', 'Only a recipient of the same packet answers its sections.');
    end if;
    if new.advance_recipient_token_id is not null then
      if not private.in_trusted_operation('submit_advance') or not exists (
        select 1 from app.advance_recipient_tokens t
        where t.id = new.advance_recipient_token_id and t.advance_recipient_id = new.advance_recipient_id) then
        perform private.refuse('advance_token_submission', 'Token answers arrive only through api_public.submit_advance for the token''s own recipient.');
      end if;
    end if;
    if new.reviewed_at is not null or new.reviewed_by is not null or new.review_outcome is not null or new.return_reason is not null then
      perform private.refuse('advance_submission_unreviewed', 'An answer arrives unreviewed.');
    end if;
    new.submitted_at := now();
    return new;
  end if;

  if new.advance_section_id is distinct from old.advance_section_id or new.advance_recipient_id is distinct from old.advance_recipient_id
     or new.body is distinct from old.body or new.submitted_at is distinct from old.submitted_at
     or new.advance_recipient_token_id is distinct from old.advance_recipient_token_id then
    perform private.refuse('advance_submission_immutable', 'An answer never changes after it arrives; the recipient answers again instead.');
  end if;
  if new.reviewed_at is distinct from old.reviewed_at or new.reviewed_by is distinct from old.reviewed_by
     or new.review_outcome is distinct from old.review_outcome or new.return_reason is distinct from old.return_reason then
    if old.reviewed_at is not null then
      perform private.refuse('advance_submission_reviewed', 'An answer is reviewed once.');
    end if;
    v_reviewer := private.current_person_id();
    if v_reviewer is null then
      perform private.refuse('advance_review_person', 'A review is made by a signed-in person.');
    end if;
    select coalesce(t.claimed_by, old.created_by) into v_submitter
    from (select old.advance_recipient_token_id as id) x
    left join app.advance_recipient_tokens t on t.id = x.id;
    if v_submitter = v_reviewer then
      perform private.refuse('sod_advance_submitter', 'The person who submitted an advance answer cannot review it.');
    end if;
    new.reviewed_by := v_reviewer;
    new.reviewed_at := now();
  end if;
  return new;
end;
$$;
comment on function private.guard_advance_submission() is 'Answers reach only sent packets from recipients of the same packet, arrive unreviewed, never change, and are reviewed once by someone other than their submitter, stamped with the reviewer and the database time.';
revoke all on function private.guard_advance_submission() from public, anon, authenticated;
create trigger t40_guard_advance_submission before insert or update on app.advance_submissions
  for each row execute function private.guard_advance_submission();

-- Events ------------------------------------------------------------------------------------------------------

create trigger t90_emit_advance_packet_created after insert on app.advance_packets
  for each row execute function private.emit_row_event('advance_packet.created', 'project_id', 'title', 'due_at');
create trigger t90_emit_advance_packet_sent after update of sent_at on app.advance_packets
  for each row when (old.sent_at is null and new.sent_at is not null)
  execute function private.emit_row_event('advance_packet.sent', 'project_id', 'title', 'due_at', 'sent_at');
create trigger t90_emit_rider_created after insert on app.riders
  for each row execute function private.emit_row_event('rider.created', 'project_id', 'title', 'counterparty_id');
create trigger t90_emit_reconciliation_recorded after insert on app.reconciliations
  for each row execute function private.emit_row_event('reconciliation.recorded', 'project_id', 'reconciled_at');

create or replace function private.emit_advancing_child_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_project uuid;
  v_data jsonb;
begin
  case tg_table_name
    when 'advance_submissions' then
      select p.project_id into v_project from app.advance_sections s join app.advance_packets p on p.id = s.advance_packet_id
      where s.id = new.advance_section_id;
      v_data := jsonb_build_object('advance_section_id', new.advance_section_id, 'advance_recipient_id', new.advance_recipient_id,
        'submitted_at', new.submitted_at, 'review_outcome', new.review_outcome, 'reviewed_at', new.reviewed_at,
        'through_token', new.advance_recipient_token_id is not null);
    when 'advance_recipient_tokens' then
      select p.project_id into v_project from app.advance_recipients r join app.advance_packets p on p.id = r.advance_packet_id
      where r.id = new.advance_recipient_id;
      v_data := jsonb_build_object('advance_recipient_id', new.advance_recipient_id, 'expires_at', new.expires_at,
        'claimed_at', new.claimed_at);
    when 'rider_lines' then
      select r.project_id into v_project from app.riders r where r.id = new.rider_id;
      v_data := jsonb_build_object('rider_id', new.rider_id, 'description', new.description, 'fulfilled_at', new.fulfilled_at);
    else
      v_data := '{}'::jsonb;
  end case;
  perform private.emit_event(new.org_id, tg_argv[0], tg_table_name, new.id, v_project, v_data);
  return null;
end;
$$;
comment on function private.emit_advancing_child_event() is 'After trigger on advancing child tables: emits the named domain event with the project resolved through the parent rows. Argument: event type.';
revoke all on function private.emit_advancing_child_event() from public, anon, authenticated;

create trigger t90_emit_advance_submission_received after insert on app.advance_submissions
  for each row execute function private.emit_advancing_child_event('advance_submission.received');
create trigger t90_emit_advance_submission_reviewed after update of reviewed_at on app.advance_submissions
  for each row when (old.reviewed_at is null and new.reviewed_at is not null)
  execute function private.emit_advancing_child_event('advance_submission.reviewed');
create trigger t90_emit_advance_token_issued after insert on app.advance_recipient_tokens
  for each row execute function private.emit_advancing_child_event('advance_token.issued');
create trigger t90_emit_advance_token_claimed after update of claimed_at on app.advance_recipient_tokens
  for each row when (old.claimed_at is null and new.claimed_at is not null)
  execute function private.emit_advancing_child_event('advance_token.claimed');
create trigger t90_emit_rider_line_fulfilled after update of fulfilled_at on app.rider_lines
  for each row when (old.fulfilled_at is null and new.fulfilled_at is not null)
  execute function private.emit_advancing_child_event('rider_line.fulfilled');

-- Sending -----------------------------------------------------------------------------------------------------

create or replace function app.send_advance_packet(p_packet_id uuid)
returns timestamptz
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_packet app.advance_packets;
  v_now timestamptz := now();
begin
  select * into v_packet from app.advance_packets p where p.id = p_packet_id and p.deleted_at is null;
  if v_packet.id is null or not private.can_on_project(v_packet.project_id, 'advancing.packet.read') then
    raise exception using errcode = '42501', message = 'advance packet not found';
  end if;
  if not private.can_on_project(v_packet.project_id, 'advancing.packet.send') then
    perform private.refuse('advance_send_authority', 'Sending a packet needs advancing.packet.send on its project.');
  end if;
  if v_packet.sent_at is not null then
    perform private.refuse('advance_packet_sent', 'This packet was already sent.');
  end if;
  if not exists (select 1 from app.advance_sections s where s.advance_packet_id = p_packet_id and s.deleted_at is null) then
    perform private.refuse('advance_packet_no_sections', 'Add a section before sending.');
  end if;
  if not exists (select 1 from app.advance_recipients r where r.advance_packet_id = p_packet_id and r.deleted_at is null) then
    perform private.refuse('advance_packet_no_recipients', 'Add a recipient before sending.');
  end if;
  perform private.begin_trusted_operation('send_advance_packet');
  update app.advance_packets p set sent_at = v_now where p.id = p_packet_id;
  perform private.end_trusted_operation('send_advance_packet');
  return v_now;
end;
$$;
comment on function app.send_advance_packet(uuid) is 'Sends a draft advance packet (advancing.packet.send on its project). Refuses a packet already sent, or one without sections or recipients. Returns the send time.';
revoke all on function app.send_advance_packet(uuid) from public, anon;
grant execute on function app.send_advance_packet(uuid) to authenticated, service_role;

-- Tokens ------------------------------------------------------------------------------------------------------

create or replace function private.advance_token_hash(p_token text)
returns bytea
language sql
immutable
set search_path = ''
as $$
  select extensions.digest(coalesce(p_token, ''), 'sha256');
$$;
comment on function private.advance_token_hash(text) is 'SHA-256 of an advance token, the only form stored.';
revoke all on function private.advance_token_hash(text) from public, anon, authenticated;

create or replace function private.advance_code_hash(p_token text, p_code text)
returns bytea
language sql
immutable
set search_path = ''
as $$
  select extensions.digest(coalesce(p_token, '') || ':' || coalesce(btrim(p_code), ''), 'sha256');
$$;
comment on function private.advance_code_hash(text, text) is 'SHA-256 of the token, a colon and the access code: the token salts the 6-digit code.';
revoke all on function private.advance_code_hash(text, text) from public, anon, authenticated;

create or replace function app.issue_advance_token(p_recipient_id uuid, p_recipient_email text, p_valid_for interval default interval '30 days')
returns table (token_id uuid, token text, access_code text, expires_at timestamptz)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_project uuid;
  v_sent timestamptz;
  v_email text := lower(btrim(coalesce(p_recipient_email, '')));
  v_token text := 'xadv_' || encode(extensions.gen_random_bytes(32), 'hex');
  v_code text := lpad(((('x' || encode(extensions.gen_random_bytes(4), 'hex'))::bit(32)::bigint) % 1000000)::text, 6, '0');
  v_expires timestamptz := now() + p_valid_for;
  v_id uuid;
begin
  select p.project_id, p.sent_at into v_project, v_sent
  from app.advance_recipients r join app.advance_packets p on p.id = r.advance_packet_id
  where r.id = p_recipient_id and r.deleted_at is null and p.deleted_at is null;
  if v_project is null or not private.can_on_project(v_project, 'advancing.packet.read') then
    raise exception using errcode = '42501', message = 'advance recipient not found';
  end if;
  if not private.can_on_project(v_project, 'advancing.packet.send') then
    perform private.refuse('advance_send_authority', 'Issuing an advance link needs advancing.packet.send on the project.');
  end if;
  if v_sent is null then
    perform private.refuse('advance_packet_unsent', 'Send the packet before issuing links.');
  end if;
  if p_valid_for is null or p_valid_for < interval '1 hour' or p_valid_for > interval '90 days' then
    perform private.refuse('advance_token_validity', 'An advance link is valid for 1 hour to 90 days.');
  end if;
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' or char_length(v_email) > 320 then
    perform private.refuse('advance_token_email', 'An advance link goes to a valid email address.');
  end if;
  update app.advance_recipient_tokens t set revoked_at = now()
  where t.advance_recipient_id = p_recipient_id and t.revoked_at is null and t.deleted_at is null;
  insert into app.advance_recipient_tokens (advance_recipient_id, recipient_email, token_hash, access_code_hash, expires_at)
  values (p_recipient_id, v_email, private.advance_token_hash(v_token), private.advance_code_hash(v_token, v_code), v_expires)
  returning id into v_id;
  return query select v_id, v_token, v_code, v_expires;
end;
$$;
comment on function app.issue_advance_token(uuid, text, interval) is 'Issues a Gateway advance link for a recipient of a sent packet (advancing.packet.send): a token and a 6-digit access code, returned once and stored only as hashes, valid for 1 hour to 90 days. Revokes the recipient''s earlier links.';
revoke all on function app.issue_advance_token(uuid, text, interval) from public, anon;
grant execute on function app.issue_advance_token(uuid, text, interval) to authenticated, service_role;

create or replace function app.revoke_advance_token(p_token_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_project uuid;
begin
  select p.project_id into v_project
  from app.advance_recipient_tokens t
  join app.advance_recipients r on r.id = t.advance_recipient_id
  join app.advance_packets p on p.id = r.advance_packet_id
  where t.id = p_token_id and t.deleted_at is null;
  if v_project is null or not private.can_on_project(v_project, 'advancing.packet.send') then
    raise exception using errcode = '42501', message = 'advance link not found';
  end if;
  update app.advance_recipient_tokens t set revoked_at = coalesce(t.revoked_at, now()) where t.id = p_token_id;
end;
$$;
comment on function app.revoke_advance_token(uuid) is 'Revokes an advance link (advancing.packet.send). Revoking twice keeps the first time.';
revoke all on function app.revoke_advance_token(uuid) from public, anon;
grant execute on function app.revoke_advance_token(uuid) to authenticated, service_role;

-- Resolves a token and access code. Returns a reason instead of raising, so a wrong code is counted.
create or replace function private.resolve_advance_token(p_token text, p_access_code text)
returns table (token_id uuid, reason text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_token app.advance_recipient_tokens;
begin
  select * into v_token from app.advance_recipient_tokens t where t.token_hash = private.advance_token_hash(p_token);
  if v_token.id is null or v_token.deleted_at is not null or v_token.revoked_at is not null or not exists (
    select 1 from app.advance_recipients r join app.advance_packets p on p.id = r.advance_packet_id
    where r.id = v_token.advance_recipient_id and r.deleted_at is null and p.deleted_at is null) then
    return query select null::uuid, 'advance_token_invalid'::text;
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
comment on function private.resolve_advance_token(text, text) is 'Resolves an advance token and access code: invalid, locked after 5 wrong codes, wrong code (counted), expired, or the token id.';
revoke all on function private.resolve_advance_token(text, text) from public, anon, authenticated;

create or replace function api_public.preview_advance(p_token text, p_access_code text)
returns table (
  refusal text,
  reason text,
  org_name text,
  packet_title text,
  due_at timestamptz,
  recipient_email text,
  expires_at timestamptz,
  section_id uuid,
  section_position integer,
  section_title text,
  section_prompt text,
  answer_body text,
  answered_at timestamptz,
  review_outcome app.advance_review_outcome,
  return_reason text
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_token_id uuid;
  v_reason text;
begin
  select r.token_id, r.reason into v_token_id, v_reason from private.resolve_advance_token(p_token, p_access_code) r;
  if v_reason is not null then
    return query select 'REFUSE'::text, v_reason, null::text, null::text, null::timestamptz, null::text, null::timestamptz,
      null::uuid, null::integer, null::text, null::text, null::text, null::timestamptz, null::app.advance_review_outcome, null::text;
    return;
  end if;
  return query
    select null::text, null::text, o.name, p.title, p.due_at, t.recipient_email, t.expires_at,
      s.id, s.position, s.title, s.prompt, a.body, a.submitted_at, a.review_outcome, a.return_reason
    from app.advance_recipient_tokens t
    join app.advance_recipients rc on rc.id = t.advance_recipient_id
    join app.advance_packets p on p.id = rc.advance_packet_id
    join app.organizations o on o.id = p.org_id
    join app.advance_sections s on s.advance_packet_id = p.id and s.deleted_at is null
    left join lateral (
      select x.body, x.submitted_at, x.review_outcome, x.return_reason from app.advance_submissions x
      where x.advance_section_id = s.id and x.advance_recipient_id = rc.id and x.deleted_at is null
      order by x.submitted_at desc, x.id desc limit 1
    ) a on true
    where t.id = v_token_id
    order by s.position;
end;
$$;
comment on function api_public.preview_advance(text, text) is 'Gateway advance form without an account (Section 4.4.6): with a valid token and access code, returns one row per section of the packet with the recipient''s latest answer and its review. Otherwise one row with refusal REFUSE and the reason: advance_token_invalid, advance_token_locked, advance_access_code or advance_token_expired.';
revoke all on function api_public.preview_advance(text, text) from public;
grant execute on function api_public.preview_advance(text, text) to anon, authenticated, service_role;

create or replace function api_public.submit_advance(p_token text, p_access_code text, p_section_id uuid, p_body text)
returns table (submission_id uuid, submitted_at timestamptz, refusal text, reason text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_token_id uuid;
  v_reason text;
  v_recipient uuid;
  v_id uuid;
  v_at timestamptz;
  v_body text := btrim(coalesce(p_body, ''));
begin
  select r.token_id, r.reason into v_token_id, v_reason from private.resolve_advance_token(p_token, p_access_code) r;
  if v_reason is not null then
    return query select null::uuid, null::timestamptz, 'REFUSE'::text, v_reason;
    return;
  end if;
  select t.advance_recipient_id into v_recipient from app.advance_recipient_tokens t where t.id = v_token_id;
  if not exists (select 1 from app.advance_sections s join app.advance_recipients r on r.advance_packet_id = s.advance_packet_id
                 where s.id = p_section_id and s.deleted_at is null and r.id = v_recipient) then
    return query select null::uuid, null::timestamptz, 'REFUSE'::text, 'advance_section_open'::text;
    return;
  end if;
  if char_length(v_body) not between 1 and 20000 then
    return query select null::uuid, null::timestamptz, 'REFUSE'::text, 'advance_answer_length'::text;
    return;
  end if;
  perform private.begin_trusted_operation('submit_advance');
  insert into app.advance_submissions (advance_section_id, advance_recipient_id, advance_recipient_token_id, body)
  values (p_section_id, v_recipient, v_token_id, v_body)
  returning id, advance_submissions.submitted_at into v_id, v_at;
  perform private.end_trusted_operation('submit_advance');
  update app.advance_recipient_tokens t set used_at = coalesce(t.used_at, v_at) where t.id = v_token_id;
  return query select v_id, v_at, null::text, null::text;
end;
$$;
comment on function api_public.submit_advance(text, text, uuid, text) is 'Gateway advance form without an account: with a valid token and access code, records the recipient''s answer to one section of the packet (1 to 20,000 characters) and marks the link used. Refusals come back as REFUSE with a reason: the token reasons of preview_advance, advance_section_open or advance_answer_length.';
revoke all on function api_public.submit_advance(text, text, uuid, text) from public;
grant execute on function api_public.submit_advance(text, text, uuid, text) to anon, authenticated, service_role;

create or replace function app.claim_advance_token(p_token text)
returns table (claimed_tokens integer, refusal text, reason text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.current_person_id();
  v_token app.advance_recipient_tokens;
  v_email text;
  v_confirmed timestamptz;
  v_count integer;
begin
  if v_person is null then
    raise exception using errcode = '42501', message = 'a signed-in person is required';
  end if;
  select * into v_token from app.advance_recipient_tokens t where t.token_hash = private.advance_token_hash(p_token);
  if v_token.id is null or v_token.deleted_at is not null or v_token.revoked_at is not null or v_token.failed_attempts >= 5 then
    return query select 0, 'REFUSE'::text, 'advance_token_invalid'::text;
    return;
  end if;
  select lower(u.email), u.email_confirmed_at into v_email, v_confirmed from auth.users u where u.id = (select auth.uid());
  if v_confirmed is null or v_email is distinct from v_token.recipient_email then
    update app.advance_recipient_tokens t set failed_attempts = least(t.failed_attempts + 1, 5) where t.id = v_token.id;
    return query select 0, 'REFUSE'::text, 'advance_claim_email'::text;
    return;
  end if;
  if v_token.claimed_by is not null and v_token.claimed_by <> v_person then
    return query select 0, 'REFUSE'::text, 'advance_token_claimed'::text;
    return;
  end if;
  update app.advance_recipient_tokens t set claimed_by = v_person, claimed_at = now()
  where t.recipient_email = v_email and t.claimed_by is null and t.deleted_at is null;
  get diagnostics v_count = row_count;
  return query select v_count, null::text, null::text;
end;
$$;
comment on function app.claim_advance_token(text) is 'Journey 50: a person signed in with a confirmed email claims an advance link sent to that email, and with it every unclaimed link sent to the same email, so their earlier token answers appear under their account. Refuses invalid, revoked or locked links (advance_token_invalid), another email (advance_claim_email, counted toward the lock) and links another person claimed (advance_token_claimed). Expired links may still be claimed.';
revoke all on function app.claim_advance_token(text) from public, anon;
grant execute on function app.claim_advance_token(text) to authenticated, service_role;

create or replace function app.my_advance_submissions()
returns table (
  submission_id uuid,
  org_name text,
  packet_title text,
  section_title text,
  body text,
  submitted_at timestamptz,
  review_outcome app.advance_review_outcome,
  return_reason text
)
language sql
stable
security definer
set search_path = ''
as $$
  select x.id, o.name, p.title, s.title, x.body, x.submitted_at, x.review_outcome, x.return_reason
  from app.advance_recipient_tokens t
  join app.advance_submissions x on x.advance_recipient_token_id = t.id and x.deleted_at is null
  join app.advance_sections s on s.id = x.advance_section_id
  join app.advance_packets p on p.id = s.advance_packet_id and p.deleted_at is null
  join app.organizations o on o.id = p.org_id
  where t.claimed_by = private.current_person_id() and t.deleted_at is null
  order by x.submitted_at desc;
$$;
comment on function app.my_advance_submissions() is 'The signed-in person''s advance answers given through links they claimed, newest first, with each review.';
revoke all on function app.my_advance_submissions() from public, anon;
grant execute on function app.my_advance_submissions() to authenticated, service_role;

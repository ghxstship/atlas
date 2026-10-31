-- 2975_guest_emails.sql
-- B8 Bulk guest emails with passes (RRR-232, gap G-71, ADR 0147 decision 7). Staff email the guests they select: an
-- invitation, their pass (the guest-pass PDF attached) or a message. The org sends them through its own outbox:
--
--   * app.guest_email_sends: one send by staff, append-only. app.guest_emails: one row per requested guest of the
--     project, Queued, Suppressed, or Skipped with the reason (no email, not live, no pass), so the summary counts
--     everything the dialog promised; the address is kept as it was at queue time.
--   * Suppression reuses the org's list (app.suppression_list, 0520): an address is suppressed by the rule
--     claim_notification_deliveries applies to a non-transactional email without a category, that is any live row
--     not lifted of reason Hard Bounce, Complaint, STOP or Manual, or of reason Unsubscribe with no category. A guest
--     unsubscribe adds that Unsubscribe row once, as app.unsubscribe_by_token (0570) does. Every guest email is
--     non-transactional, with the unsubscribe link and the postal address of decision 41.
--   * The guest-email Edge Function claims Queued rows (app.claim_guest_emails, which checks each row again: the guest
--     is still live, a Pass is still for an approved guest with a code, and the address is not suppressed), sends,
--     and records the outcome (app.finish_guest_email, idempotent on a Sent row). Each claim stores the SHA-256 of a
--     fresh unsubscribe token for the row.
--   * api_public.unsubscribe_guest_email follows 1382: it refuses a read-only (GET) transaction first, counts only
--     failed token lookups by client address (20 in 10 minutes), never a success, and answers the same shape either
--     way. The email-unsubscribe Edge Function calls it with the service role, so a per-call limit would count the
--     function's own address and block real guests.
--   * An org queues at most 2,000 guest emails a day: app.queue_guest_emails counts the org's rows of the last 24
--     hours (guest_email_rate). Nothing is written to rate_limit_events.
--   * pg_cron asks the function to run every minute while Queued rows exist, through Vault as 1542 and 2030 do.

create type app.guest_email_kind as enum ('Invitation', 'Pass', 'Message');
comment on type app.guest_email_kind is 'What a guest email carries: an invitation, the guest''s pass (with the guest-pass PDF) or a message with a subject and body.';

create type app.guest_email_state as enum ('Queued', 'Sending', 'Sent', 'Failed', 'Suppressed', 'Skipped');
comment on type app.guest_email_state is 'Where one guest''s email stands: Queued, Sending, Sent, Failed after 5 attempts, Suppressed (the address is on the org''s suppression list) or Skipped (nothing to send; see the skip reason).';

create type app.guest_email_skip_reason as enum ('No Email', 'Not Live', 'No Pass');
comment on type app.guest_email_skip_reason is 'Why a guest got no email: no address on the entry, the entry is deleted or declined, or a Pass email for a guest who is not approved with a pass code.';

-- Sends ----------------------------------------------------------------------------------------------------------------------

create table app.guest_email_sends (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  project_id uuid not null references app.projects (id),
  email_kind app.guest_email_kind not null,
  subject text,
  body text,
  locale text not null default 'en-US',
  constraint guest_email_sends_subject check ((email_kind = 'Message') = (subject is not null)
    and (subject is null or char_length(btrim(subject)) between 1 and 150)),
  constraint guest_email_sends_body check ((email_kind <> 'Message' or body is not null)
    and (body is null or char_length(btrim(body)) between 1 and 5000)),
  constraint guest_email_sends_locale check (locale in ('en-US', 'es-US'))
);
call private.install_domain_table('app.guest_email_sends', 'app.projects', 'project_id', '{}', true);
create index guest_email_sends_project_idx on app.guest_email_sends (project_id, created_at desc);
call private.describe('app.guest_email_sends', 'Bulk emails staff sent to a project''s guests (gap G-71, ADR 0147 decision 7): what was sent and in which language. Append-only; written only by app.queue_guest_emails.', array[
  'project_id', 'Project.',
  'email_kind', 'Invitation, Pass or Message.',
  'subject', 'Subject of a Message, 1 to 150 characters; NULL for the other kinds.',
  'body', 'Text of a Message (required), or a note added to an invitation or pass, up to 5,000 characters.',
  'locale', 'Language of the email: en-US or es-US.'
]);
call private.install_policies('app.guest_email_sends', $$project_id in (select private.project_ids_with('advancing.packet.read'))$$);
call private.install_audit_trail('app.guest_email_sends');
call private.install_default_retention('app.guest_email_sends', interval '1 year');

create table app.guest_emails (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  guest_email_send_id uuid not null references app.guest_email_sends (id) on delete cascade,
  guest_list_entry_id uuid not null references app.guest_list_entries (id),
  to_email text,
  send_state app.guest_email_state not null default 'Queued',
  skip_reason app.guest_email_skip_reason,
  attempts smallint not null default 0,
  claimed_at timestamptz,
  sent_at timestamptz,
  provider_message_id text,
  error text,
  constraint guest_emails_to check ((send_state = 'Skipped') = (to_email is null)
    and (to_email is null or (to_email = lower(to_email) and to_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' and char_length(to_email) <= 320))),
  constraint guest_emails_skip check ((send_state = 'Skipped') = (skip_reason is not null)),
  constraint guest_emails_attempts check (attempts between 0 and 5),
  constraint guest_emails_error_length check (error is null or char_length(error) <= 1000),
  constraint guest_emails_sent check ((send_state = 'Sent') = (sent_at is not null))
);
call private.install_domain_table('app.guest_emails', 'app.guest_email_sends', 'guest_email_send_id',
  array['app.guest_list_entries', 'guest_list_entry_id']);
create unique index guest_emails_send_entry_key on app.guest_emails (guest_email_send_id, guest_list_entry_id);
create index guest_emails_entry_idx on app.guest_emails (guest_list_entry_id);
create index guest_emails_due_idx on app.guest_emails (send_state, created_at) where send_state in ('Queued', 'Sending');
create index guest_emails_org_created_idx on app.guest_emails (org_id, created_at);
call private.describe('app.guest_emails', 'One guest''s email of a send (gap G-71): the address at queue time and what happened to it. The project comes through the send. Written only by the queue and the guest-email worker.', array[
  'guest_email_send_id', 'Send it belongs to.',
  'guest_list_entry_id', 'Guest.',
  'to_email', 'Address it went to, lowercased, as the entry had it when queued; NULL only for a Skipped row. Confidential.',
  'send_state', 'Queued, Sending, Sent, Failed, Suppressed or Skipped.',
  'skip_reason', 'Why a Skipped row sent nothing: No Email, Not Live or No Pass.',
  'attempts', 'Send attempts so far, at most 5.',
  'claimed_at', 'When the worker last claimed it.',
  'sent_at', 'When it was sent.',
  'provider_message_id', 'Message id the email provider returned.',
  'error', 'Why the last attempt failed.'
]);
call private.install_policies('app.guest_emails',
  $$guest_email_send_id in (select s.id from app.guest_email_sends s where s.project_id in (select private.project_ids_with('advancing.packet.read')))$$);
insert into private.retention_policies (table_name, basis, time_column, retention, purge_method, rationale) values
  ('app.guest_emails', 'Age', 'created_at', interval '1 year', 'Delete', 'Kept as long as their send.')
on conflict (table_name) do nothing;
insert into private.column_classifications (table_name, column_name, classification, read_capability) values
  ('app.guest_emails', 'to_email', 'Confidential', null);

create table private.guest_email_unsubscribe_tokens (
  token_hash bytea primary key,
  guest_email_id uuid not null references app.guest_emails (id) on delete cascade,
  created_at timestamptz not null default now(),
  constraint guest_email_unsubscribe_tokens_length check (octet_length(token_hash) = 32)
);
create index guest_email_unsubscribe_tokens_email_idx on private.guest_email_unsubscribe_tokens (guest_email_id);
comment on table private.guest_email_unsubscribe_tokens is 'One unsubscribe token per guest email sent, stored as its SHA-256; it suppresses the address for the sending org.';
comment on column private.guest_email_unsubscribe_tokens.token_hash is 'SHA-256 of the unsubscribe token.';
comment on column private.guest_email_unsubscribe_tokens.guest_email_id is 'Guest email the token was sent in.';
comment on column private.guest_email_unsubscribe_tokens.created_at is 'When the token was issued.';
alter table private.guest_email_unsubscribe_tokens enable row level security;
revoke all on private.guest_email_unsubscribe_tokens from public, anon, authenticated;

-- Suppression -----------------------------------------------------------------------------------------------------------------

create function private.guest_email_suppressed(p_org_id uuid, p_email text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from app.suppression_list s
    where s.org_id = p_org_id and s.channel = 'Email' and s.address = p_email and s.lifted_at is null and s.deleted_at is null
      and (s.reason in ('Hard Bounce', 'Complaint', 'STOP', 'Manual') or (s.reason = 'Unsubscribe' and s.category_code is null)));
$$;
comment on function private.guest_email_suppressed(uuid, text) is 'True when the org sends no guest email to the address: a live, unlifted suppression of reason Hard Bounce, Complaint, STOP or Manual, or an Unsubscribe from all its email (no category), the rule claim_notification_deliveries applies to non-transactional email (0520, 1671).';
revoke all on function private.guest_email_suppressed(uuid, text) from public, anon, authenticated;

-- Queueing ----------------------------------------------------------------------------------------------------------------------

create function app.queue_guest_emails(
  p_project_id uuid,
  p_entry_ids uuid[],
  p_kind app.guest_email_kind,
  p_subject text default null,
  p_body text default null,
  p_locale text default 'en-US'
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_org uuid := (select p.org_id from app.projects p where p.id = p_project_id and p.deleted_at is null);
  v_ids uuid[] := (select coalesce(array_agg(distinct x), '{}') from unnest(coalesce(p_entry_ids, '{}')) x where x is not null);
  v_subject text := nullif(btrim(coalesce(p_subject, '')), '');
  v_body text := nullif(btrim(coalesce(p_body, '')), '');
  v_send uuid;
  v_sending integer;
begin
  perform private.require_person();
  if v_org is null or not private.can_on_project(p_project_id, 'advancing.rider.write') then
    raise exception using errcode = '42501', message = 'emailing guests needs advancing.rider.write on the project';
  end if;
  if cardinality(v_ids) not between 1 and 500 then
    perform private.refuse('guest_email_batch', 'Email 1 to 500 guests at a time.');
  end if;
  if (p_kind = 'Message' and (v_subject is null or v_body is null))
     or (p_kind <> 'Message' and v_subject is not null)
     or char_length(coalesce(v_subject, '')) > 150 or char_length(coalesce(v_body, '')) > 5000 then
    perform private.refuse('guest_email_message', 'A message needs a subject of up to 150 characters and a text of up to 5,000.');
  end if;
  perform pg_advisory_xact_lock(hashtextextended('guest_email_queue:' || v_org, 0));
  select count(*) into v_sending from app.guest_list_entries g
  where g.id = any (v_ids) and g.project_id = p_project_id and g.deleted_at is null and g.entry_state <> 'Declined'
    and g.guest_email is not null and (p_kind <> 'Pass' or (g.entry_state in ('Approved', 'Checked In') and g.pass_code is not null));
  if (select count(*) from app.guest_emails e where e.org_id = v_org and e.created_at >= now() - interval '24 hours'
        and e.send_state <> 'Skipped') + v_sending > 2000 then
    perform private.refuse('guest_email_rate', 'An organization emails up to 2,000 guests a day. Send the rest tomorrow.');
  end if;

  insert into app.guest_email_sends (project_id, email_kind, subject, body, locale)
  values (p_project_id, p_kind, v_subject, v_body, coalesce(p_locale, 'en-US'))
  returning id into v_send;

  insert into app.guest_emails (guest_email_send_id, guest_list_entry_id, to_email, send_state, skip_reason)
  select v_send, g.id,
    case when q.skip is null then g.guest_email end,
    case when q.skip is not null then 'Skipped' when private.guest_email_suppressed(v_org, g.guest_email) then 'Suppressed' else 'Queued' end::app.guest_email_state,
    q.skip
  from app.guest_list_entries g
  cross join lateral (
    select case
      when g.deleted_at is not null or g.entry_state = 'Declined' then 'Not Live'
      when g.guest_email is null then 'No Email'
      when p_kind = 'Pass' and (g.entry_state not in ('Approved', 'Checked In') or g.pass_code is null) then 'No Pass'
    end::app.guest_email_skip_reason as skip
  ) q
  where g.id = any (v_ids) and g.project_id = p_project_id;
  return v_send;
end;
$$;
comment on function app.queue_guest_emails(uuid, uuid[], app.guest_email_kind, text, text, text) is 'Queues an email to the selected guests of a project (advancing.rider.write; gap G-71): an Invitation, their Pass or a Message (subject and text required, guest_email_message). Refuses fewer than 1 or more than 500 guests (guest_email_batch) and more than 2,000 emails for the org in 24 hours (guest_email_rate). Every requested guest of the project gets a row: Queued, Suppressed for an address on the org''s suppression list, or Skipped with the reason. Returns the send id.';
revoke all on function app.queue_guest_emails(uuid, uuid[], app.guest_email_kind, text, text, text) from public, anon;
grant execute on function app.queue_guest_emails(uuid, uuid[], app.guest_email_kind, text, text, text) to authenticated, service_role;

create function app.guest_email_send_summary(p_send_id uuid)
returns table (
  queued integer,
  sending integer,
  sent integer,
  failed integer,
  suppressed integer,
  skipped integer,
  skipped_no_email integer,
  skipped_not_live integer,
  skipped_no_pass integer
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_project uuid := (select s.project_id from app.guest_email_sends s where s.id = p_send_id);
begin
  perform private.require_person();
  if v_project is null or not private.can_on_project(v_project, 'advancing.packet.read') then
    raise exception using errcode = '42501', message = 'the send does not exist or is not visible';
  end if;
  return query
    select count(*) filter (where e.send_state = 'Queued')::integer,
      count(*) filter (where e.send_state = 'Sending')::integer,
      count(*) filter (where e.send_state = 'Sent')::integer,
      count(*) filter (where e.send_state = 'Failed')::integer,
      count(*) filter (where e.send_state = 'Suppressed')::integer,
      count(*) filter (where e.send_state = 'Skipped')::integer,
      count(*) filter (where e.skip_reason = 'No Email')::integer,
      count(*) filter (where e.skip_reason = 'Not Live')::integer,
      count(*) filter (where e.skip_reason = 'No Pass')::integer
    from app.guest_emails e where e.guest_email_send_id = p_send_id;
end;
$$;
comment on function app.guest_email_send_summary(uuid) is 'The rows of a guest email send counted by state and skip reason (advancing.packet.read on its project).';
revoke all on function app.guest_email_send_summary(uuid) from public, anon;
grant execute on function app.guest_email_send_summary(uuid) to authenticated, service_role;

-- The worker (service role) ----------------------------------------------------------------------------------------------------

create function app.claim_guest_emails(p_limit integer default 50)
returns table (
  guest_email_id uuid,
  org_id uuid,
  org_name text,
  project_id uuid,
  project_name text,
  guest_list_entry_id uuid,
  email_kind app.guest_email_kind,
  subject text,
  body text,
  locale text,
  to_email text,
  guest_name text,
  plus_ones smallint,
  pass_code text,
  unsubscribe_token text
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_row record;
  v_token text;
begin
  for v_row in
    select e.id, e.org_id, e.to_email, e.attempts, s.email_kind, g.id as entry_id, g.deleted_at as entry_deleted,
      g.entry_state, g.pass_code as entry_pass
    from app.guest_emails e
    join app.guest_email_sends s on s.id = e.guest_email_send_id
    join app.guest_list_entries g on g.id = e.guest_list_entry_id
    where e.send_state = 'Queued' or (e.send_state = 'Sending' and e.claimed_at < now() - interval '10 minutes')
    order by e.created_at
    limit least(greatest(coalesce(p_limit, 50), 1), 100)
    for update of e skip locked
  loop
    if v_row.entry_deleted is not null or v_row.entry_state = 'Declined' then
      update app.guest_emails set send_state = 'Skipped', skip_reason = 'Not Live', to_email = null where id = v_row.id;
    elsif v_row.email_kind = 'Pass' and (v_row.entry_state not in ('Approved', 'Checked In') or v_row.entry_pass is null) then
      update app.guest_emails set send_state = 'Skipped', skip_reason = 'No Pass', to_email = null where id = v_row.id;
    elsif private.guest_email_suppressed(v_row.org_id, v_row.to_email) then
      update app.guest_emails set send_state = 'Suppressed' where id = v_row.id;
    elsif v_row.attempts >= 5 then
      update app.guest_emails set send_state = 'Failed' where id = v_row.id;
    else
      v_token := 'xgue_' || encode(extensions.gen_random_bytes(32), 'hex');
      update app.guest_emails set send_state = 'Sending', attempts = attempts + 1, claimed_at = now() where id = v_row.id;
      insert into private.guest_email_unsubscribe_tokens (token_hash, guest_email_id)
      values (extensions.digest(v_token, 'sha256'), v_row.id);
      return query
        select e.id, e.org_id, o.name, s.project_id, p.name, g.id, s.email_kind, s.subject, s.body, s.locale, e.to_email,
          g.guest_name, g.plus_ones, g.pass_code, v_token
        from app.guest_emails e
        join app.guest_email_sends s on s.id = e.guest_email_send_id
        join app.guest_list_entries g on g.id = e.guest_list_entry_id
        join app.organizations o on o.id = e.org_id
        join app.projects p on p.id = s.project_id
        where e.id = v_row.id;
    end if;
  end loop;
end;
$$;
comment on function app.claim_guest_emails(integer) is 'The guest-email worker''s claim (service role): up to p_limit (at most 100) Queued rows, and Sending rows left more than 10 minutes, oldest first, skipping rows another worker holds. Each is checked again: a guest no longer live or no longer approved with a pass code for a Pass is Skipped, a suppressed address Suppressed, a row out of attempts Failed; the rest move to Sending with a fresh unsubscribe token, whose SHA-256 is stored, and are returned with what the email needs.';
revoke all on function app.claim_guest_emails(integer) from public, anon, authenticated;
grant execute on function app.claim_guest_emails(integer) to service_role;

create function app.finish_guest_email(p_id uuid, p_provider_message_id text default null, p_error text default null)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_row app.guest_emails;
begin
  select * into v_row from app.guest_emails e where e.id = p_id for update;
  if v_row.id is null or v_row.send_state = 'Sent' then
    return;
  end if;
  if p_error is null then
    update app.guest_emails set send_state = 'Sent', sent_at = now(), provider_message_id = left(p_provider_message_id, 200),
      error = null
    where id = p_id;
  else
    update app.guest_emails set send_state = case when v_row.attempts >= 5 then 'Failed' else 'Queued' end::app.guest_email_state,
      error = left(p_error, 1000)
    where id = p_id;
  end if;
end;
$$;
comment on function app.finish_guest_email(uuid, text, text) is 'The guest-email worker records a send (service role): Sent with the provider''s message id, or, with an error, Queued again until the fifth attempt and then Failed. A row already Sent is left as it is, so a repeated call changes nothing.';
revoke all on function app.finish_guest_email(uuid, text, text) from public, anon, authenticated;
grant execute on function app.finish_guest_email(uuid, text, text) to service_role;

-- Unsubscribe ---------------------------------------------------------------------------------------------------------------------

create function api_public.unsubscribe_guest_email(p_token text)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_client text;
  v_email app.guest_emails;
begin
  perform private.require_read_write();
  v_client := coalesce(host(private.request_ip()), 'unknown');
  if private.rate_limit_exceeded('guest_email.token.failure', v_client, 20, interval '10 minutes') then
    return null;
  end if;
  select e.* into v_email from private.guest_email_unsubscribe_tokens t
  join app.guest_emails e on e.id = t.guest_email_id
  where t.token_hash = extensions.digest(coalesce(p_token, ''), 'sha256');
  if v_email.id is null or v_email.to_email is null then
    perform private.note_rate_event('guest_email.token.failure', v_client);
    return null;
  end if;
  insert into app.suppression_list (org_id, channel, address, reason, category_code)
  select v_email.org_id, 'Email', v_email.to_email, 'Unsubscribe', null
  where not exists (
    select 1 from app.suppression_list s
    where s.org_id = v_email.org_id and s.channel = 'Email' and s.address = v_email.to_email and s.reason = 'Unsubscribe'
      and s.category_code is null and s.lifted_at is null and s.deleted_at is null);
  return (select o.name from app.organizations o where o.id = v_email.org_id);
end;
$$;
comment on function api_public.unsubscribe_guest_email(text) is 'A guest stops every email from the org that sent them a guest email (gap G-71): the token from the email''s unsubscribe link adds the address to the org''s suppression list once (Unsubscribe, every category). Refuses a read-only (GET) call first, so a mail scanner that only fetches the link unsubscribes nobody. Returns the org name, or NULL for an unknown token; only failed lookups count, 20 per client address in 10 minutes.';
revoke all on function api_public.unsubscribe_guest_email(text) from public;
grant execute on function api_public.unsubscribe_guest_email(text) to anon, authenticated, service_role;

-- Scheduling -------------------------------------------------------------------------------------------------------------------

create function private.request_guest_email_send()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_url text;
  v_key text;
begin
  if not exists (select 1 from app.guest_emails e where e.send_state = 'Queued'
                 or (e.send_state = 'Sending' and e.claimed_at < now() - interval '10 minutes')) then
    return;
  end if;
  select s.decrypted_secret into v_url from vault.decrypted_secrets s where s.name = 'xos_functions_url';
  select s.decrypted_secret into v_key from vault.decrypted_secrets s where s.name = 'xos_worker_key';
  if v_url is null or v_key is null then
    return;
  end if;
  perform net.http_post(
    url := rtrim(v_url, '/') || '/guest-email',
    headers := jsonb_build_object('Authorization', 'Bearer ' || v_key, 'Content-Type', 'application/json'),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
end;
$$;
comment on function private.request_guest_email_send() is 'pg_cron''s guest email step: while guest emails are Queued, calls the guest-email Edge Function with the service key from Vault (xos_worker_key) at the functions URL in Vault (xos_functions_url). Without either it does nothing and the emails wait (infra/runbooks/production.md, Edge Functions).';
revoke all on function private.request_guest_email_send() from public, anon, authenticated;

select cron.schedule('xos_guest_email', '* * * * *', 'select private.request_guest_email_send()');

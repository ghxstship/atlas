-- 3051_subscription_pauses.sql
-- B16 (RRR-240), parity gap G-285, Section 16, ADR 0155 D4. The Owner pauses a monthly, Stripe-paid plan for 1 to 6
-- whole months, for example between seasons. XOS never holds funds: Stripe bills, XOS only records.
--   * A pause starts at the end of the paid period (the link's current_period_end) and resumes exactly N months
--     later, so the org keeps what it paid for. In Stripe it is pause_collection with behavior void, resuming one hour
--     before the XOS resume so the invoice at the boundary is collected. Atlas calls Stripe between
--     app.begin_subscription_pause and app.record_subscription_pause, as with Checkout (1640).
--   * While a pause runs, the org is read-only through the guard of cancellation and dunning with the reason
--     'paused': nothing is deleted, every read and export works, and the deletion and purge schedules do not change.
--     A107's personal-table rule (ADR 0081), factored into private.personal_write_allowed, keeps a person's own
--     preferences, reading marks, consents and legal acceptances writable, and a member can still leave.
--   * The Owner can resume at any time (app.begin_subscription_resume, then app.record_subscription_resume). A pause
--     set in Stripe itself (pause_collection in the dashboard, or status paused: a trial that ended without a card) is
--     mirrored as an open-ended pause with source Stripe, and Stripe clearing it ends it. Stripe does not order its
--     events, so the sync takes each event's created time: an event older than the open pause, or older than the
--     last ended one, changes no pause.
--   * Cancelling the org (app.cancel_organization, from 1063, now allowed while paused), a deletion request, or
--     Stripe deleting the subscription ends the pause as Canceled.
--   * The hourly lifecycle job notifies billing.paused to the billing owners when a pause starts and ends a pause on
--     schedule with billing.resumed.
--   * Read-only refusals now name their actual reason through one helper (private.read_only_refusal), share links
--     included (private.guard_share_link, from 2070).

-- The pauses -----------------------------------------------------------------------------------------------------

create type app.subscription_pause_source as enum ('Owner', 'Stripe');
comment on type app.subscription_pause_source is 'Who started a subscription pause: the Owner in Billing and Plan, or Stripe itself (pause_collection set in the Stripe dashboard, or a paused subscription status).';

create type app.subscription_pause_end as enum ('Resumed by Owner', 'Resumed on schedule', 'Resumed in Stripe', 'Canceled');
comment on type app.subscription_pause_end is 'How a subscription pause ended: the Owner resumed it, it reached its resume date, Stripe cleared it, or the org or its subscription was canceled.';

create table app.subscription_pauses (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  stripe_subscription_link_id uuid not null references app.stripe_subscription_links (id),
  source app.subscription_pause_source not null,
  starts_at timestamptz not null,
  resumes_at timestamptz,
  requested_by uuid references app.people (id),
  ended_at timestamptz,
  ended_by uuid references app.people (id),
  end_reason app.subscription_pause_end,
  started_notified_at timestamptz,
  last_event_at timestamptz,
  constraint subscription_pauses_resumes_after check (resumes_at is null or resumes_at > starts_at),
  constraint subscription_pauses_end_pair check ((ended_at is null) = (end_reason is null)),
  -- Whole months counted in UTC, so the check never depends on the session's time zone.
  constraint subscription_pauses_owner_months check (
    source <> 'Owner' or resumes_at at time zone 'UTC' in (
      (starts_at at time zone 'UTC') + interval '1 month', (starts_at at time zone 'UTC') + interval '2 months',
      (starts_at at time zone 'UTC') + interval '3 months', (starts_at at time zone 'UTC') + interval '4 months',
      (starts_at at time zone 'UTC') + interval '5 months', (starts_at at time zone 'UTC') + interval '6 months'))
);

-- Resuming a paused org writes its pause, so the table never gets the read-only guard.
insert into private.read_only_exempt_tables (table_name, rationale) values
  ('app.subscription_pauses', 'Resuming a paused org writes its pause.');

call private.install_domain_table('app.subscription_pauses', 'app.stripe_subscription_links', 'stripe_subscription_link_id');
create unique index subscription_pauses_open_key on app.subscription_pauses (org_id) where ended_at is null and deleted_at is null;
create index subscription_pauses_link_idx on app.subscription_pauses (stripe_subscription_link_id);
create index subscription_pauses_requested_by_idx on app.subscription_pauses (requested_by);
create index subscription_pauses_ended_by_idx on app.subscription_pauses (ended_by);
call private.describe('app.subscription_pauses', 'Pauses of a monthly Stripe subscription (Section 16, ADR 0155 D4): Stripe stops collecting, and from starts_at until resumes_at the org is read-only and keeps all its data. Written by the pause RPCs, the Stripe webhook sync, cancellation and the hourly lifecycle job; at most one is open per org.', array[
  'stripe_subscription_link_id', 'The Stripe subscription paused (app.stripe_subscription_links), which carries its Stripe id and mode.',
  'source', 'Owner when the Owner paused in Billing and Plan, Stripe when the pause was set in Stripe itself.',
  'starts_at', 'When the org becomes read-only: the end of the paid period for an Owner pause.',
  'resumes_at', 'When the org is writable and billing resumes; an Owner pause resumes 1 to 6 whole months after it starts. Null for an open-ended Stripe pause.',
  'requested_by', 'Owner who paused, or null for a pause set in Stripe.',
  'ended_at', 'When the pause ended; null while it is open.',
  'ended_by', 'Owner who resumed it, or null when it ended on schedule, in Stripe or by cancellation.',
  'end_reason', 'How it ended: Resumed by Owner, Resumed on schedule, Resumed in Stripe or Canceled; set with ended_at.',
  'started_notified_at', 'When the billing owners were told the pause started (billing.paused).',
  'last_event_at', 'Created time of the newest Stripe event applied to this pause.'
]);

call private.install_policies('app.subscription_pauses',
  $$org_id in (select private.orgs_with_capability('org.billing.read'))$$);
revoke insert, update, delete on app.subscription_pauses from authenticated;
call private.install_audit_trail('app.subscription_pauses');
call private.install_default_retention('app.subscription_pauses');

insert into private.trash_excluded_tables (table_name, rationale) values
  ('subscription_pauses', 'Billing evidence written by the pause RPCs and the Stripe sync; no person deletes a pause.')
on conflict (table_name) do nothing;

-- Read-only while paused ---------------------------------------------------------------------------------------

-- Redefined from 1353 (its latest definition): 'paused' after 'dunning', from starts_at until resumes_at.
create or replace function private.org_read_only_reason(p_org_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when exists (select 1 from app.org_deletion_requests r
                 where r.org_id = p_org_id and r.recovered_at is null and r.deleted_at is null) then 'deletion'
    when exists (select 1 from app.org_cancellations c
                 where c.org_id = p_org_id and c.reactivated_at is null and c.deleted_at is null) then 'canceled'
    when exists (select 1 from app.subscriptions s
                 where s.org_id = p_org_id and s.subscription_state = 'read_only' and s.deleted_at is null) then 'dunning'
    when exists (select 1 from app.subscription_pauses p
                 where p.org_id = p_org_id and p.ended_at is null and p.deleted_at is null and p.starts_at <= now()
                   and (p.resumes_at is null or p.resumes_at > now())) then 'paused'
  end;
$$;

comment on function private.org_read_only_reason(uuid) is 'Why an org is read-only: deletion while a deletion request waits out its recovery window, canceled during a cancellation (Section 14.7), dunning from day 21 of a failed payment (Section 16), paused from the start of an open subscription pause until it resumes (3051, ADR 0155 D4), or null when it is writable. Takes the org id as an argument (ADR 0016 rule 14).';

comment on function private.org_read_only(uuid) is 'True while an org is read-only: canceled and not reactivated, waiting for deletion and not recovered (Section 14.7), past day 21 of dunning (Section 16), or paused (3051). Takes the org id as an argument (ADR 0016 rule 14).';

create or replace function private.read_only_refusal(p_reason text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case p_reason
    when 'deletion' then 'This organization is waiting to be deleted and is read-only. The Owner can recover it in Settings, Danger zone, during the 7 days.'
    when 'canceled' then 'This organization is canceled and read-only. The Owner can reactivate it in Settings, Danger zone, during the 30 days.'
    when 'dunning' then 'This organization is read-only because a payment is overdue. An Owner can update the payment method in Settings, Billing and plan; no data is deleted.'
    when 'paused' then 'This organization is paused and read-only. The Owner can resume it in Settings, Billing and plan; no data is deleted.'
  end;
$$;

comment on function private.read_only_refusal(text) is 'The org_read_only sentence for each read-only reason of private.org_read_only_reason (deletion, canceled, dunning, paused), each with its fix; null for a writable org.';
revoke all on function private.read_only_refusal(text) from public, anon, authenticated;

-- A107's personal-table rule (ADR 0081), factored out of private.refuse_over_limit_write so the pause applies the same
-- own-row rules.
create or replace function private.personal_write_allowed(p_table text, p_old jsonb, p_new jsonb)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_membership uuid;
  v_audit constant text[] := array['archived_at', 'deleted_at', 'updated_at', 'updated_by'];
begin
  if not exists (select 1 from private.over_limit_personal_tables t where t.table_name = p_table) then
    return false;
  end if;
  if p_table = 'app.memberships' then
    v_membership := private.as_uuid(p_old ->> 'id');
  elsif p_table = 'app.membership_roles' then
    v_membership := private.as_uuid(p_old ->> 'membership_id');
  end if;
  -- On memberships and roles only the person's own: leaving, or dropping one of their own roles.
  if p_table in ('app.memberships', 'app.membership_roles')
     and (p_old is null or not exists (select 1 from app.memberships m
                                       where m.id = v_membership and m.person_id = private.current_person_id())) then
    return false;
  end if;
  -- On its own roles only a drop: no new role on the row, nothing changed but deleted_at.
  if p_table = 'app.membership_roles' and p_new is not null
     and ((p_new - v_audit) <> (p_old - v_audit) or p_new ->> 'deleted_at' is null) then
    return false;
  end if;
  return true;
end;
$$;

comment on function private.personal_write_allowed(text, jsonb, jsonb) is 'A107''s personal-table rule (ADR 0081): whether a person''s write stays allowed while their other writes are refused. True for the tables of private.over_limit_personal_tables, except that on app.memberships and app.membership_roles only the person''s own membership counts (leaving it, or dropping one of their own roles; never adding a role). Used by the plan-limit guard and by a paused org (3051).';
revoke all on function private.personal_write_allowed(text, jsonb, jsonb) from public, anon, authenticated;

-- Redefined from 2070 (its only definition), behavior unchanged: the personal rule now comes from the helper above.
create or replace function private.refuse_over_limit_write(p_org_id uuid, p_table text, p_old jsonb, p_new jsonb)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_limit app.plan_limit_code;
  v_project uuid;
  v_personal boolean := exists (select 1 from private.over_limit_personal_tables t where t.table_name = p_table);
  v_audit constant text[] := array['archived_at', 'deleted_at', 'updated_at', 'updated_by'];
begin
  -- Only a seat held now counts: once a read-only seat leaves (app.leave_organization sets valid_to = now()), the
  -- writes its leaving sets off in the same statement, such as the offboarding row of t81_open_offboarding, go through
  -- before t93 drops the seat from the set.
  select x.limit_code into v_limit
  from app.over_limit_objects x join app.memberships m on m.id = x.membership_id
  where x.org_id = p_org_id and m.person_id = private.current_person_id()
    and m.deleted_at is null and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now())
  order by x.limit_code
  limit 1;
  -- A read-only seat keeps the personal tables, but on memberships and roles only its own: it may leave the org or
  -- drop its own roles, never add a role or change another member's, so it cannot win itself a seat past the Owner's
  -- choice by demoting someone.
  if v_limit is not null and not private.personal_write_allowed(p_table, p_old, p_new) then
    perform private.refuse('plan_limit_read_only', private.over_limit_refusal(p_org_id, v_limit));
  end if;
  if v_personal
     or not exists (select 1 from app.over_limit_objects x where x.org_id = p_org_id and x.project_id is not null) then
    return;
  end if;
  -- Archiving or deleting a read-only project, and nothing else, brings the org back under the limit.
  if p_table = 'app.projects' and p_old is not null and p_new is not null
     and (p_new - v_audit) = (p_old - v_audit)
     and ((p_old ->> 'archived_at' is null and p_new ->> 'archived_at' is not null)
          or (p_old ->> 'deleted_at' is null and p_new ->> 'deleted_at' is not null)) then
    return;
  end if;
  for v_project in
    select distinct private.row_project_id(p_table, r.data) from (values (p_old), (p_new)) as r (data) where r.data is not null
  loop
    if v_project is not null and exists (select 1 from app.over_limit_objects x where x.project_id = v_project) then
      perform private.refuse('plan_limit_read_only', private.over_limit_refusal(p_org_id, 'active_projects'));
    end if;
  end loop;
end;
$$;

comment on function private.refuse_over_limit_write(uuid, text, jsonb, jsonb) is 'Refuses a person''s write that touches what a plan limit made read-only (ADR 0081): any write of a person whose own seat is read-only, and any write to a read-only project or anything of it, however deep (private.row_project_id), except archiving or deleting that project. The personal tables stay writable (private.personal_write_allowed, 3051): a read-only seat writes memberships and roles only to leave or drop its own roles, and once its membership has ended it is no longer a seat, so what leaving writes (its offboarding) goes through. The refusal plan_limit_read_only names the limit and how to lift it.';
revoke all on function private.refuse_over_limit_write(uuid, text, jsonb, jsonb) from public, anon, authenticated;

-- Redefined from 2070 (its latest definition): each read-only reason refuses with its own sentence, and a paused org
-- keeps the personal tables writable under A107's own-row rules.
create or replace function private.refuse_read_only_org()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := ((case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end) ->> 'org_id')::uuid;
  v_reason text;
  v_table text;
  v_old jsonb := case when tg_op = 'INSERT' then null else to_jsonb(old) end;
  v_new jsonb := case when tg_op = 'DELETE' then null else to_jsonb(new) end;
begin
  if private.current_person_id() is null or v_org is null then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  v_reason := private.org_read_only_reason(v_org);
  if v_reason in ('deletion', 'canceled', 'dunning') then
    perform private.refuse('org_read_only', private.read_only_refusal(v_reason));
  end if;
  if v_reason = 'paused' or exists (select 1 from app.over_limit_objects x where x.org_id = v_org) then
    -- On a partitioned table the trigger runs on the month partition; the guard asks about the table it was declared on.
    v_table := coalesce((select i.inhparent::regclass::text from pg_catalog.pg_inherits i
                         join pg_catalog.pg_class c on c.oid = i.inhrelid
                         where i.inhrelid = tg_relid and c.relispartition), tg_relid::regclass::text);
  end if;
  -- A paused org keeps the personal tables (ADR 0081), and a member may leave: the offboarding row that leaving opens
  -- (t81_open_offboarding) is about their own membership, which has just ended.
  if v_reason = 'paused'
     and not private.personal_write_allowed(v_table, v_old, v_new)
     and not (tg_op = 'INSERT' and v_table = 'app.offboardings'
              and exists (select 1 from app.memberships m
                          where m.id = private.as_uuid(v_new ->> 'membership_id')
                            and m.person_id = private.current_person_id()
                            and m.valid_to is not null and m.valid_to <= now())) then
    perform private.refuse('org_read_only', private.read_only_refusal(v_reason));
  end if;
  if exists (select 1 from app.over_limit_objects x where x.org_id = v_org) then
    perform private.refuse_over_limit_write(v_org, v_table, v_old, v_new);
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

comment on function private.refuse_read_only_org() is 'Refuses a person''s write to a row of a read-only org, with the sentence of its reason (private.read_only_refusal): canceled, waiting for deletion (Section 14.7), past day 21 of dunning (Section 16) or paused (3051); and a write to what a plan limit made read-only (Section 16, 2070). While paused the personal tables stay writable under A107''s own-row rules (private.personal_write_allowed) and a member may leave. Workers, billing and retention (no person) still write.';
revoke all on function private.refuse_read_only_org() from public, anon, authenticated;

-- Share links: app.share_links is exempt from t15 so a link can always be revoked (1380). Recreated from 2070, its
-- latest definition: the read-only refusal names the actual reason instead of the fixed cancellation sentence.
create or replace function private.guard_share_link()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.current_person_id();
  v_attachment app.attachments;
  v_version app.attachment_versions;
  v_token text := 'xshr_' || encode(extensions.gen_random_bytes(32), 'hex');
  v_code text;
  v_limit interval;
  v_reason text;
begin
  if tg_op = 'UPDATE' then
    if not private.in_trusted_operation('share_link_service') then
      perform private.refuse('share_link_immutable', 'A share link changes only when it is opened or revoked.');
    end if;
    return new;
  end if;

  if v_person is null then
    perform private.refuse('share_link_person', 'A share link is made by a signed-in person.');
  end if;
  select * into v_attachment from app.attachments a where a.id = new.attachment_id and a.deleted_at is null;
  select * into v_version from app.attachment_versions v
  where v.attachment_id = new.attachment_id and v.scan_status = 'Clean' and v.deleted_at is null
  order by v.version_number desc limit 1;
  if v_attachment.id is null or v_version.id is null then
    perform private.refuse('share_link_file', 'Only a file with a version that scanned clean can be shared.');
  end if;
  if not private.is_member(v_attachment.org_id) then
    raise exception using errcode = '42501', message = 'file not found';
  end if;
  v_reason := private.org_read_only_reason(v_attachment.org_id);
  if v_reason is not null then
    perform private.refuse('org_read_only', private.read_only_refusal(v_reason));
  end if;
  -- Making a link is a write to its file for the plan limits: refused to a read-only seat and for a read-only project.
  if exists (select 1 from app.over_limit_objects x where x.org_id = v_attachment.org_id) then
    perform private.refuse_over_limit_write(v_attachment.org_id, 'app.attachments', null, to_jsonb(v_attachment));
  end if;

  new.org_id := v_attachment.org_id;
  new.attachment_version_id := v_version.id;
  new.classification := v_attachment.classification;
  new.recipient_email := nullif(lower(btrim(coalesce(new.recipient_email, ''))), '');
  new.note := nullif(btrim(coalesce(new.note, '')), '');
  new.failed_attempts := 0;
  new.open_count := 0;
  new.last_opened_at := null;
  new.revoked_at := null;
  new.revoked_by := null;

  if new.classification = 'Restricted' then
    perform private.refuse('share_link_restricted', 'A Restricted file is never shared by link (Section 8.6).');
  end if;
  if new.classification = 'Confidential' then
    if not private.has_capability(new.org_id, 'data.export.confidential') then
      perform private.refuse('share_link_confidential', 'Sharing a Confidential file needs the export capability for Confidential data.');
    end if;
    if new.recipient_email is null then
      perform private.refuse('share_link_recipient', 'A link to a Confidential file names who it is for; the watermark carries that address.');
    end if;
    if private.watermark_required(new.classification, v_version.content_type)
       and not private.watermarkable_content_type(v_version.content_type) then
      perform private.refuse('share_link_watermark_unsupported', 'A Confidential image other than a PNG or JPEG cannot carry the viewer watermark, so it cannot be shared by link.');
    end if;
    new.access_code_required := true;
  end if;
  if new.expires_at is null and new.classification <> 'Public' then
    perform private.refuse('share_link_expiry', 'A link to an Internal or Confidential file needs an expiry date.');
  end if;
  v_limit := case when new.classification = 'Confidential' then interval '30 days' else interval '90 days' end;
  if new.expires_at is not null and (new.expires_at <= now() or new.expires_at > now() + v_limit) then
    perform private.refuse('share_link_expiry_range', format('A link expires after now and within %s.', v_limit));
  end if;
  if new.recipient_email is not null and new.recipient_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    perform private.refuse('share_link_recipient_format', 'Enter the recipient''s email address.');
  end if;

  if new.access_code_required then
    v_code := lpad(((('x' || encode(extensions.gen_random_bytes(4), 'hex'))::bit(32)::bigint) % 1000000)::text, 6, '0');
    new.access_code_hash := private.share_code_hash(v_token, v_code);
  else
    new.access_code_hash := null;
  end if;
  new.token_hash := private.share_token_hash(v_token);
  perform pg_catalog.set_config('xos.share_link_secret',
    jsonb_build_object('token', v_token, 'access_code', v_code)::text, true);

  insert into app.file_access_log (org_id, person_id, bucket_id, object_path, action, classification, watermarked)
  values (new.org_id, v_person, 'attachments', v_version.object_name, 'Share Link Created', new.classification, false);
  return new;
end;
$$;

comment on function private.guard_share_link() is 'Share links: the database copies the file''s org, classification and current Clean version, applies the Section 8.6 rules (no Restricted file; Internal needs an expiry; Confidential needs data.export.confidential, an expiry within 30 days, an access code, the recipient''s email and a type the watermark can carry: a PDF, PNG or JPEG since 2040), draws the token and the code, stores only their hashes and logs Share Link Created. A read-only org makes no link, refused with the sentence of its reason (private.read_only_refusal, 3051). Making a link counts as a write to its file for the plan limits (2070, ADR 0081): a person whose own seat is read-only, or a file of a read-only project, gets plan_limit_read_only. Afterwards a link changes only inside the open and revoke RPCs, so revoking stays open.';
revoke all on function private.guard_share_link() from public, anon, authenticated;

-- Notices ---------------------------------------------------------------------------------------------------------

create or replace function private.notify_billing_owners(p_org_id uuid, p_kind text, p_pause_id uuid, p_args jsonb)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid;
begin
  -- Billing owners exactly as private.run_dunning (0560) chooses them: an organization-wide reach on org.billing.read.
  for v_person in
    select distinct m.person_id from app.memberships m
    where m.org_id = p_org_id and m.deleted_at is null and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now())
      and private.person_capability_reach(m.person_id, p_org_id, 'org.billing.read', false) = 'organization'
  loop
    perform private.notify(p_org_id, v_person, p_kind, 'app.subscription_pauses', p_pause_id, null, coalesce(p_args, '{}'::jsonb));
  end loop;
end;
$$;

comment on function private.notify_billing_owners(uuid, text, uuid, jsonb) is 'Notifies every billing owner of the org (an organization-wide reach on org.billing.read, as private.run_dunning chooses them) about a subscription pause.';
revoke all on function private.notify_billing_owners(uuid, text, uuid, jsonb) from public, anon, authenticated;

create or replace function private.pause_notice_args(p_resumes_at timestamptz)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object('resumesOn', coalesce(to_char(p_resumes_at at time zone 'UTC', 'YYYY-MM-DD'), 'none'));
$$;

comment on function private.pause_notice_args(timestamptz) is 'The message arguments of billing.paused: the resume date in UTC as YYYY-MM-DD, or none for an open-ended Stripe pause.';
revoke all on function private.pause_notice_args(timestamptz) from public, anon, authenticated;

create or replace function private.pause_resume_at(p_starts_at timestamptz, p_months integer)
returns timestamptz
language sql
immutable
set search_path = ''
as $$
  select ((p_starts_at at time zone 'UTC') + make_interval(months => p_months)) at time zone 'UTC';
$$;

comment on function private.pause_resume_at(timestamptz, integer) is 'When a pause that starts at p_starts_at resumes: exactly p_months whole months later, counted in UTC.';
revoke all on function private.pause_resume_at(timestamptz, integer) from public, anon, authenticated;

-- The checks ------------------------------------------------------------------------------------------------------

create or replace function private.assert_subscription_pause(
  p_org_id uuid,
  p_months integer,
  p_livemode boolean,
  p_open_allowed uuid default null
)
returns app.stripe_subscription_links
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org app.organizations;
  v_sub app.subscriptions;
  v_link app.stripe_subscription_links;
  v_open app.subscription_pauses;
begin
  if not private.has_capability(p_org_id, 'org.billing.manage') then
    raise exception using errcode = '42501', message = 'org.billing.manage is required';
  end if;
  select * into v_org from app.organizations o where o.id = p_org_id and o.deleted_at is null;
  if v_org.id is null then
    perform private.refuse('billing_org_unknown', 'The organization does not exist.');
  end if;
  if private.is_sandbox_org(p_org_id) then
    perform private.refuse('sandbox_not_billable', 'A sandbox is never billed.');
  end if;
  if v_org.parent_org_id is not null then
    perform private.refuse('billing_through_partner', 'Your partner bills this organization. Ask the partner about a pause.');
  end if;
  if private.org_read_only(p_org_id) then
    perform private.refuse('org_read_only', 'A read-only organization cannot pause. Settle what made it read-only first.');
  end if;
  if not private.paid_through_stripe(p_org_id, coalesce(p_livemode, false)) then
    perform private.refuse('pause_not_paid', 'Only a plan paid through Stripe can pause.');
  end if;
  select * into v_sub from app.subscriptions s
  where s.org_id = p_org_id and s.subscription_state <> 'canceled' and s.deleted_at is null;
  if v_sub.subscription_state = 'trialing' then
    perform private.refuse('pause_trial', 'A trial cannot pause. Pause once the plan is paid.');
  end if;
  if v_sub.subscription_state is distinct from 'active' then
    perform private.refuse('pause_past_due', 'A payment is overdue, so billing cannot pause. Update the payment method first.');
  end if;
  select * into v_link from app.stripe_subscription_links l
  where l.subscription_id = v_sub.id and l.livemode = coalesce(p_livemode, false) and l.deleted_at is null
  order by l.created_at desc limit 1;
  if v_link.billing_interval is distinct from 'Monthly' then
    perform private.refuse('pause_annual', 'An annual plan is paid for the year and cannot pause.');
  end if;
  select * into v_open from app.subscription_pauses p where p.org_id = p_org_id and p.ended_at is null and p.deleted_at is null;
  if v_open.id is not null and v_open.id is distinct from p_open_allowed then
    perform private.refuse('pause_open', 'This organization already has a pause. Resume it or cancel it first.');
  end if;
  if p_months is null or p_months not between 1 and 6 then
    perform private.refuse('pause_months_range', 'A pause lasts 1 to 6 whole months.');
  end if;
  if v_link.current_period_end is null or v_link.current_period_end <= now() then
    perform private.refuse('pause_period_unknown', 'Stripe has not reported the end of the paid period yet. Try again in a minute.');
  end if;
  perform private.require_second_factor('change billing');
  return v_link;
end;
$$;

comment on function private.assert_subscription_pause(uuid, integer, boolean, uuid) is 'The checks before a pause, in order (ADR 0155 D4): org.billing.manage (42501 otherwise); a live org (billing_org_unknown), not a sandbox (sandbox_not_billable), not billed by its partner (billing_through_partner) and not read-only (org_read_only); a plan paid through Stripe in that mode (pause_not_paid); not a trial (pause_trial) and not past due (pause_past_due); a monthly plan (pause_annual); no open pause other than p_open_allowed (pause_open); 1 to 6 months (pause_months_range); a paid period end in the future (pause_period_unknown); and last a second factor in the last 15 minutes (step_up_required). A Stripe trial cannot be seen here; Atlas checks it in Stripe. Returns the Stripe subscription link.';
revoke all on function private.assert_subscription_pause(uuid, integer, boolean, uuid) from public, anon, authenticated;

-- Atlas: pausing and resuming ------------------------------------------------------------------------------------------

create or replace function app.begin_subscription_pause(p_org_id uuid, p_months integer, p_livemode boolean)
returns table (stripe_subscription_id text, starts_at timestamptz, resumes_at timestamptz)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_link app.stripe_subscription_links := private.assert_subscription_pause(p_org_id, p_months, p_livemode);
begin
  return query select v_link.stripe_subscription_id, v_link.current_period_end,
    private.pause_resume_at(v_link.current_period_end, p_months);
end;
$$;

comment on function app.begin_subscription_pause(uuid, integer, boolean) is 'Atlas, before it asks Stripe to pause (ADR 0155 D4): runs the pause checks (private.assert_subscription_pause, step-up last) and returns the Stripe subscription, when the pause starts (the end of the paid period) and when it resumes (exactly p_months later). Atlas then sets pause_collection in Stripe and records the pause.';
revoke all on function app.begin_subscription_pause(uuid, integer, boolean) from public, anon;
grant execute on function app.begin_subscription_pause(uuid, integer, boolean) to authenticated;

create or replace function app.record_subscription_pause(
  p_org_id uuid,
  p_months integer,
  p_livemode boolean,
  p_stripe_subscription_id text
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_mirror app.subscription_pauses;
  v_link app.stripe_subscription_links;
  v_id uuid;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('billing:' || p_org_id::text, 0));
  -- The webhook may have mirrored the pause Stripe just set before Atlas records it: that pause becomes the Owner's.
  select p.* into v_mirror from app.subscription_pauses p
  join app.stripe_subscription_links l on l.id = p.stripe_subscription_link_id
  where p.org_id = p_org_id and p.ended_at is null and p.deleted_at is null and p.source = 'Stripe'
    and l.stripe_subscription_id = p_stripe_subscription_id and p.created_at > now() - interval '10 minutes';
  v_link := private.assert_subscription_pause(p_org_id, p_months, p_livemode, v_mirror.id);
  if v_link.stripe_subscription_id is distinct from p_stripe_subscription_id then
    perform private.refuse('billing_org_mismatch', 'The Stripe subscription is not this organization''s current one.');
  end if;
  if v_mirror.id is not null then
    update app.subscription_pauses
    set source = 'Owner', starts_at = v_link.current_period_end,
        resumes_at = private.pause_resume_at(v_link.current_period_end, p_months), requested_by = private.current_person_id()
    where id = v_mirror.id;
    return v_mirror.id;
  end if;
  insert into app.subscription_pauses (stripe_subscription_link_id, source, starts_at, resumes_at, requested_by)
  values (v_link.id, 'Owner', v_link.current_period_end, private.pause_resume_at(v_link.current_period_end, p_months),
    private.current_person_id())
  returning id into v_id;
  return v_id;
end;
$$;

comment on function app.record_subscription_pause(uuid, integer, boolean, text) is 'Atlas, once Stripe set pause_collection: runs the pause checks again under the billing lock and records the Owner''s pause from the end of the paid period for p_months months. Idempotent with the webhook: a Stripe-source pause of the same subscription it mirrored in the last 10 minutes becomes the Owner''s pause with these dates. Returns the pause id.';
revoke all on function app.record_subscription_pause(uuid, integer, boolean, text) from public, anon;
grant execute on function app.record_subscription_pause(uuid, integer, boolean, text) to authenticated;

create or replace function private.assert_subscription_resume(p_org_id uuid, p_livemode boolean)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.has_capability(p_org_id, 'org.billing.manage') then
    raise exception using errcode = '42501', message = 'org.billing.manage is required';
  end if;
  perform private.require_second_factor('change billing');
end;
$$;

comment on function private.assert_subscription_resume(uuid, boolean) is 'The capability and step-up checks of resuming a pause: org.billing.manage (42501 otherwise), then a second factor in the last 15 minutes.';
revoke all on function private.assert_subscription_resume(uuid, boolean) from public, anon, authenticated;

create or replace function app.begin_subscription_resume(p_org_id uuid, p_livemode boolean)
returns table (stripe_subscription_id text, started boolean)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_pause app.subscription_pauses;
  v_stripe text;
begin
  if not private.has_capability(p_org_id, 'org.billing.manage') then
    raise exception using errcode = '42501', message = 'org.billing.manage is required';
  end if;
  select p.* into v_pause from app.subscription_pauses p
  where p.org_id = p_org_id and p.ended_at is null and p.deleted_at is null;
  select l.stripe_subscription_id into v_stripe from app.stripe_subscription_links l
  where l.id = v_pause.stripe_subscription_link_id and l.livemode = coalesce(p_livemode, false);
  if v_pause.id is null or v_stripe is null then
    perform private.refuse('pause_none', 'This organization has no pause to resume.');
  end if;
  perform private.assert_subscription_resume(p_org_id, p_livemode);
  return query select v_stripe, v_pause.starts_at <= now();
end;
$$;

comment on function app.begin_subscription_resume(uuid, boolean) is 'Atlas, before it asks Stripe to resume: the caller holds org.billing.manage (42501 otherwise), the org has an open pause in that mode (pause_none), and last a second factor in the last 15 minutes. Works while the org is read-only. Returns the Stripe subscription and whether the pause has started: before it, resuming only removes the pause; after it, Stripe starts a new billing period now.';
revoke all on function app.begin_subscription_resume(uuid, boolean) from public, anon;
grant execute on function app.begin_subscription_resume(uuid, boolean) to authenticated;

create or replace function app.record_subscription_resume(p_org_id uuid, p_livemode boolean)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  perform private.assert_subscription_resume(p_org_id, p_livemode);
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('billing:' || p_org_id::text, 0));
  update app.subscription_pauses p
  set ended_at = now(), end_reason = 'Resumed by Owner', ended_by = private.current_person_id()
  where p.org_id = p_org_id and p.ended_at is null and p.deleted_at is null
    and exists (select 1 from app.stripe_subscription_links l
                where l.id = p.stripe_subscription_link_id and l.livemode = coalesce(p_livemode, false))
  returning p.id into v_id;
  if v_id is null then
    -- The webhook may have ended it first, when Stripe cleared the pause Atlas just lifted.
    update app.subscription_pauses p
    set end_reason = 'Resumed by Owner', ended_by = private.current_person_id()
    where p.id = (select q.id from app.subscription_pauses q
                  join app.stripe_subscription_links l on l.id = q.stripe_subscription_link_id
                  where q.org_id = p_org_id and q.end_reason = 'Resumed in Stripe' and q.deleted_at is null
                    and q.ended_at > now() - interval '10 minutes' and l.livemode = coalesce(p_livemode, false)
                  order by q.ended_at desc limit 1)
    returning p.id into v_id;
  end if;
  if v_id is null then
    perform private.refuse('pause_none', 'This organization has no pause to resume.');
  end if;
  return v_id;
end;
$$;

comment on function app.record_subscription_resume(uuid, boolean) is 'Atlas, once Stripe resumed: ends the open pause as Resumed by Owner, with who resumed it (org.billing.manage and step-up again). Idempotent with the webhook: a pause it ended as Resumed in Stripe in the last 10 minutes is rewritten as Resumed by Owner. Refuses pause_none otherwise. Returns the pause id.';
revoke all on function app.record_subscription_resume(uuid, boolean) from public, anon;
grant execute on function app.record_subscription_resume(uuid, boolean) to authenticated;

create or replace function app.subscription_pause_status(p_org_id uuid)
returns table (
  pause_id uuid,
  source app.subscription_pause_source,
  months integer,
  starts_at timestamptz,
  resumes_at timestamptz,
  started boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.has_capability(p_org_id, 'org.billing.read') then
    raise exception using errcode = '42501', message = 'org.billing.read is required';
  end if;
  return query
    select p.id, p.source,
           case when p.resumes_at is not null then
             (extract(year from age(p.resumes_at at time zone 'UTC', p.starts_at at time zone 'UTC')) * 12
              + extract(month from age(p.resumes_at at time zone 'UTC', p.starts_at at time zone 'UTC')))::integer end,
           p.starts_at, p.resumes_at, p.starts_at <= now()
    from app.subscription_pauses p
    where p.org_id = p_org_id and p.ended_at is null and p.deleted_at is null;
end;
$$;

comment on function app.subscription_pause_status(uuid) is 'The org''s open subscription pause for Billing and Plan (org.billing.read, 42501 otherwise): who started it, how many months (null for an open-ended Stripe pause), when it starts and resumes, and whether it has started. No row without one.';
revoke all on function app.subscription_pause_status(uuid) from public, anon;
grant execute on function app.subscription_pause_status(uuid) to authenticated, service_role;

-- Stripe sync ------------------------------------------------------------------------------------------------------

drop function app.sync_subscription_from_stripe(uuid, text, text, text, app.billing_interval, text, timestamptz, boolean, integer);

-- Recreated from 1250 (its latest definition) with the pause, under the same billing lock and before 1250's early
-- return for a status that changes no state (Stripe's paused status maps to null).
create function app.sync_subscription_from_stripe(
  p_org_id uuid,
  p_stripe_customer_id text,
  p_stripe_subscription_id text,
  p_plan_code text,
  p_billing_interval app.billing_interval,
  p_stripe_status text,
  p_current_period_end timestamptz,
  p_livemode boolean,
  p_extra_seats integer default 0,
  p_pause_collection boolean default false,
  p_pause_resumes_at timestamptz default null,
  p_event_created_at timestamptz default null
)
returns app.subscription_state
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_sub app.subscriptions;
  v_link app.stripe_subscription_links;
  v_target app.subscription_state := private.stripe_status_state(p_stripe_status);
  v_event timestamptz := coalesce(p_event_created_at, now());
  v_paused boolean := p_stripe_status = 'paused' or coalesce(p_pause_collection, false);
  v_pause app.subscription_pauses;
  v_stale boolean;
  v_starts timestamptz;
  v_resumes timestamptz;
  v_id uuid;
begin
  if not exists (select 1 from app.organizations o where o.id = p_org_id and o.deleted_at is null) then
    perform private.refuse('billing_org_unknown', 'The Stripe subscription names no live org.');
  end if;
  if not exists (select 1 from app.plans p where p.code = p_plan_code) then
    perform private.refuse('plan_unknown', format('%s is not a plan.', p_plan_code));
  end if;
  if coalesce(p_extra_seats, 0) < 0 or coalesce(p_extra_seats, 0) > 10000 then
    perform private.refuse('extra_seats_range', 'Extra seats run from 0 to 10,000.');
  end if;
  if coalesce(p_extra_seats, 0) > 0
     and not exists (select 1 from private.plan_extra_seat_prices x where x.plan_code = p_plan_code) then
    perform private.refuse('extra_seats_not_sold', format('The %s plan sells no extra seats.', p_plan_code));
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('billing:' || p_org_id::text, 0));
  select * into v_link from app.stripe_subscription_links l where l.stripe_subscription_id = p_stripe_subscription_id and l.deleted_at is null;
  if v_link.id is not null and v_link.org_id <> p_org_id then
    perform private.refuse('billing_org_mismatch', 'The Stripe subscription belongs to another org.');
  end if;
  select * into v_sub from app.subscriptions s
  where s.org_id = p_org_id and s.subscription_state <> 'canceled' and s.deleted_at is null for update;

  -- The pause (3051), for the org's current Stripe subscription. Stripe does not order its events: one older than the
  -- open pause, or than the last pause that ended, changes no pause.
  if v_link.id is not null and v_sub.id is not null and v_link.subscription_id = v_sub.id then
    select p.* into v_pause from app.subscription_pauses p
    where p.org_id = p_org_id and p.ended_at is null and p.deleted_at is null for update;
    v_stale := (v_pause.id is not null and v_event < v_pause.created_at)
      or exists (select 1 from app.subscription_pauses p
                 where p.org_id = p_org_id and p.deleted_at is null and p.ended_at > v_event);
    if v_target = 'canceled' then
      if v_pause.id is not null then
        update app.subscription_pauses set ended_at = now(), end_reason = 'Canceled', last_event_at = v_event
        where id = v_pause.id;
      end if;
    elsif not v_stale and v_paused and v_pause.id is null then
      v_starts := case when p_stripe_status = 'paused' then now()
                       else greatest(now(), coalesce(p_current_period_end, v_link.current_period_end, now())) end;
      v_resumes := p_pause_resumes_at + interval '1 hour';
      insert into app.subscription_pauses (stripe_subscription_link_id, source, starts_at, resumes_at, last_event_at)
      values (v_link.id, 'Stripe', v_starts, case when v_resumes > v_starts then v_resumes end, v_event)
      returning id into v_id;
    elsif not v_stale and v_paused then
      update app.subscription_pauses
      set last_event_at = greatest(coalesce(last_event_at, v_event), v_event),
          resumes_at = case when source = 'Stripe'
                            then case when p_pause_resumes_at + interval '1 hour' > starts_at then p_pause_resumes_at + interval '1 hour' end
                            else resumes_at end
      where id = v_pause.id;
    elsif not v_stale and v_pause.id is not null then
      -- Stripe clears pause_collection at its own resumes_at, an hour before the XOS resume.
      if v_pause.source = 'Owner' and v_pause.resumes_at <= now() + interval '2 hours' then
        update app.subscription_pauses set ended_at = now(), end_reason = 'Resumed on schedule', last_event_at = v_event
        where id = v_pause.id;
        perform private.notify_billing_owners(p_org_id, 'billing.resumed', v_pause.id, '{}'::jsonb);
      else
        update app.subscription_pauses set ended_at = now(), end_reason = 'Resumed in Stripe', last_event_at = v_event
        where id = v_pause.id;
      end if;
    end if;
  end if;

  if v_target is null then
    return v_sub.subscription_state;
  end if;
  if v_target = 'canceled' then
    if v_sub.id is not null and (v_link.id is null or v_link.subscription_id = v_sub.id) then
      perform private.transition_subscription(v_sub.id, v_sub.subscription_state, 'canceled', 'Stripe subscription ended.');
      perform private.create_subscription(p_org_id, 'access');
    end if;
    update app.stripe_subscription_links set current_period_end = p_current_period_end where id = v_link.id;
    return 'canceled';
  end if;
  if v_sub.id is null then
    perform private.create_subscription(p_org_id, p_plan_code);
    select * into v_sub from app.subscriptions s where s.org_id = p_org_id and s.subscription_state <> 'canceled' and s.deleted_at is null;
  end if;
  if v_sub.plan_code <> p_plan_code or v_sub.extra_seats <> coalesce(p_extra_seats, 0) then
    update app.subscriptions set plan_code = p_plan_code, extra_seats = coalesce(p_extra_seats, 0) where id = v_sub.id;
  end if;
  if v_sub.subscription_state <> v_target then
    perform private.transition_subscription(v_sub.id, v_sub.subscription_state, v_target,
      format('Stripe subscription is %s.', p_stripe_status));
  end if;
  if v_link.id is null then
    insert into app.stripe_subscription_links (subscription_id, stripe_customer_id, stripe_subscription_id, billing_interval, livemode, current_period_end)
    values (v_sub.id, p_stripe_customer_id, p_stripe_subscription_id, p_billing_interval, p_livemode, p_current_period_end);
  else
    update app.stripe_subscription_links
    set subscription_id = v_sub.id, billing_interval = p_billing_interval, current_period_end = p_current_period_end
    where id = v_link.id;
  end if;
  return v_target;
end;
$$;

comment on function app.sync_subscription_from_stripe(uuid, text, text, text, app.billing_interval, text, timestamptz, boolean, integer, boolean, timestamptz, timestamptz) is 'Billing API (service role): applies a Stripe subscription to the org''s subscription. Sets the plan the server module resolved from the price lookup key and the extra seats from the quantity of the plan''s extra-seat price (ADR 0035), moves the state through the transition engine (active, past_due or canceled), links the Stripe ids, and on cancellation returns the org to the Access plan without deleting data (Section 14.7). Mirrors the subscription pause (3051, ADR 0155 D4): pause_collection or a paused status with no open pause opens a Stripe-source pause (from the paid period end, or now for a paused status, until Stripe''s resumes_at plus one hour, or open-ended); neither ends an open pause, as Resumed on schedule (with billing.resumed) when an Owner pause is within two hours of its resume, else Resumed in Stripe; cancellation ends it as Canceled. p_event_created_at is the Stripe event''s created time: an event older than the open pause, or than the last pause that ended, changes no pause. Serialized per org.';
revoke all on function app.sync_subscription_from_stripe(uuid, text, text, text, app.billing_interval, text, timestamptz, boolean, integer, boolean, timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function app.sync_subscription_from_stripe(uuid, text, text, text, app.billing_interval, text, timestamptz, boolean, integer, boolean, timestamptz, timestamptz) to service_role;

-- Cancellation ends a pause ----------------------------------------------------------------------------------------

create or replace function private.end_pause_on_cancellation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update app.subscription_pauses set ended_at = now(), end_reason = 'Canceled'
  where org_id = new.org_id and ended_at is null and deleted_at is null;
  return null;
end;
$$;

comment on function private.end_pause_on_cancellation() is 'Ends an org''s open subscription pause as Canceled when the org is canceled (app.org_cancellations) or asks to be deleted (app.org_deletion_requests): the subscription is canceled in the database, so a recovered or reactivated org never finds a pause left open on it.';
revoke all on function private.end_pause_on_cancellation() from public, anon, authenticated;

create trigger t91_end_subscription_pause after insert on app.org_cancellations
  for each row execute function private.end_pause_on_cancellation();
create trigger t91_end_subscription_pause after insert on app.org_deletion_requests
  for each row execute function private.end_pause_on_cancellation();

-- Redefined from 1063 (its only definition): a paused org can be canceled, which ends the pause (the trigger above);
-- an org read-only for another reason is refused as before.
create or replace function app.cancel_organization(p_org_id uuid, p_confirm_name text, p_reason text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
  v_org app.organizations;
  v_sub app.subscriptions;
  v_id uuid;
begin
  if not private.has_capability(p_org_id, 'org.organization.delete') then
    raise exception using errcode = '42501', message = 'org.organization.delete is required';
  end if;
  select * into v_org from app.organizations o where o.id = p_org_id and o.deleted_at is null for update;
  if private.org_read_only(p_org_id) and private.org_read_only_reason(p_org_id) <> 'paused' then
    perform private.refuse('org_already_canceled', 'This organization is already canceled.');
  end if;
  if p_confirm_name is null or btrim(p_confirm_name) <> v_org.name then
    perform private.refuse('org_name_mismatch', 'Type the organization''s name exactly to confirm.');
  end if;
  if p_reason is null or char_length(btrim(p_reason)) not between 1 and 1000 then
    perform private.refuse('org_cancel_reason', 'Say why the organization is canceled, in up to 1,000 characters.');
  end if;
  if exists (select 1 from app.organizations c where c.parent_org_id = p_org_id and c.deleted_at is null) then
    perform private.refuse('org_cancel_has_clients', 'A partner with client orgs cannot cancel; move each client to direct billing first.');
  end if;
  select * into v_sub from app.subscriptions s
  where s.org_id = p_org_id and s.subscription_state <> 'canceled' and s.deleted_at is null for update;
  if v_sub.id is not null then
    perform private.transition_subscription(v_sub.id, v_sub.subscription_state, 'canceled', 'Canceled by the Owner: ' || left(btrim(p_reason), 400));
  end if;
  insert into app.org_cancellations (org_id, reason, canceled_at, read_only_until, purge_after)
  values (p_org_id, btrim(p_reason), now(), now() + interval '30 days', now() + interval '90 days')
  returning id into v_id;
  return v_id;
end;
$$;

comment on function app.cancel_organization(uuid, text, text) is 'Cancels an org (Section 14.7): the Owner (org.organization.delete) types the org name and a reason. The subscription is canceled in the database (the billing service ends any Stripe subscription through its own seam), the org becomes read-only for 30 days with the full export available, and its data is due for deletion at day 90. A paused org can be canceled, which ends its pause as Canceled (3051); an org read-only for another reason is refused. Refuses a partner that still has client orgs. Returns the cancellation id.';
revoke all on function app.cancel_organization(uuid, text, text) from public, anon;
grant execute on function app.cancel_organization(uuid, text, text) to authenticated, service_role;

-- The hourly job ----------------------------------------------------------------------------------------------------

create or replace function private.run_subscription_pauses(p_now timestamptz default now())
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_pause app.subscription_pauses;
  v_count integer := 0;
begin
  for v_pause in
    select p.* from app.subscription_pauses p
    where p.ended_at is null and p.deleted_at is null and p.started_notified_at is null and p.starts_at <= p_now
      and (p.resumes_at is null or p.resumes_at > p_now)
    for update skip locked
  loop
    update app.subscription_pauses set started_notified_at = p_now where id = v_pause.id;
    perform private.notify_billing_owners(v_pause.org_id, 'billing.paused', v_pause.id, private.pause_notice_args(v_pause.resumes_at));
    v_count := v_count + 1;
  end loop;
  for v_pause in
    select p.* from app.subscription_pauses p
    where p.ended_at is null and p.deleted_at is null and p.resumes_at <= p_now
    for update skip locked
  loop
    update app.subscription_pauses set ended_at = p_now, end_reason = 'Resumed on schedule' where id = v_pause.id;
    perform private.notify_billing_owners(v_pause.org_id, 'billing.resumed', v_pause.id, '{}'::jsonb);
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

comment on function private.run_subscription_pauses(timestamptz) is 'Hourly (3051, ADR 0155 D4): tells the billing owners when a pause has started (billing.paused, once) and ends each pause whose resume date passed as Resumed on schedule (billing.resumed). Read-only itself follows the dates in private.org_read_only_reason, so it starts and lifts on time whatever the job''s hour. Returns the actions taken.';
revoke all on function private.run_subscription_pauses(timestamptz) from public, anon, authenticated;

-- Redefined from 2070 (its latest definition): the subscription pauses join the hourly job.
create or replace function private.run_org_lifecycle(p_now timestamptz default now())
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  return private.run_trials(p_now) + private.expire_ownership_transfers(p_now) + private.revert_white_label(p_now)
    + private.schedule_deletions(p_now) + private.run_org_purges(5) + private.refresh_over_limit(p_now)
    + private.run_subscription_pauses(p_now);
end;
$$;

comment on function private.run_org_lifecycle(timestamptz) is 'Hourly org lifecycle job (Section 12, Section 14.7, Section 16): trials, lapsed ownership offers, white label kept past a downgrade, certificates for orgs due for deletion, the purge of orgs whose storage objects the worker deleted, read-only objects over plan limits (2070), then subscription pauses starting and resuming (3051). Returns the actions taken.';
revoke all on function private.run_org_lifecycle(timestamptz) from public, anon, authenticated;

-- The org banners ---------------------------------------------------------------------------------------------------

drop function app.org_banner_status(uuid);

-- Recreated from 2071 (its latest definition) with the pause's dates: for every member once it has started, and for
-- billing readers while it is scheduled.
create function app.org_banner_status(p_org_id uuid)
returns table (
  read_only_reason text,
  read_only_until timestamptz,
  purge_after timestamptz,
  recover_until timestamptz,
  trial_plan text,
  trial_ends_at timestamptz,
  billing_state text,
  past_due_since timestamptz,
  white_label_until timestamptz,
  ownership_transfer_id uuid,
  ownership_offered_by text,
  ownership_expires_at timestamptz,
  over_limit_plan text,
  read_only_projects integer,
  read_only_seats integer,
  read_only_field_seats integer,
  own_seat_read_only text,
  pause_starts_at timestamptz,
  pause_resumes_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_reason text;
  v_sub app.subscriptions;
  v_staff boolean;
  v_billing boolean;
begin
  if not private.is_member(p_org_id) then
    raise exception using errcode = '42501', message = 'banner status needs an active membership in the org';
  end if;
  v_reason := private.org_read_only_reason(p_org_id);
  v_staff := private.has_capability(p_org_id, 'org.settings.read');
  v_billing := private.has_capability(p_org_id, 'org.billing.read');
  select * into v_sub from app.subscriptions s
  where s.org_id = p_org_id and s.subscription_state <> 'canceled' and s.deleted_at is null;
  return query select
    v_reason,
    (select c.read_only_until from app.org_cancellations c where c.org_id = p_org_id and c.reactivated_at is null and c.deleted_at is null limit 1),
    (select c.purge_after from app.org_cancellations c where c.org_id = p_org_id and c.reactivated_at is null and c.deleted_at is null limit 1),
    (select r.recover_until from app.org_deletion_requests r where r.org_id = p_org_id and r.recovered_at is null and r.deleted_at is null limit 1),
    case when v_sub.subscription_state = 'trialing' then v_sub.plan_code end,
    case when v_sub.subscription_state = 'trialing' then v_sub.trial_ends_at end,
    case when v_sub.subscription_state in ('past_due', 'read_only') and (v_staff or v_sub.subscription_state = 'read_only')
         then v_sub.subscription_state::text end,
    case when v_sub.subscription_state in ('past_due', 'read_only') and (v_staff or v_sub.subscription_state = 'read_only')
         then private.past_due_since(v_sub.id) end,
    case when v_staff then (select g.kept_until from app.white_label_grace g
                            where g.org_id = p_org_id and g.ended_at is null and g.deleted_at is null and g.kept_until > now()
                            limit 1) end,
    o.id, o.offered_by, o.expires_at,
    x.plan_code, coalesce(x.projects, 0), coalesce(x.seats, 0), coalesce(x.field_seats, 0),
    (select ox.limit_code::text from app.over_limit_objects ox
     join app.memberships m on m.id = ox.membership_id
     where ox.org_id = p_org_id and m.person_id = private.current_person_id()
     order by ox.limit_code limit 1),
    case when pz.started or v_billing then pz.starts_at end,
    case when pz.started or v_billing then pz.resumes_at end
  from (select 1) one
  left join lateral (
    select t.id, p.full_name as offered_by, t.expires_at from app.ownership_transfers t
    join app.people p on p.id = t.from_person_id
    where t.org_id = p_org_id and t.to_person_id = private.current_person_id()
      and t.accepted_at is null and t.declined_at is null and t.canceled_at is null and t.expired_at is null
      and t.deleted_at is null and t.expires_at > now()
    limit 1
  ) o on true
  left join lateral (
    select min(ox.plan_code) as plan_code,
      (count(*) filter (where ox.limit_code = 'active_projects'))::integer as projects,
      (count(*) filter (where ox.limit_code = 'seats'))::integer as seats,
      (count(*) filter (where ox.limit_code = 'field_members'))::integer as field_seats
    from app.over_limit_objects ox where ox.org_id = p_org_id
    having count(*) > 0
  ) x on true
  left join lateral (
    select sp.starts_at, sp.resumes_at, sp.starts_at <= now() as started from app.subscription_pauses sp
    where sp.org_id = p_org_id and sp.ended_at is null and sp.deleted_at is null
      and (sp.resumes_at is null or sp.resumes_at > now())
    limit 1
  ) pz on true;
end;
$$;

comment on function app.org_banner_status(uuid) is 'Everything the org banners show, in one call, for an active member: why the org is read-only with its dates (cancellation, deletion request, dunning, pause), the running trial and its end, the dunning state and when the payment first failed (Owners and Admins from day 0, everyone once the org is read-only), until when a downgraded org keeps its white label (1355), an ownership offer made to the caller (1352), what plan limits made read-only (2071): the plan, how many projects, seats and field seats, and whether the caller''s own seat is read-only (seats or field_members), and the subscription pause''s start and resume (3051): for every member once it has started, for billing readers (org.billing.read) while it is scheduled.';
revoke all on function app.org_banner_status(uuid) from public, anon;
grant execute on function app.org_banner_status(uuid) to authenticated, service_role;

select private.sync_trash_tables();

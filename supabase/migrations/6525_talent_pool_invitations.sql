-- 6525_talent_pool_invitations.sql
-- B10 Crew onboarding, recruitment and account-free field access (RRR-234, gap G-132, ADR 0149 decisions 1 and 5).
-- An org invites people into a Talent pool by email, one at a time or from a spreadsheet (6526), and never creates a
-- person or a profile for them (ADR 0008, ADR 0019 item 10): the invitee claims the invitation by signing in to
-- Gateway with that confirmed email, as an account or roster invitation (2630, 2636).
--   * app.talent_pool_invitations: an email invited into a live Talent pool, with the org's own label for the
--     invitee, a work phone, a role and an informational standing rate. One pending invitation per pool and email;
--     pending means no outcome and not deleted, expired ones included, because a partial unique index cannot read
--     now(): an expired invitation is reissued in place, never duplicated. Every insert, and every reissue that moves
--     the expiry later, queues one party_invitation email of kind pool that names the org and the role, never the pool.
--     The import worker has no session, so an invitee unknown to XOS reads the email in en-US.
--   * The rate is Restricted (data.restricted.read.payroll) and never directly selectable (0700, 2663): the column
--     grants leave rate_minor out and org readers go through app.talent_pool_invitation_list, which masks it.
--     note, invitee_name and work_phone are Confidential. The emails, phones, labels and notes of people who never
--     joined are read only by pool managers: opportunities.pool.write org-wide, not the wider application read.
--   * Declined invitees and volume: an address that declined is not invited again into the same pool for 12 months
--     (pool_invitation_declined), and an org queues at most 2000 invitation emails a day (pool_invitation_daily_limit).
--   * app.pool_member_rates: one live standing rate per pool member, read through app.pool_member_rate_list.
--     Claiming copies the invitation's rate to the member only when the member has none, then clears the
--     invitation's rate, label and phone, so the person's own name and shared fields take over (ADR 0008 item 6).
--   * app.invite_to_talent_pool, app.reissue_pool_invitation, app.revoke_pool_invitation, app.set_pool_member_rate.
--   * app.my_pending_invitations and app.respond_party_invitation are recreated from 2636 (their latest definition on
--     this base; R10's 2731 is not merged here) with a pool arm. Accepting refuses invitation_closed when the person
--     is flagged Do Not Engage by the org, the same refusal as an answered invitation, so the flag never shows.
--   * private.party_org_ids is recreated from 2641 (its latest definition on this base; A127's 2200 and R11's 2742
--     are not merged here) with the two relationships a person began with an org: a pool invitation they claimed and
--     their own crew registration (6522) that is not Withdrawn. Raw pool membership is never added: an internally added
--     member, or a Do Not Engage row, gains the person nothing (the 1464 supplier diversity list and the notice org
--     pick of 1463 and 1560 read this set).
--   * Audit redaction works by key, so answer, invitee_name, work_phone and signed_name join private.personal_data_keys.
--   * Account deletion (1112, 1670) learns the new relationships: private.person_related_org_ids and
--     private.account_deletion_tables are recreated, and t60_close_crew_registrations withdraws the person's registrations
--     and hard deletes their answers, claimed invitations, standing rates and the unanswered or declined invitations for
--     their sign-in address.

-- Invitations --------------------------------------------------------------------------------------------------------

create table app.talent_pool_invitations (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  talent_pool_id uuid not null references app.talent_pools (id),
  email text not null,
  invitee_name text,
  work_phone text,
  role_code text references xpms.role (role_code),
  rate_type app.rate_type,
  rate_minor bigint,
  currency_code char(3) references private.currencies (currency_code),
  note text,
  invited_by uuid not null references app.people (id),
  expires_at timestamptz not null default now() + interval '30 days',
  claimed_at timestamptz,
  claimed_person_id uuid references app.people (id),
  declined_at timestamptz,
  revoked_at timestamptz,
  deleted_at timestamptz,
  constraint talent_pool_invitations_email check (email = lower(btrim(email)) and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' and char_length(email) <= 320),
  constraint talent_pool_invitations_invitee_name check (invitee_name is null or char_length(btrim(invitee_name)) between 1 and 200),
  constraint talent_pool_invitations_work_phone check (work_phone is null or work_phone ~ '^\+[1-9][0-9]{6,14}$'),
  constraint talent_pool_invitations_note check (note is null or char_length(btrim(note)) between 1 and 1000),
  constraint talent_pool_invitations_rate check (
    (rate_minor is null) = (rate_type is null) and (rate_minor is null) = (currency_code is null)
    and (rate_type is null or rate_type in ('Hourly', 'Day', 'Flat'))
    and (rate_minor is null or rate_minor between 0 and 1000000000000)),
  constraint talent_pool_invitations_claimed_pair check ((claimed_at is null) = (claimed_person_id is null)),
  constraint talent_pool_invitations_one_outcome check (num_nonnulls(claimed_at, declined_at, revoked_at) <= 1)
);

create index talent_pool_invitations_pool_idx on app.talent_pool_invitations (talent_pool_id);
create index talent_pool_invitations_email_idx on app.talent_pool_invitations (email);
create index talent_pool_invitations_role_code_idx on app.talent_pool_invitations (role_code);
create index talent_pool_invitations_currency_code_idx on app.talent_pool_invitations (currency_code);
create index talent_pool_invitations_invited_by_idx on app.talent_pool_invitations (invited_by);
create index talent_pool_invitations_claimed_person_id_idx on app.talent_pool_invitations (claimed_person_id);
create unique index talent_pool_invitations_pending_key on app.talent_pool_invitations (talent_pool_id, email)
  where claimed_at is null and declined_at is null and revoked_at is null and deleted_at is null;

call private.install_domain_table('app.talent_pool_invitations', 'app.talent_pools', 'talent_pool_id');
call private.describe('app.talent_pool_invitations', 'An email address invited into one of the org''s Talent pools (B10, ADR 0149 decision 5). Claimed by the invitee signing in to Gateway with that confirmed email; no token travels and no person or profile is ever created for them. Written only by the pool invitation RPCs and the import worker; one pending invitation per pool and email, expired ones included.', array[
  'org_id', 'Owning org, derived from the pool.',
  'talent_pool_id', 'Talent pool the invitee joins. Internal: never named to the invitee.',
  'email', 'Invited address, lowercased. Never put in a URL.',
  'invitee_name', 'The org''s own label for the invitee, up to 200 characters; never copied to the person and cleared when they claim. Confidential.',
  'work_phone', 'Work phone the org holds for the invitee, E.164; cleared when they claim. Confidential.',
  'role_code', 'Role the invitee is invited for (Roles Library).',
  'rate_type', 'Standing rate basis: Hourly, Day or Flat. Informational only; XOS pays no one.',
  'rate_minor', 'Standing rate in minor units of currency_code. Restricted (data.restricted.read.payroll): never directly selectable; read through app.talent_pool_invitation_list. Cleared when the invitee claims.',
  'currency_code', 'Currency of the standing rate.',
  'note', 'Internal note about the invitation, up to 1000 characters. Confidential.',
  'invited_by', 'Person who invited, or who created the import that did.',
  'expires_at', 'When the invitation lapses unanswered; a reissue moves it later and sends the email again.',
  'claimed_at', 'When the invitee accepted.',
  'claimed_person_id', 'Person who accepted, signed in with the invited address.',
  'declined_at', 'When the invitee declined.',
  'revoked_at', 'When the org revoked it.'
]);

insert into private.column_classifications (table_name, column_name, classification, read_capability) values
  ('app.talent_pool_invitations', 'rate_minor', 'Restricted', 'data.restricted.read.payroll'),
  ('app.talent_pool_invitations', 'note', 'Confidential', null),
  ('app.talent_pool_invitations', 'invitee_name', 'Confidential', null),
  ('app.talent_pool_invitations', 'work_phone', 'Confidential', null);

call private.install_policies('app.talent_pool_invitations',
  $$org_id in (select private.orgs_with_capability('opportunities.pool.write'))$$);

-- The Restricted rate is never selectable directly (Section 8.3, ADR 0016 item 10); writes go through the RPCs.
revoke select, insert, update on app.talent_pool_invitations from authenticated;
grant select (id, org_id, talent_pool_id, email, invitee_name, work_phone, role_code, rate_type, currency_code, note,
  invited_by, expires_at, claimed_at, claimed_person_id, declined_at, revoked_at, deleted_at, created_at, created_by,
  updated_at, updated_by) on app.talent_pool_invitations to authenticated;

call private.install_default_retention('app.talent_pool_invitations');
call private.install_audit_trail('app.talent_pool_invitations');

insert into private.trash_excluded_tables (table_name, rationale) values
  ('talent_pool_invitations', 'An invitation is access: a revoked or lapsed pool invitation is sent again, never restored from Trash.')
on conflict (table_name) do nothing;

create or replace function private.guard_talent_pool_invitation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    if new.talent_pool_id is distinct from old.talent_pool_id or new.email is distinct from old.email
       or new.invited_by is distinct from old.invited_by then
      perform private.refuse('pool_invitation_fixed', 'An invitation keeps its pool, address and inviter; revoke it and invite again.');
    end if;
    return new;
  end if;
  if not exists (select 1 from app.talent_pools p
                 where p.id = new.talent_pool_id and p.deleted_at is null and p.pool_kind = 'Talent') then
    perform private.refuse('pool_invitation_pool', 'Invite people into a live Talent pool of the org.');
  end if;
  if new.claimed_at is not null or new.declined_at is not null or new.revoked_at is not null then
    perform private.refuse('pool_invitation_answered', 'A new invitation starts pending.');
  end if;
  return new;
end;
$$;

comment on function private.guard_talent_pool_invitation() is 'Pool invitations go into a live Talent pool, start pending, and keep their pool, address and inviter.';
revoke all on function private.guard_talent_pool_invitation() from public, anon, authenticated;

create trigger t40_guard_talent_pool_invitation before insert or update on app.talent_pool_invitations
  for each row execute function private.guard_talent_pool_invitation();

-- Pending invitations are unique per pool and email: a second one refuses with the rule, not a bare unique violation.
create or replace function private.refuse_duplicate_pool_invitation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (select 1 from app.talent_pool_invitations i
             where i.talent_pool_id = new.talent_pool_id and i.email = new.email and i.id <> new.id
               and i.claimed_at is null and i.declined_at is null and i.revoked_at is null and i.deleted_at is null) then
    perform private.refuse('pool_invitation_duplicate', 'This address already has a pending invitation to the pool. Reissue it instead.');
  end if;
  if exists (select 1 from app.talent_pool_invitations i
             where i.talent_pool_id = new.talent_pool_id and i.email = new.email and i.deleted_at is null
               and i.declined_at > now() - interval '12 months') then
    perform private.refuse('pool_invitation_declined', 'This address declined an invitation in the last 12 months, so it is not invited again.');
  end if;
  return new;
end;
$$;

comment on function private.refuse_duplicate_pool_invitation() is 'Refuses a second pending invitation of the same address to the same pool, expired ones included (pool_invitation_duplicate), and a new one for an address that declined in the last 12 months (pool_invitation_declined).';
revoke all on function private.refuse_duplicate_pool_invitation() from public, anon, authenticated;

create trigger t41_refuse_duplicate_pool_invitation before insert on app.talent_pool_invitations
  for each row execute function private.refuse_duplicate_pool_invitation();

-- One email per invitation and per reissue, on every path: the RPCs and the import worker.
create or replace function private.queue_pool_invitation_email()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and not (new.expires_at > old.expires_at and new.claimed_at is null and new.declined_at is null
                                and new.revoked_at is null and new.deleted_at is null) then
    return null;
  end if;
  -- A whole file can turn into email here, so an org's daily volume is capped on every path.
  if private.rate_limit_exceeded('pool_invitation_email', new.org_id::text, 2000, interval '24 hours') then
    perform private.refuse('pool_invitation_daily_limit', 'This organization reached 2000 invitation emails in 24 hours. Try again tomorrow.');
  end if;
  perform private.note_rate_event('pool_invitation_email', new.org_id::text);
  perform private.queue_party_invitation_email('pool', new.email, (
    select jsonb_build_object(
      'org_name', o.name,
      'job_title', xr.job_title,
      'inviter_name', ip.full_name,
      'expires_at', new.expires_at)
    from app.organizations o
    left join xpms.role xr on xr.role_code = new.role_code
    left join app.people ip on ip.id = new.invited_by
    where o.id = new.org_id), null);
  return null;
end;
$$;

comment on function private.queue_pool_invitation_email() is 'Queues one party_invitation email of kind pool for a new invitation, and again when a reissue moves its expiry later while it is pending: the org, the role and the inviter, never the pool. Refuses pool_invitation_daily_limit past 2000 emails an org in 24 hours.';
revoke all on function private.queue_pool_invitation_email() from public, anon, authenticated;

create trigger t85_queue_pool_invitation_email after insert or update of expires_at on app.talent_pool_invitations
  for each row execute function private.queue_pool_invitation_email();

-- Standing rates of pool members ----------------------------------------------------------------------------------------

create table app.pool_member_rates (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  pool_member_id uuid not null references app.pool_members (id),
  rate_type app.rate_type not null,
  rate_minor bigint not null,
  currency_code char(3) not null references private.currencies (currency_code),
  deleted_at timestamptz,
  constraint pool_member_rates_rate_type check (rate_type in ('Hourly', 'Day', 'Flat')),
  constraint pool_member_rates_rate_minor check (rate_minor between 0 and 1000000000000)
);

create unique index pool_member_rates_member_key on app.pool_member_rates (pool_member_id) where deleted_at is null;
create index pool_member_rates_currency_code_idx on app.pool_member_rates (currency_code);

call private.install_domain_table('app.pool_member_rates', 'app.pool_members', 'pool_member_id');
call private.describe('app.pool_member_rates', 'A pool member''s standing rate (B10): one live row per member, informational only, since XOS never pays anyone (S14.9-10). Set from a claimed pool invitation when the member has none, or by a pool manager who holds the payroll capability.', array[
  'org_id', 'Owning org, derived from the pool member.',
  'pool_member_id', 'Pool member.',
  'rate_type', 'Hourly, Day or Flat.',
  'rate_minor', 'Rate in minor units of currency_code. Restricted (data.restricted.read.payroll): read through app.pool_member_rate_list.',
  'currency_code', 'Currency of the rate.'
]);

insert into private.column_classifications (table_name, column_name, classification, read_capability) values
  ('app.pool_member_rates', 'rate_minor', 'Restricted', 'data.restricted.read.payroll');

call private.install_policies('app.pool_member_rates',
  $$org_id in (select private.orgs_with_capability('opportunities.application.read'))$$);
revoke select, insert, update on app.pool_member_rates from authenticated;
grant select (id, org_id, pool_member_id, rate_type, currency_code, deleted_at, created_at, created_by, updated_at, updated_by)
  on app.pool_member_rates to authenticated;

call private.install_default_retention('app.pool_member_rates');
call private.install_audit_trail('app.pool_member_rates');

insert into private.trash_excluded_tables (table_name, rationale) values
  ('pool_member_rates', 'A pool member''s standing rate (B10), replaced in place by its RPC; it has no title of its own.')
on conflict (table_name) do nothing;

-- Masked reads -------------------------------------------------------------------------------------------------------
-- Security definer views (owner reads) with their own row filter, as app.engagement_resolved (0700): the rate is
-- NULL and is_masked true without data.restricted.read.payroll in the org.

create view app.talent_pool_invitation_list as
select i.id, i.org_id, i.talent_pool_id, tp.name as pool_name, i.email, i.invitee_name, i.work_phone, i.role_code,
  xr.job_title, i.rate_type,
  case when private.has_capability(i.org_id, 'data.restricted.read.payroll') then i.rate_minor end as rate_minor,
  i.currency_code,
  not private.has_capability(i.org_id, 'data.restricted.read.payroll') as is_masked,
  i.note, i.invited_by, ip.full_name as inviter_name, i.created_at, i.expires_at, i.claimed_at, i.claimed_person_id,
  i.declined_at, i.revoked_at,
  case when i.claimed_at is not null then 'Claimed'
       when i.declined_at is not null then 'Declined'
       when i.revoked_at is not null then 'Revoked'
       when i.expires_at <= now() then 'Expired'
       else 'Pending' end as invitation_status
from app.talent_pool_invitations i
join app.talent_pools tp on tp.id = i.talent_pool_id
left join xpms.role xr on xr.role_code = i.role_code
left join app.people ip on ip.id = i.invited_by
where i.deleted_at is null
  and i.org_id in (select private.orgs_with_capability('opportunities.pool.write'));

call private.describe('app.talent_pool_invitation_list', 'Pool invitations as the Pools page reads them (B10): the pool, the role and its job title, the inviter and the status, with the Restricted standing rate masked (NULL, is_masked true) without data.restricted.read.payroll in the org. Rows follow the invitation read rule: opportunities.pool.write org-wide, because these are the contact details of people who never joined.', array[
  'id', 'Invitation.',
  'org_id', 'Org.',
  'talent_pool_id', 'Talent pool.',
  'pool_name', 'Pool name.',
  'email', 'Invited address.',
  'invitee_name', 'The org''s label for the invitee.',
  'work_phone', 'Work phone, E.164.',
  'role_code', 'Role.',
  'job_title', 'Job title of the role.',
  'rate_type', 'Standing rate basis.',
  'rate_minor', 'Standing rate in minor units; NULL when masked or not set.',
  'currency_code', 'Currency of the rate.',
  'is_masked', 'True when the rate is withheld from the caller.',
  'note', 'Internal note.',
  'invited_by', 'Who invited.',
  'inviter_name', 'Name of who invited.',
  'created_at', 'When it was sent first.',
  'expires_at', 'When it lapses.',
  'claimed_at', 'When it was claimed.',
  'claimed_person_id', 'Who claimed it.',
  'declined_at', 'When it was declined.',
  'revoked_at', 'When it was revoked.',
  'invitation_status', 'Pending, Expired, Claimed, Declined or Revoked.'
]);

revoke all on app.talent_pool_invitation_list from public, anon;
revoke select on app.talent_pool_invitation_list from xos_backup;
grant select on app.talent_pool_invitation_list to authenticated, service_role;

create view app.pool_member_rate_list as
select r.pool_member_id, r.org_id, pm.talent_pool_id, r.rate_type,
  case when private.has_capability(r.org_id, 'data.restricted.read.payroll') then r.rate_minor end as rate_minor,
  r.currency_code,
  not private.has_capability(r.org_id, 'data.restricted.read.payroll') as is_masked
from app.pool_member_rates r
join app.pool_members pm on pm.id = r.pool_member_id and pm.deleted_at is null
where r.deleted_at is null
  and r.org_id in (select private.orgs_with_capability('opportunities.application.read'));

call private.describe('app.pool_member_rate_list', 'Pool members'' standing rates (B10), with the Restricted rate masked (NULL, is_masked true) without data.restricted.read.payroll in the org. Rows follow the pool read rule.', array[
  'pool_member_id', 'Pool member.',
  'org_id', 'Org.',
  'talent_pool_id', 'Pool.',
  'rate_type', 'Hourly, Day or Flat.',
  'rate_minor', 'Rate in minor units; NULL when masked.',
  'currency_code', 'Currency.',
  'is_masked', 'True when the rate is withheld from the caller.'
]);

revoke all on app.pool_member_rate_list from public, anon;
revoke select on app.pool_member_rate_list from xos_backup;
grant select on app.pool_member_rate_list to authenticated, service_role;

-- Member names: a member who joined by registration or claim has no engagement or application to read a name through.
create view app.pool_member_names as
select m.id as pool_member_id, m.talent_pool_id, m.org_id, pe.full_name
from app.pool_members m
left join app.people pe on pe.id = m.person_id
where m.deleted_at is null
  and m.org_id in (select private.orgs_with_capability('opportunities.application.read'));

call private.describe('app.pool_member_names', 'Names of pool members as the Pools page reads them (B10), under the pool read rule: opportunities.application.read org-wide. A deleted person has a blank name.', array[
  'pool_member_id', 'Pool member.',
  'talent_pool_id', 'Pool.',
  'org_id', 'Org.',
  'full_name', 'Name from its one home on app.people; NULL once the person deleted their account.'
]);

revoke all on app.pool_member_names from public, anon;
revoke select on app.pool_member_names from xos_backup;
grant select on app.pool_member_names to authenticated, service_role;

-- Inviting ---------------------------------------------------------------------------------------------------------------

create or replace function private.assert_pool_rate(
  p_org_id uuid,
  p_rate_type app.rate_type,
  p_rate_minor bigint,
  p_currency_code text
)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_rate_type is null and p_rate_minor is null and p_currency_code is null then
    return;
  end if;
  if not private.has_capability(p_org_id, 'data.restricted.read.payroll') then
    perform private.refuse('pool_rate_not_permitted', 'Setting a standing rate needs data.restricted.read.payroll in the org.');
  end if;
  if p_rate_type is null or p_rate_minor is null or p_currency_code is null
     or p_rate_type not in ('Hourly', 'Day', 'Flat') or p_rate_minor < 0 or p_rate_minor > 1000000000000
     or not exists (select 1 from private.currencies c where c.currency_code = upper(p_currency_code)) then
    perform private.refuse('pool_rate_invalid', 'A standing rate is Hourly, Day or Flat, an amount of zero or more and a currency.');
  end if;
end;
$$;

comment on function private.assert_pool_rate(uuid, app.rate_type, bigint, text) is 'A standing rate is all or nothing: Hourly, Day or Flat, a non-negative amount and a known currency (pool_rate_invalid), and setting one needs data.restricted.read.payroll in the org (pool_rate_not_permitted).';
revoke all on function private.assert_pool_rate(uuid, app.rate_type, bigint, text) from public, anon, authenticated;

create or replace function app.invite_to_talent_pool(
  p_pool_id uuid,
  p_email text,
  p_invitee_name text default null,
  p_work_phone text default null,
  p_role_code text default null,
  p_rate_type app.rate_type default null,
  p_rate_minor bigint default null,
  p_currency_code text default null,
  p_note text default null,
  p_valid_for interval default interval '30 days'
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_me uuid := private.require_person();
  v_pool app.talent_pools;
  v_email text;
  v_id uuid;
begin
  select * into v_pool from app.talent_pools p where p.id = p_pool_id and p.deleted_at is null;
  if v_pool.id is null or not private.has_capability(v_pool.org_id, 'opportunities.pool.write') then
    raise exception using errcode = '42501', message = 'opportunities.pool.write is required in the org';
  end if;
  v_email := private.normalized_invitation_email(p_email);
  perform private.assert_invitation_validity(p_valid_for);
  perform private.assert_pool_rate(v_pool.org_id, p_rate_type, p_rate_minor, p_currency_code);
  if p_work_phone is not null and p_work_phone !~ '^\+[1-9][0-9]{6,14}$' then
    perform private.refuse('pool_invitation_phone', 'Enter the work phone in international format, for example +13105550100.');
  end if;
  insert into app.talent_pool_invitations (talent_pool_id, email, invitee_name, work_phone, role_code, rate_type, rate_minor,
    currency_code, note, invited_by, expires_at)
  values (v_pool.id, v_email, nullif(btrim(p_invitee_name), ''), p_work_phone, p_role_code, p_rate_type, p_rate_minor,
    upper(p_currency_code), nullif(btrim(p_note), ''), v_me, now() + p_valid_for)
  returning id into v_id;
  return v_id;
end;
$$;

comment on function app.invite_to_talent_pool(uuid, text, text, text, text, app.rate_type, bigint, text, text, interval) is 'A pool manager (opportunities.pool.write in the org; 42501 otherwise) invites an email address into a live Talent pool, open for 1 hour to 30 days (30 by default), with an optional label, work phone, role, informational standing rate and note; one email is queued. A rate needs data.restricted.read.payroll (pool_rate_not_permitted). Refuses invitation_email, invite_expiry_range, pool_invitation_pool, pool_invitation_phone, pool_invitation_duplicate, pool_invitation_declined and pool_invitation_daily_limit. Returns the invitation id.';

create or replace function app.reissue_pool_invitation(p_invitation_id uuid, p_valid_for interval default interval '30 days')
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_invitation app.talent_pool_invitations;
begin
  perform private.require_person();
  select * into v_invitation from app.talent_pool_invitations i where i.id = p_invitation_id and i.deleted_at is null for update;
  if v_invitation.id is null or not private.has_capability(v_invitation.org_id, 'opportunities.pool.write') then
    raise exception using errcode = '42501', message = 'pool invitation not found';
  end if;
  if v_invitation.claimed_at is not null or v_invitation.declined_at is not null or v_invitation.revoked_at is not null then
    perform private.refuse('invitation_closed', 'This invitation was answered or revoked. Invite the address again instead.');
  end if;
  perform private.assert_invitation_validity(p_valid_for);
  -- The expiry only moves later, so the email trigger sends it again.
  update app.talent_pool_invitations set expires_at = greatest(now() + p_valid_for, v_invitation.expires_at + interval '1 second')
  where id = v_invitation.id;
  return v_invitation.id;
end;
$$;

comment on function app.reissue_pool_invitation(uuid, interval) is 'A pool manager sends a pending or expired pool invitation again: its expiry moves to 1 hour to 30 days from now and one new email is queued. Refuses invitation_closed once it is claimed, declined or revoked. Returns the invitation id.';

create or replace function app.revoke_pool_invitation(p_invitation_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_invitation app.talent_pool_invitations;
begin
  perform private.require_person();
  select * into v_invitation from app.talent_pool_invitations i where i.id = p_invitation_id and i.deleted_at is null for update;
  if v_invitation.id is null or not private.has_capability(v_invitation.org_id, 'opportunities.pool.write') then
    raise exception using errcode = '42501', message = 'pool invitation not found';
  end if;
  if v_invitation.claimed_at is not null or v_invitation.declined_at is not null then
    perform private.refuse('invitation_closed', 'This invitation was already answered.');
  end if;
  update app.talent_pool_invitations set revoked_at = coalesce(revoked_at, now()) where id = v_invitation.id;
end;
$$;

comment on function app.revoke_pool_invitation(uuid) is 'A pool manager revokes a pending pool invitation; revoking twice keeps the first time. Refuses invitation_closed once it is answered.';

create or replace function app.set_pool_member_rate(
  p_pool_member_id uuid,
  p_rate_type app.rate_type,
  p_rate_minor bigint,
  p_currency_code text
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_member app.pool_members;
begin
  perform private.require_person();
  select * into v_member from app.pool_members m where m.id = p_pool_member_id and m.deleted_at is null;
  if v_member.id is null or not private.has_capability(v_member.org_id, 'opportunities.pool.write') then
    raise exception using errcode = '42501', message = 'opportunities.pool.write is required in the org';
  end if;
  if p_rate_type is null and p_rate_minor is null and p_currency_code is null then
    if not private.has_capability(v_member.org_id, 'data.restricted.read.payroll') then
      perform private.refuse('pool_rate_not_permitted', 'Clearing a standing rate needs data.restricted.read.payroll in the org.');
    end if;
    update app.pool_member_rates set deleted_at = now() where pool_member_id = v_member.id and deleted_at is null;
    return;
  end if;
  perform private.assert_pool_rate(v_member.org_id, p_rate_type, p_rate_minor, p_currency_code);
  update app.pool_member_rates set rate_type = p_rate_type, rate_minor = p_rate_minor, currency_code = upper(p_currency_code)
  where pool_member_id = v_member.id and deleted_at is null;
  if not found then
    insert into app.pool_member_rates (pool_member_id, rate_type, rate_minor, currency_code)
    values (v_member.id, p_rate_type, p_rate_minor, upper(p_currency_code));
  end if;
end;
$$;

comment on function app.set_pool_member_rate(uuid, app.rate_type, bigint, text) is 'A pool manager who holds data.restricted.read.payroll sets or, with every argument NULL, clears a pool member''s informational standing rate. Refuses pool_rate_not_permitted and pool_rate_invalid.';

-- Answering (from 2636) ---------------------------------------------------------------------------------------------------

create or replace function app.my_pending_invitations()
returns table (
  invitation_kind text,
  invitation_id uuid,
  account_name text,
  org_name text,
  project_name text,
  party_name text,
  job_title text,
  account_role app.account_role,
  inviter_name text,
  expires_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  with me as (select private.my_confirmed_email() as email)
  select 'account', i.id, o.name, null::text, null::text, null::text, null::text, i.account_role, ip.full_name, i.expires_at
  from app.account_invitations i
  join me on me.email = i.email
  join app.organizations o on o.id = i.org_id
  join app.people ip on ip.id = i.invited_by
  where i.deleted_at is null and i.accepted_at is null and i.declined_at is null and i.revoked_at is null and i.expires_at > now()
  union all
  select 'roster', i.id, a.name, o.name, p.name, coalesce(a.name, ep.full_name), xr.job_title, null::app.account_role,
    coalesce(ip.full_name, a.name, ep.full_name), i.expires_at
  from app.roster_invitations i
  join me on me.email = i.email
  join app.engagement_roster_entries r on r.id = i.roster_entry_id and r.deleted_at is null and r.entry_state <> 'Withdrawn'
  join app.engagements e on e.id = r.engagement_id and e.deleted_at is null
  join app.organizations o on o.id = e.org_id
  join app.projects p on p.id = e.project_id
  left join app.people ip on ip.id = i.invited_by
  left join app.counterparties c on c.id = e.counterparty_id
  left join app.organizations a on a.id = c.organization_id
  left join app.people ep on ep.id = e.person_id
  left join xpms.role xr on xr.role_code = r.role_code
  where i.deleted_at is null and i.claimed_at is null and i.declined_at is null and i.revoked_at is null and i.expires_at > now()
  union all
  -- A pool invitation names the org and the role, never the pool (B10).
  select 'pool', i.id, null::text, o.name, null::text, null::text, xr.job_title, null::app.account_role, ip.full_name,
    i.expires_at
  from app.talent_pool_invitations i
  join me on me.email = i.email
  join app.talent_pools tp on tp.id = i.talent_pool_id and tp.deleted_at is null
  join app.organizations o on o.id = i.org_id
  join app.people ip on ip.id = i.invited_by
  left join xpms.role xr on xr.role_code = i.role_code
  where i.deleted_at is null and i.claimed_at is null and i.declined_at is null and i.revoked_at is null and i.expires_at > now()
  order by 10, 2;
$$;

comment on function app.my_pending_invitations() is 'The signed-in person''s pending, unexpired account, roster and pool invitations, matched by their confirmed email (lowercased; empty until the email is confirmed): the account, the producing org, project, party and role for a roster, the role offered for an account, the org and the role for a pool (never the pool), who invited and when it lapses.';

create or replace function app.respond_party_invitation(p_invitation_kind text, p_invitation_id uuid, p_accept boolean)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_me uuid := private.require_person();
  v_email text := private.my_confirmed_email();
  v_account app.account_invitations;
  v_roster app.roster_invitations;
  v_pool app.talent_pool_invitations;
  v_entry app.engagement_roster_entries;
  v_engagement app.engagements;
  v_counterparty_account uuid;
  v_membership uuid;
  v_member uuid;
begin
  if p_invitation_kind = 'account' then
    select * into v_account from app.account_invitations i where i.id = p_invitation_id and i.deleted_at is null for update;
    if v_account.id is null or v_email is null or v_account.email <> v_email then
      perform private.refuse('invitation_not_yours', 'This invitation was sent to another address. Sign in with the address it was sent to.');
    end if;
    if v_account.accepted_at is not null or v_account.declined_at is not null or v_account.revoked_at is not null
       or v_account.expires_at <= now() then
      perform private.refuse('invitation_closed', 'This invitation was answered, revoked or has expired.');
    end if;
    if not p_accept then
      update app.account_invitations set declined_at = now() where id = v_account.id;
      return null;
    end if;
    v_membership := private.ensure_accepted_membership(v_account.org_id, v_me, v_account.account_role, v_account.invited_by);
    update app.account_invitations set accepted_at = now(), accepted_person_id = v_me where id = v_account.id;
    return v_membership;
  elsif p_invitation_kind = 'roster' then
    select * into v_roster from app.roster_invitations i where i.id = p_invitation_id and i.deleted_at is null for update;
    if v_roster.id is null or v_email is null or v_roster.email <> v_email then
      perform private.refuse('invitation_not_yours', 'This invitation was sent to another address. Sign in with the address it was sent to.');
    end if;
    select * into v_entry from app.engagement_roster_entries r where r.id = v_roster.roster_entry_id and r.deleted_at is null for update;
    if v_roster.claimed_at is not null or v_roster.declined_at is not null or v_roster.revoked_at is not null
       or v_roster.expires_at <= now() or v_entry.id is null or v_entry.entry_state = 'Withdrawn' or v_entry.person_id is not null then
      perform private.refuse('invitation_closed', 'This invitation was answered, revoked or has expired.');
    end if;
    if not p_accept then
      update app.roster_invitations set declined_at = now() where id = v_roster.id;
      if v_entry.entry_state = 'Draft' then
        perform private.transition_lifecycle('roster_entry', 'app.engagement_roster_entries', 'entry_state',
          'app.roster_entry_state_transitions', 'roster_entry_id', v_entry.id, 'Draft', 'Withdrawn', 'Invitation declined.');
      end if;
      return v_entry.id;
    end if;
    select * into v_engagement from app.engagements e where e.id = v_entry.engagement_id and e.deleted_at is null;
    if v_engagement.person_id = v_me then
      perform private.refuse('roster_person_is_engaged', 'You are on this engagement''s roster through your own entry.');
    end if;
    select c.organization_id into v_counterparty_account from app.counterparties c where c.id = v_engagement.counterparty_id;
    if v_counterparty_account is not null then
      -- R10: an invitation sent through an advance link is granted by the person who claimed the link.
      perform private.ensure_accepted_membership(v_counterparty_account, v_me, 'Account Member', coalesce(v_roster.invited_by, (
        select t.claimed_by from app.advance_recipient_tokens t where t.id = v_roster.advance_recipient_token_id)));
    end if;
    perform private.begin_trusted_operation('roster_invitation_claim');
    begin
      update app.engagement_roster_entries set person_id = v_me, person_response = 'Accepted', responded_at = now()
      where id = v_entry.id;
    exception when unique_violation then
      perform private.refuse('roster_person_duplicate', 'You are already on this engagement''s roster.');
    end;
    perform private.end_trusted_operation('roster_invitation_claim');
    update app.roster_invitations set claimed_at = now(), claimed_person_id = v_me where id = v_roster.id;
    perform private.sync_account_roster_consent(v_counterparty_account, v_me);
    return v_entry.id;
  elsif p_invitation_kind = 'pool' then
    select * into v_pool from app.talent_pool_invitations i where i.id = p_invitation_id and i.deleted_at is null for update;
    if v_pool.id is null or v_email is null or v_pool.email <> v_email then
      perform private.refuse('invitation_not_yours', 'This invitation was sent to another address. Sign in with the address it was sent to.');
    end if;
    -- A Do Not Engage flag and the org's billing state read as a closed invitation, so neither shows (0720).
    if v_pool.claimed_at is not null or v_pool.declined_at is not null or v_pool.revoked_at is not null
       or v_pool.expires_at <= now()
       or private.org_read_only(v_pool.org_id)
       or not exists (select 1 from app.talent_pools tp where tp.id = v_pool.talent_pool_id and tp.deleted_at is null)
       or (p_accept and private.excluded_from_org(v_pool.org_id, v_me)) then
      perform private.refuse('invitation_closed', 'This invitation was answered, revoked or has expired.');
    end if;
    if not p_accept then
      update app.talent_pool_invitations set declined_at = now() where id = v_pool.id;
      return null;
    end if;
    select m.id into v_member from app.pool_members m
    where m.talent_pool_id = v_pool.talent_pool_id and m.person_id = v_me and m.deleted_at is null
    for update;
    if v_member is null then
      insert into app.pool_members (talent_pool_id, person_id, standing)
      values (v_pool.talent_pool_id, v_me, 'Approved')
      returning id into v_member;
    end if;
    -- An existing standing and rate are kept; the invitation's rate only fills a member without one.
    if v_pool.rate_minor is not null
       and not exists (select 1 from app.pool_member_rates r where r.pool_member_id = v_member and r.deleted_at is null) then
      insert into app.pool_member_rates (pool_member_id, rate_type, rate_minor, currency_code)
      values (v_member, v_pool.rate_type, v_pool.rate_minor, v_pool.currency_code);
    end if;
    -- The person's own name and shared fields take over: the org's label, phone and rate copy leave the invitation.
    update app.talent_pool_invitations
    set claimed_at = now(), claimed_person_id = v_me, invitee_name = null, work_phone = null,
      rate_type = null, rate_minor = null, currency_code = null
    where id = v_pool.id;
    return v_member;
  end if;
  perform private.refuse('invitation_kind', 'An invitation is an account, a roster or a pool invitation.');
  return null;
end;
$$;

comment on function app.respond_party_invitation(text, uuid, boolean) is 'The invitee, signed in with the confirmed address an invitation was sent to, accepts or declines it while it is pending and unexpired (invitation_not_yours, invitation_closed). Account: accepting confirms their membership with the offered role, creating it when needed, and returns the membership id. Roster: accepting claims the entry for them and accepts it, and on a company engagement also confirms them as an Account Member of the account (refusing roster_person_duplicate and roster_person_is_engaged); declining withdraws the Draft entry. Returns the entry id. Pool (B10): accepting makes them an Approved member of the pool unless they are one already (an existing standing and rate are kept), fills a missing standing rate from the invitation, then clears the invitation''s label, phone and rate, and returns the pool member id; a Do Not Engage flag and a read-only org refuse invitation_closed.';

-- Party orgs (from 2641) ------------------------------------------------------------------------------------------------

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
  select r.org_id from app.engagement_roster_entries r
  where r.person_id = p_person_id and r.deleted_at is null and r.entry_state <> 'Withdrawn'
  union
  select a.org_id from app.applications a
  join app.offers o on o.application_id = a.id and o.deleted_at is null and o.offer_state in ('Sent', 'Countered')
  where a.applicant_person_id = p_person_id and a.deleted_at is null
  union
  -- Relationships the person began (B10): a pool invitation they claimed and their own crew registration.
  select i.org_id from app.talent_pool_invitations i
  where i.claimed_person_id = p_person_id and i.deleted_at is null
  union
  select g.org_id from app.crew_registrations g
  where g.person_id = p_person_id and g.deleted_at is null and g.registration_state <> 'Withdrawn';
$$;

comment on function private.party_org_ids(uuid) is 'Orgs a person works with as an external party: through an engagement of their own, an active membership in an external account the org holds as a counterparty, a live roster entry on one of the org''s engagements (R4), a pool invitation they claimed, or a crew registration of their own that is not Withdrawn (B10). Pool membership alone never counts: an org adds people to its pools without their knowing.';
revoke all on function private.party_org_ids(uuid) from public, anon, authenticated;

-- Audit redaction and account deletion -------------------------------------------------------------------------------

insert into private.personal_data_keys (json_key) values
  ('answer'), ('invitee_name'), ('work_phone'), ('signed_name')
on conflict do nothing;

-- From 1112, with the two relationships a person can hold with no membership or engagement.
create or replace function private.person_related_org_ids(p_person_id uuid)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select m.org_id from app.memberships m where m.person_id = p_person_id and m.deleted_at is null
  union
  select a.org_id from app.account_memberships a where a.person_id = p_person_id and a.deleted_at is null
  union
  select e.org_id from app.engagements e where e.person_id = p_person_id and e.deleted_at is null
  union
  select g.org_id from app.crew_registrations g where g.person_id = p_person_id and g.deleted_at is null
  union
  select i.org_id from app.talent_pool_invitations i where i.claimed_person_id = p_person_id and i.deleted_at is null;
$$;

comment on function private.person_related_org_ids(uuid) is 'Orgs a person holds or held a membership, an external account membership, an engagement, a crew registration or a claimed pool invitation with (SIM-004 account deletion, B10).';
revoke all on function private.person_related_org_ids(uuid) from public, anon, authenticated;

-- From 1670.
create or replace function private.account_deletion_tables()
returns text[]
language sql
immutable
set search_path = ''
as $$
  select array[
    'app.people', 'app.person_profiles', 'app.person_links', 'app.person_languages', 'app.person_skills',
    'app.person_references', 'app.portfolio_items', 'app.profile_section_visibility', 'app.person_certifications',
    'app.certification_shares', 'app.availability_calendars', 'app.availability_blocks', 'app.saved_searches',
    'app.opportunity_alerts', 'app.saved_opportunities', 'app.favorites', 'app.personal_setting_values',
    'app.inbox_snoozes', 'app.record_watchers', 'app.thread_subscriptions', 'app.thread_reads',
    'app.comment_reactions', 'app.push_subscriptions', 'app.person_push_devices', 'app.push_tickets', 'app.oauth_grants',
    'app.memberships', 'app.account_memberships', 'app.engagements', 'app.dsar_requests', 'app.crew_registrations',
    'app.crew_registration_answers', 'app.crew_access_links', 'app.talent_pool_invitations', 'app.pool_member_rates']::text[];
$$;

comment on function private.account_deletion_tables() is 'The app tables an account deletion writes to (SIM-004), with the person''s own push devices and the tickets of every device it removes (A101), and their crew registrations, crew access links, pool invitations and standing rates (B10). An active legal hold naming one of them, or naming no table, blocks the deletion.';
revoke all on function private.account_deletion_tables() from public, anon, authenticated;

create or replace function private.close_crew_registrations()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_registration record;
  v_email text := (select lower(u.email) from auth.users u where u.id = new.user_id);
begin
  for v_registration in
    select g.id, g.registration_state::text as state from app.crew_registrations g
    where g.person_id = new.id and g.deleted_at is null and g.registration_state in ('Submitted', 'Approved')
  loop
    perform private.transition_lifecycle('crew_registration', 'app.crew_registrations', 'registration_state',
      'app.crew_registration_state_transitions', 'crew_registration_id', v_registration.id, v_registration.state, 'Withdrawn', 'Account deleted.');
  end loop;
  -- Their own words and what the org held about them go; a pool membership stays as an org record with a blank name.
  perform private.begin_trusted_operation('crew_registration_erase');
  delete from app.crew_registration_answers a using app.crew_registrations g
    where a.crew_registration_id = g.id and g.person_id = new.id;
  delete from app.talent_pool_invitations i
    where i.claimed_person_id = new.id
       or (i.email = v_email and i.claimed_at is null and i.revoked_at is null);
  delete from app.pool_member_rates r using app.pool_members m
    where r.pool_member_id = m.id and m.person_id = new.id;
  perform private.end_trusted_operation('crew_registration_erase');
  return null;
end;
$$;

comment on function private.close_crew_registrations() is 'After a person is deleted (account deletion, 1112): withdraws their Submitted and Approved crew registrations with the reason ''Account deleted.'', and hard deletes their answers, their claimed pool invitations, the unanswered or declined invitations for their sign-in address, and the standing rates of their pool members. Pool membership stays with a blank name.';
revoke all on function private.close_crew_registrations() from public, anon, authenticated;

create trigger t60_close_crew_registrations after update of deleted_at on app.people
  for each row when (old.deleted_at is null and new.deleted_at is not null)
  execute function private.close_crew_registrations();

-- Privileges -------------------------------------------------------------------------------------------------------------

revoke all on function app.invite_to_talent_pool(uuid, text, text, text, text, app.rate_type, bigint, text, text, interval) from public, anon;
revoke all on function app.reissue_pool_invitation(uuid, interval) from public, anon;
revoke all on function app.revoke_pool_invitation(uuid) from public, anon;
revoke all on function app.set_pool_member_rate(uuid, app.rate_type, bigint, text) from public, anon;
revoke all on function app.my_pending_invitations() from public, anon;
revoke all on function app.respond_party_invitation(text, uuid, boolean) from public, anon;
grant execute on function app.invite_to_talent_pool(uuid, text, text, text, text, app.rate_type, bigint, text, text, interval) to authenticated, service_role;
grant execute on function app.reissue_pool_invitation(uuid, interval) to authenticated, service_role;
grant execute on function app.revoke_pool_invitation(uuid) to authenticated, service_role;
grant execute on function app.set_pool_member_rate(uuid, app.rate_type, bigint, text) to authenticated, service_role;
grant execute on function app.my_pending_invitations() to authenticated, service_role;
grant execute on function app.respond_party_invitation(text, uuid, boolean) to authenticated, service_role;

select private.sync_trash_tables();

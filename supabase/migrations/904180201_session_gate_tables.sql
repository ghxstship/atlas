-- The session gate's tables (RRR-243; ADR 0169 work package 2, the gate core; release 4.18, block 02, part 1 of 4).
--
-- ADR 0169 moves five access controls an organization sets (a signed-out session, the second-factor requirement, the
-- session lifetime, the idle timeout and the IP allow-list) into the database, where a direct call to the data endpoint
-- cannot go around them. This migration creates what the gate keeps; 904180202 decides, 904180203 verifies the
-- server attestation and keeps the ungated helper twins, 904180204 reworks the functions the apps read.
--
-- Every control ships off (ADR 0169 D7, owner decision 1). The configuration row seeded here holds 'off' for all five
-- controls and the address source 'pass', no organization has a mode of its own, and no override exists, so nothing in
-- this block refuses or changes any request. The owner approves each switch to observe and then to enforce.
--
--   private.session_gate_config        one row: the mode of each control (off, observe, enforce) and the address source
--   private.session_gate_orgs          the mode of one control for one organization, which overrides the global mode
--   private.session_gate_overrides     support suspends one control for one organization, for at most 24 hours
--   private.session_gate_observations  what observe mode counted: calls enforce would have refused
--   private.session_state              one row per session: its recorded activity and its network pass
--   private.org_session_rules          one row per organization: the session rules it set, kept current by triggers
--
-- The controls are ended, mfa, lifetime, idle and network. The sixth control of ADR 0169 D1, app_mfa (an OAuth app
-- token refused where its authorizing session did not meet the second-factor rule), is not built: question 5 of the
-- staging probe is unanswered (infra/db/probes/0169-results-2026-11-21.md). When it is answered
-- names-authorizing-session, app_mfa attaches in three places: a mode column on private.session_gate_config, the value
-- in the three *_control check constraints below, and the 'app' branch of private.session_verdict_compute (904180202).
--
-- Locks: the two triggers on app.setting_values and the one on app.org_ip_allowlist are created under lock_timeout.
-- No existing table is rewritten.

set lock_timeout = '5s';

-- Configuration -----------------------------------------------------------------------------------------------------------

create table if not exists private.session_gate_config (
  singleton boolean primary key default true,
  ended text not null default 'off',
  mfa text not null default 'off',
  lifetime text not null default 'off',
  idle text not null default 'off',
  network text not null default 'off',
  address_source text not null default 'pass',
  org_modes boolean not null default false,
  suspensions boolean not null default false,
  updated_at timestamptz not null default now(),
  constraint session_gate_config_one_row check (singleton),
  constraint session_gate_config_ended_mode check (ended in ('off', 'observe', 'enforce')),
  constraint session_gate_config_mfa_mode check (mfa in ('off', 'observe', 'enforce')),
  constraint session_gate_config_lifetime_mode check (lifetime in ('off', 'observe', 'enforce')),
  constraint session_gate_config_idle_mode check (idle in ('off', 'observe', 'enforce')),
  constraint session_gate_config_network_mode check (network in ('off', 'observe', 'enforce')),
  constraint session_gate_config_address_source check (address_source in ('pass', 'edge'))
);

alter table private.session_gate_config enable row level security;
revoke all on private.session_gate_config from public, anon, authenticated;

comment on table private.session_gate_config is 'The session gate''s one configuration row (ADR 0169 D7): the mode of each control and the address source. Read on every evaluation, so a change takes effect on the next request with no deploy. Every control ships off; the owner approves each switch.';
comment on column private.session_gate_config.singleton is 'Always true: the table holds one row.';
comment on column private.session_gate_config.ended is 'Mode of the signed-out control (reason session_ended): off, observe or enforce.';
comment on column private.session_gate_config.mfa is 'Mode of the second-factor control (reason session_mfa_required): off, observe or enforce.';
comment on column private.session_gate_config.lifetime is 'Mode of the session lifetime control (reason session_expired): off, observe or enforce.';
comment on column private.session_gate_config.idle is 'Mode of the idle timeout control (reason session_idle): off, observe or enforce.';
comment on column private.session_gate_config.network is 'Mode of the IP allow-list control (reason network_restricted): off, observe or enforce.';
comment on column private.session_gate_config.address_source is 'Where a direct REST call''s address comes from (ADR 0169 D4): pass (the five-minute network pass) or edge (private.request_ip at xos.trusted_proxy_hops). Ships as pass; the owner approves the switch.';
comment on column private.session_gate_config.org_modes is 'True while private.session_gate_orgs holds a row. Kept by trigger, so an evaluation with every control off reads this one row and nothing else.';
comment on column private.session_gate_config.suspensions is 'True while private.session_gate_overrides holds a row that was not ended. Kept by trigger.';
comment on column private.session_gate_config.updated_at is 'When a mode or the address source last changed.';

insert into private.session_gate_config (singleton) values (true) on conflict (singleton) do nothing;

create or replace function private.guard_session_gate_config()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    new.updated_at := now();
    return new;
  end if;
  raise exception using errcode = 'XR001', hint = 'session_gate_config_kept',
    message = 'session_gate_config_kept: the session gate keeps its one configuration row; set a control to off instead.';
end;
$$;

comment on function private.guard_session_gate_config() is 'Trigger on private.session_gate_config: stamps updated_at on a change and refuses deleting or emptying the one row, so a missing row can never read as every control off by accident.';
revoke all on function private.guard_session_gate_config() from public, anon, authenticated;

drop trigger if exists t10_keep_config_row on private.session_gate_config;
create trigger t10_keep_config_row before update or delete on private.session_gate_config
  for each row execute function private.guard_session_gate_config();
drop trigger if exists t11_keep_config_row_truncate on private.session_gate_config;
create trigger t11_keep_config_row_truncate before truncate on private.session_gate_config
  for each statement execute function private.guard_session_gate_config();

-- One organization, one control -------------------------------------------------------------------------------------------

create table if not exists private.session_gate_orgs (
  org_id uuid not null references app.organizations (id) on delete cascade,
  control text not null,
  mode text not null,
  created_at timestamptz not null default now(),
  primary key (org_id, control),
  constraint session_gate_orgs_control check (control in ('ended', 'mfa', 'lifetime', 'idle', 'network')),
  constraint session_gate_orgs_mode check (mode in ('off', 'observe', 'enforce'))
);

alter table private.session_gate_orgs enable row level security;
revoke all on private.session_gate_orgs from public, anon, authenticated;

comment on table private.session_gate_orgs is 'The mode of one control for one organization (ADR 0169 D7). It overrides the global mode in private.session_gate_config in either direction, so enforcement starts with named organizations.';
comment on column private.session_gate_orgs.org_id is 'Organization the mode applies to.';
comment on column private.session_gate_orgs.control is 'Control: ended, mfa, lifetime, idle or network.';
comment on column private.session_gate_orgs.mode is 'Mode for this organization: off, observe or enforce.';
comment on column private.session_gate_orgs.created_at is 'When the row was written.';

-- Support overrides -------------------------------------------------------------------------------------------------------

create table if not exists private.session_gate_overrides (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id) on delete cascade,
  control text not null,
  actor text not null,
  reason text not null,
  starts_at timestamptz not null default now(),
  expires_at timestamptz not null,
  ended_at timestamptz,
  constraint session_gate_overrides_control check (control in ('ended', 'mfa', 'lifetime', 'idle', 'network')),
  constraint session_gate_overrides_actor_length check (char_length(btrim(actor)) between 3 and 200),
  constraint session_gate_overrides_reason_length check (char_length(btrim(reason)) between 20 and 1000),
  constraint session_gate_overrides_at_most_a_day check (expires_at > starts_at and expires_at <= starts_at + interval '24 hours')
);

create index if not exists session_gate_overrides_org_idx on private.session_gate_overrides (org_id, control);

alter table private.session_gate_overrides enable row level security;
revoke all on private.session_gate_overrides from public, anon, authenticated;

comment on table private.session_gate_overrides is 'Support suspends one control for one organization for at most 24 hours (ADR 0169 D8), for example when an allow-list locked every Owner out. While a row is in force the control reads as off for that organization. Every row and every early end is written to the audit ledger by trigger.';
comment on column private.session_gate_overrides.id is 'Override id.';
comment on column private.session_gate_overrides.org_id is 'Organization whose control is suspended.';
comment on column private.session_gate_overrides.control is 'Suspended control: ended, mfa, lifetime, idle or network.';
comment on column private.session_gate_overrides.actor is 'Who suspended it: the support operator, as text, because the writer holds the secret key and no session.';
comment on column private.session_gate_overrides.reason is 'Why, in at least 20 characters.';
comment on column private.session_gate_overrides.starts_at is 'When the suspension starts.';
comment on column private.session_gate_overrides.expires_at is 'When it ends by itself, at most 24 hours after it starts.';
comment on column private.session_gate_overrides.ended_at is 'When it was ended early, or NULL.';

-- Observations ------------------------------------------------------------------------------------------------------------

create table if not exists private.session_gate_observations (
  id uuid primary key default private.uuid_v7(),
  observed_on date not null,
  control text not null,
  surface text not null,
  org_id uuid references app.organizations (id) on delete cascade,
  token_type text not null,
  reason text not null,
  calls bigint not null default 0,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  constraint session_gate_observations_control check (control in ('ended', 'mfa', 'lifetime', 'idle', 'network')),
  constraint session_gate_observations_surface check (surface ~ '^[a-z][a-z0-9_]{1,39}$'),
  constraint session_gate_observations_token_type check (token_type in ('session', 'api_key', 'app')),
  constraint session_gate_observations_reason check (reason in ('session_ended', 'session_mfa_required', 'session_expired',
    'session_idle', 'network_restricted', 'edge_matches_pass', 'edge_differs_from_pass')),
  constraint session_gate_observations_calls check (calls >= 0)
);

create unique index if not exists session_gate_observations_key on private.session_gate_observations
  (observed_on, control, surface, org_id, token_type, reason) nulls not distinct;
create index if not exists session_gate_observations_org_idx on private.session_gate_observations (org_id);

alter table private.session_gate_observations enable row level security;
revoke all on private.session_gate_observations from public, anon, authenticated;

comment on table private.session_gate_observations is 'What observe mode counted (ADR 0169 D7): for each day, control, surface, organization, kind of token and reason, how many read-write calls enforce would have refused. It names no person, session or address. A call that arrives while another request is writing the same row is not counted (private.session_gate_observe never waits), so calls is a lower bound under concurrency; the xos_session_gate log line is written for every call and is the complete record. The two edge_* reasons count direct REST calls whose edge address agreed or disagreed with the session''s fresh network pass (ADR 0169 D4), the comparison that precedes switching the address source.';
comment on column private.session_gate_observations.id is 'Row id. The tenant purge of 1270 names a row by its primary key.';
comment on column private.session_gate_observations.observed_on is 'UTC day of the calls.';
comment on column private.session_gate_observations.control is 'Control that would have refused.';
comment on column private.session_gate_observations.surface is 'Where the verdict was asked: postgrest, storage, realtime or another lower-case name the asking package gives.';
comment on column private.session_gate_observations.org_id is 'Organization that would have refused, or NULL for a session refused as a whole and for the address comparison.';
comment on column private.session_gate_observations.token_type is 'Kind of token: session, api_key or app.';
comment on column private.session_gate_observations.reason is 'The refusal reason enforce would have given, or the outcome of the address comparison.';
comment on column private.session_gate_observations.calls is 'Number of read-write calls counted: a lower bound when calls arrive at once.';
comment on column private.session_gate_observations.first_seen_at is 'First call counted in the row.';
comment on column private.session_gate_observations.last_seen_at is 'Last call counted in the row.';

-- Session activity and network pass ---------------------------------------------------------------------------------------

create table if not exists private.session_state (
  session_id uuid primary key references auth.sessions (id) on delete cascade,
  last_activity_at timestamptz not null default now(),
  longest_gap interval not null default interval '0',
  pass_address inet,
  pass_at timestamptz,
  created_at timestamptz not null default now(),
  constraint session_state_gap_not_negative check (longest_gap >= interval '0'),
  constraint session_state_pass_whole check ((pass_address is null) = (pass_at is null))
);

alter table private.session_state enable row level security;
revoke all on private.session_state from public, anon, authenticated;

comment on table private.session_state is 'One row per Supabase Auth session, removed with it (ADR 0169 D4 and D5): the session''s last recorded activity, the longest gap between two of its activities, and its network pass. Written only by private.stamp_session_activity, at most once a minute, never from a value the client supplies. It replaces the activity role of private.session_devices, which keeps the device shown under Sessions.';
comment on column private.session_state.session_id is 'Supabase Auth session (auth.sessions.id).';
comment on column private.session_state.last_activity_at is 'Last recorded activity: a read-write call the gate stamped, or app.touch_my_session.';
comment on column private.session_state.longest_gap is 'Longest gap between two activities of the session so far. Kept, so activity after an idle timeout does not revive the session.';
comment on column private.session_state.pass_address is 'Address at which one of our servers last saw the session, taken from a verified attestation only.';
comment on column private.session_state.pass_at is 'When that address was attested. The pass counts for five minutes.';
comment on column private.session_state.created_at is 'When the gate first recorded the session.';

-- Organization rules ------------------------------------------------------------------------------------------------------

create table if not exists private.org_session_rules (
  org_id uuid primary key references app.organizations (id) on delete cascade,
  mfa_policy text,
  session_hours integer,
  idle_timeout_minutes integer,
  ip_allowlist boolean not null default false,
  updated_at timestamptz not null default now()
);

alter table private.org_session_rules enable row level security;
revoke all on private.org_session_rules from public, anon, authenticated;

comment on table private.org_session_rules is 'The session rules an organization set (ADR 0169 D1), one row per organization, so the verdict reads one row instead of four settings. Kept current by triggers on app.setting_values and app.org_ip_allowlist. A missing row or a NULL column means the organization set nothing and gets the registry default.';
comment on column private.org_session_rules.org_id is 'Organization.';
comment on column private.org_session_rules.mfa_policy is 'Its own security.mfa_policy (optional, admins or everyone), or NULL when unset.';
comment on column private.org_session_rules.session_hours is 'Its own security.session_hours, or NULL when unset.';
comment on column private.org_session_rules.idle_timeout_minutes is 'Its own security.idle_timeout_minutes, or NULL when unset.';
comment on column private.org_session_rules.ip_allowlist is 'True when the security.ip_allowlist switch is on and at least one network is listed. Whether the plan includes the feature is read live (private.ip_allowlist_enforced), because feature overrides start and end by the clock.';
comment on column private.org_session_rules.updated_at is 'When the row last changed.';

create or replace function private.refresh_org_session_rules(p_org_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  insert into private.org_session_rules as r (org_id, mfa_policy, session_hours, idle_timeout_minutes, ip_allowlist, updated_at)
  select o.id,
    (select v.value_text from app.setting_values v
     where v.org_id = o.id and v.setting_key = 'security.mfa_policy' and v.scope_kind = 'Organization'
       and v.scope_id = o.id and v.deleted_at is null),
    (select v.value_integer::integer from app.setting_values v
     where v.org_id = o.id and v.setting_key = 'security.session_hours' and v.scope_kind = 'Organization'
       and v.scope_id = o.id and v.deleted_at is null),
    (select v.value_integer::integer from app.setting_values v
     where v.org_id = o.id and v.setting_key = 'security.idle_timeout_minutes' and v.scope_kind = 'Organization'
       and v.scope_id = o.id and v.deleted_at is null),
    coalesce((select v.value_boolean from app.setting_values v
              where v.org_id = o.id and v.setting_key = 'security.ip_allowlist' and v.scope_kind = 'Organization'
                and v.scope_id = o.id and v.deleted_at is null), false)
      and exists (select 1 from app.org_ip_allowlist a where a.org_id = o.id and a.deleted_at is null),
    now()
  from app.organizations o
  where o.id = p_org_id
  on conflict (org_id) do update
    set mfa_policy = excluded.mfa_policy,
        session_hours = excluded.session_hours,
        idle_timeout_minutes = excluded.idle_timeout_minutes,
        ip_allowlist = excluded.ip_allowlist,
        updated_at = excluded.updated_at
    where (r.mfa_policy, r.session_hours, r.idle_timeout_minutes, r.ip_allowlist)
      is distinct from (excluded.mfa_policy, excluded.session_hours, excluded.idle_timeout_minutes, excluded.ip_allowlist);
end;
$$;

comment on function private.refresh_org_session_rules(uuid) is 'Rewrites an organization''s row in private.org_session_rules from its own Organization-scope values of security.mfa_policy, security.session_hours, security.idle_timeout_minutes and security.ip_allowlist, and from app.org_ip_allowlist. Called by the triggers that keep the row current; safe to call at any time.';
revoke all on function private.refresh_org_session_rules(uuid) from public, anon, authenticated;

create or replace function private.keep_org_session_rules()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op <> 'INSERT' then
    perform private.refresh_org_session_rules(old.org_id);
  end if;
  if tg_op <> 'DELETE' and (tg_op = 'INSERT' or new.org_id is distinct from old.org_id) then
    perform private.refresh_org_session_rules(new.org_id);
  end if;
  return null;
end;
$$;

comment on function private.keep_org_session_rules() is 'After trigger on app.setting_values (the four security settings the gate reads) and app.org_ip_allowlist: refreshes the organization''s row in private.org_session_rules.';
revoke all on function private.keep_org_session_rules() from public, anon, authenticated;

drop trigger if exists t86_keep_session_rules on app.setting_values;
create trigger t86_keep_session_rules after insert or update on app.setting_values
  for each row
  when (new.setting_key in ('security.mfa_policy', 'security.session_hours', 'security.idle_timeout_minutes', 'security.ip_allowlist'))
  execute function private.keep_org_session_rules();

drop trigger if exists t87_keep_session_rules_deleted on app.setting_values;
create trigger t87_keep_session_rules_deleted after delete on app.setting_values
  for each row
  when (old.setting_key in ('security.mfa_policy', 'security.session_hours', 'security.idle_timeout_minutes', 'security.ip_allowlist'))
  execute function private.keep_org_session_rules();

drop trigger if exists t86_keep_session_rules on app.org_ip_allowlist;
create trigger t86_keep_session_rules after insert or update or delete on app.org_ip_allowlist
  for each row execute function private.keep_org_session_rules();

-- Organizations that already set one of the four settings or listed a network.
insert into private.org_session_rules (org_id)
select distinct s.org_id
from (
  select v.org_id from app.setting_values v
  where v.setting_key in ('security.mfa_policy', 'security.session_hours', 'security.idle_timeout_minutes', 'security.ip_allowlist')
  union
  select a.org_id from app.org_ip_allowlist a
) s
on conflict (org_id) do nothing;

do $$
begin
  perform private.refresh_org_session_rules(r.org_id) from private.org_session_rules r;
end;
$$;

-- The two flags on the configuration row ----------------------------------------------------------------------------------

create or replace function private.keep_session_gate_flags()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update private.session_gate_config c
  set org_modes = exists (select 1 from private.session_gate_orgs),
      suspensions = exists (select 1 from private.session_gate_overrides o where o.ended_at is null)
  where c.singleton
    and (c.org_modes is distinct from exists (select 1 from private.session_gate_orgs)
      or c.suspensions is distinct from exists (select 1 from private.session_gate_overrides o where o.ended_at is null));
  return null;
end;
$$;

comment on function private.keep_session_gate_flags() is 'Statement trigger on private.session_gate_orgs and private.session_gate_overrides: keeps org_modes and suspensions on the configuration row true exactly while those tables hold a row that can matter.';
revoke all on function private.keep_session_gate_flags() from public, anon, authenticated;

drop trigger if exists t90_keep_flags on private.session_gate_orgs;
create trigger t90_keep_flags after insert or update or delete or truncate on private.session_gate_orgs
  for each statement execute function private.keep_session_gate_flags();
drop trigger if exists t90_keep_flags on private.session_gate_overrides;
create trigger t90_keep_flags after insert or update or delete or truncate on private.session_gate_overrides
  for each statement execute function private.keep_session_gate_flags();

-- Overrides in the audit ledger -------------------------------------------------------------------------------------------

create or replace function private.audit_session_gate_override()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    perform private.write_audit_event(new.org_id, 'session_gate_overrides.started', 'private.session_gate_overrides', new.id,
      jsonb_build_object('control', new.control, 'actor', new.actor, 'reason', new.reason, 'starts_at', new.starts_at,
        'expires_at', new.expires_at));
  elsif new.ended_at is not null and old.ended_at is null then
    perform private.write_audit_event(new.org_id, 'session_gate_overrides.ended', 'private.session_gate_overrides', new.id,
      jsonb_build_object('control', new.control, 'actor', new.actor, 'ended_at', new.ended_at));
  elsif (new.org_id, new.control, new.actor, new.reason, new.starts_at, new.expires_at, new.ended_at)
        is distinct from (old.org_id, old.control, old.actor, old.reason, old.starts_at, old.expires_at, old.ended_at) then
    raise exception using errcode = 'XR001', hint = 'session_gate_override_fixed',
      message = 'session_gate_override_fixed: an override is ended, never rewritten; write a new one.';
  end if;
  return null;
end;
$$;

comment on function private.audit_session_gate_override() is 'After trigger on private.session_gate_overrides: writes session_gate_overrides.started and session_gate_overrides.ended to the organization''s audit ledger with the control, the actor and the reason, and refuses any other change to a row.';
revoke all on function private.audit_session_gate_override() from public, anon, authenticated;

drop trigger if exists t85_audit_override on private.session_gate_overrides;
create trigger t85_audit_override after insert or update on private.session_gate_overrides
  for each row execute function private.audit_session_gate_override();

reset lock_timeout;

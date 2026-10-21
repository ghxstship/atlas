-- 1355_white_label_provisioning.sql
-- A79 (RRR-124), finding A65-033, Section 12:
--   "Custom domains for Atlas and Gateway are added through the Vercel Domains API, with DNS verification and automatic
--    TLS. Custom email sending domains use SPF, DKIM and DMARC verification through Resend."
--   "White-label settings outlive no plan: downgrading below the entitled plan reverts to default branding at the next
--    billing cycle, with notice."
--
--   * Provisioning: adding an Atlas, Gateway or Email Sending domain queues domain.provision for the org-lifecycle
--     worker, which adds the host to the Vercel project (Atlas and Gateway) or creates the sending domain at Resend,
--     and records the provider reference, the DNS records the customer must publish, and the state. While DNS is
--     pending, a domain.check runs every 15 minutes for up to 7 days; Vercel's verification and certificate, or
--     Resend's SPF and DKIM verification, then mark the domain Verified (and its TLS ready). Removing a domain queues
--     domain.release, which removes it at the provider. The provider calls live behind ports in @xos/integrations
--     (packages/integrations/src/domains); tests use fake transports and never call the real APIs.
--   * Only the worker (the service role, app.record_domain_provisioning) writes the provisioning fields, inside the
--     domain_verification trusted operation, like the verification state.
--   * Downgrade grace: when an org's plan stops including white label (a downgrade, a canceled subscription, a trial
--     ending), app.white_label_grace keeps its white label and custom domains until the end of the billing period
--     already paid for (Stripe's current period end; at once when nothing was paid), and every Owner is told. The
--     hourly lifecycle job ends the grace at that time and tells them again. Regaining the plan ends the grace.
--     private.white_label_in_force now decides "Powered by XOS" and custom domain lookups instead of the plan alone.

-- Provisioning state --------------------------------------------------------------------------------------------------

create type app.domain_provisioning_status as enum ('Not Started', 'Requested', 'Pending DNS', 'Active', 'Failed', 'Released');
comment on type app.domain_provisioning_status is 'Where a custom domain stands at its provider (Vercel for Atlas and Gateway hosts, Resend for sending domains). A sync status, not a lifecycle (ADR 0002).';

alter table app.org_domains
  add column provisioning_status app.domain_provisioning_status not null default 'Not Started',
  add column provider_ref text,
  add column dns_records jsonb not null default '[]'::jsonb,
  add column tls_ready boolean not null default false,
  add column provisioned_at timestamptz,
  add column provisioning_error text,
  add constraint org_domains_dns_records_array check (jsonb_typeof(dns_records) = 'array'),
  add constraint org_domains_provider_ref_length check (provider_ref is null or char_length(provider_ref) <= 200),
  add constraint org_domains_provisioning_error_length check (provisioning_error is null or char_length(provisioning_error) <= 2000);

comment on column app.org_domains.provisioning_status is 'Where the domain stands at its provider: Not Started, Requested, Pending DNS, Active, Failed or Released. Written only by the org-lifecycle worker (app.record_domain_provisioning).';
comment on column app.org_domains.provider_ref is 'The domain''s identifier at its provider: the host name on the Vercel project, or the Resend domain id.';
comment on column app.org_domains.dns_records is 'DNS records the org publishes for the provider, as the provider gave them: an array of {type, name, value, purpose} (for example the CNAME of an Atlas host, or the SPF, DKIM and DMARC records of a sending domain).';
comment on column app.org_domains.tls_ready is 'True once the provider issued the TLS certificate of an Atlas or Gateway host (Vercel issues it automatically after DNS verification).';
comment on column app.org_domains.provisioned_at is 'When the provider first reported the domain active.';
comment on column app.org_domains.provisioning_error is 'Why the latest provisioning step failed, as the worker recorded it.';

create or replace function private.guard_org_domain()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_service boolean := private.in_trusted_operation('domain_verification');
begin
  if tg_op = 'UPDATE' and (new.hostname <> old.hostname or new.purpose <> old.purpose) then
    perform private.refuse('domain_immutable', 'A domain keeps its host name and purpose; remove it and add another.');
  end if;
  if not v_service then
    if tg_op = 'INSERT' then
      new.verification_state := 'Pending';
      new.verified_at := null;
      new.last_checked_at := null;
      new.provisioning_status := 'Not Started';
      new.provider_ref := null;
      new.dns_records := '[]'::jsonb;
      new.tls_ready := false;
      new.provisioned_at := null;
      new.provisioning_error := null;
    elsif new.verification_state <> old.verification_state or new.verified_at is distinct from old.verified_at
       or new.last_checked_at is distinct from old.last_checked_at or new.verification_token <> old.verification_token
       or new.provisioning_status <> old.provisioning_status or new.provider_ref is distinct from old.provider_ref
       or new.dns_records <> old.dns_records or new.tls_ready <> old.tls_ready
       or new.provisioned_at is distinct from old.provisioned_at
       or new.provisioning_error is distinct from old.provisioning_error then
      perform private.refuse('domain_verification_service', 'Only the verification service records verification and provisioning.');
    end if;
  end if;
  if tg_op = 'INSERT' and new.purpose in ('Atlas', 'Gateway') and not private.org_has_feature(new.org_id, 'custom_domain') then
    perform private.refuse('plan_feature_required', 'Custom domains need a plan with custom domains (Pro and above).');
  end if;
  if tg_op = 'INSERT' and new.purpose = 'Email Sending' and not private.org_has_feature(new.org_id, 'white_label') then
    perform private.refuse('plan_feature_required', 'Email sending domains need a plan with white label (Pro and above).');
  end if;
  if new.auto_join_role_id is not null and new.deleted_at is null then
    if (select r.band from app.roles r where r.id = new.auto_join_role_id) <= 2 then
      perform private.refuse('auto_join_role_band', 'Automatic join cannot grant Owner or Admin.');
    end if;
  end if;
  return new;
end;
$$;

comment on function private.guard_org_domain() is 'Org domains: host and purpose never change, verification and provisioning fields change only inside the verification service (the org-lifecycle worker), custom Atlas and Gateway domains need the custom_domain feature, email domains need white_label, and automatic join never grants Owner or Admin.';

-- Jobs ---------------------------------------------------------------------------------------------------------------------

insert into private.job_kinds (code, subject_table, max_attempts, description) values
  ('domain.provision', 'app.org_domains', 8, 'Adds a custom Atlas or Gateway host to the Vercel project, or a sending domain to Resend, and records the DNS records to publish.'),
  ('domain.check', 'app.org_domains', 3, 'Checks a provisioned domain''s DNS verification and TLS at its provider.'),
  ('domain.release', 'app.org_domains', 8, 'Removes a removed custom domain from its provider.');

create or replace function private.provisioned_purpose(p_purpose app.org_domain_purpose)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_purpose in ('Atlas', 'Gateway', 'Email Sending');
$$;

comment on function private.provisioned_purpose(app.org_domain_purpose) is 'True for domain purposes a provider serves: Atlas and Gateway hosts (Vercel) and sending domains (Resend). Verified domains only prove control by a TXT record.';
revoke all on function private.provisioned_purpose(app.org_domain_purpose) from public, anon, authenticated;

create or replace function private.queue_domain_provisioning()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.provisioned_purpose(new.purpose) then
    return null;
  end if;
  if tg_op = 'INSERT' and new.deleted_at is null then
    perform private.enqueue_job(new.org_id, 'domain.provision', new.id);
  elsif tg_op = 'UPDATE' and new.deleted_at is not null and old.deleted_at is null and new.provider_ref is not null then
    perform private.enqueue_job(new.org_id, 'domain.release', new.id);
  end if;
  return null;
end;
$$;

comment on function private.queue_domain_provisioning() is 'After a custom domain is added, queues domain.provision; after a provisioned one is removed, queues domain.release (Section 12).';
revoke all on function private.queue_domain_provisioning() from public, anon, authenticated;

create trigger t82_queue_domain_provisioning after insert or update of deleted_at on app.org_domains
  for each row execute function private.queue_domain_provisioning();

create or replace function app.request_domain_check(p_org_domain_id uuid)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_domain app.org_domains;
begin
  perform private.require_person();
  select * into v_domain from app.org_domains d where d.id = p_org_domain_id and d.deleted_at is null;
  if v_domain.id is null or not private.has_capability(v_domain.org_id, private.domain_write_capability(v_domain.purpose)) then
    raise exception using errcode = '42501', message = 'domain not found';
  end if;
  if not private.provisioned_purpose(v_domain.purpose) then
    perform private.refuse('domain_not_provisioned', 'Verified domains are checked by their TXT record.');
  end if;
  return private.enqueue_job(v_domain.org_id,
    case when v_domain.provider_ref is null then 'domain.provision' else 'domain.check' end, v_domain.id);
end;
$$;

comment on function app.request_domain_check(uuid) is 'Asks the worker to provision a custom domain again, or to check its DNS and TLS now, for a holder of the domain''s write capability. Returns the job id.';
revoke all on function app.request_domain_check(uuid) from public, anon;
grant execute on function app.request_domain_check(uuid) to authenticated, service_role;

create or replace function app.domains_to_provision(p_org_domain_ids uuid[])
returns table (id uuid, org_id uuid, hostname text, purpose app.org_domain_purpose, provider_ref text, deleted boolean)
language sql
stable
security definer
set search_path = ''
as $$
  select d.id, d.org_id, d.hostname, d.purpose, d.provider_ref, d.deleted_at is not null
  from app.org_domains d where d.id = any (p_org_domain_ids);
$$;

comment on function app.domains_to_provision(uuid[]) is 'Worker API (service role): the domains of claimed domain jobs, with their provider reference and whether they were removed.';
revoke all on function app.domains_to_provision(uuid[]) from public, anon, authenticated;
grant execute on function app.domains_to_provision(uuid[]) to service_role;

create or replace function app.record_domain_provisioning(
  p_org_domain_id uuid,
  p_status app.domain_provisioning_status,
  p_provider_ref text default null,
  p_dns_records jsonb default null,
  p_tls_ready boolean default null,
  p_verified boolean default null,
  p_error text default null
)
returns app.domain_provisioning_status
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_domain app.org_domains;
begin
  select * into v_domain from app.org_domains d where d.id = p_org_domain_id for update;
  if v_domain.id is null then
    perform private.refuse('domain_unknown', 'The domain does not exist.');
  end if;
  if p_dns_records is not null and jsonb_typeof(p_dns_records) <> 'array' then
    perform private.refuse('domain_dns_records', 'DNS records are an array.');
  end if;
  perform private.begin_trusted_operation('domain_verification');
  update app.org_domains d
  set provisioning_status = p_status,
    provider_ref = coalesce(p_provider_ref, d.provider_ref),
    dns_records = coalesce(p_dns_records, d.dns_records),
    tls_ready = coalesce(p_tls_ready, d.tls_ready),
    provisioned_at = case when p_status = 'Active' then coalesce(d.provisioned_at, now()) else d.provisioned_at end,
    provisioning_error = case when p_status = 'Failed' then left(coalesce(p_error, 'The provider refused the domain.'), 2000) else null end,
    verification_state = case when p_verified is null then d.verification_state
                              when p_verified then 'Verified'::app.domain_verification_state
                              else 'Pending'::app.domain_verification_state end,
    verified_at = case when p_verified is null then d.verified_at when p_verified then coalesce(d.verified_at, now()) end,
    last_checked_at = case when p_verified is null then d.last_checked_at else now() end
  where d.id = v_domain.id;
  perform private.end_trusted_operation('domain_verification');
  if p_status = 'Pending DNS' and v_domain.deleted_at is null and v_domain.created_at > now() - interval '7 days' then
    perform private.enqueue_job(v_domain.org_id, 'domain.check', v_domain.id, now() + interval '15 minutes');
  end if;
  return p_status;
end;
$$;

comment on function app.record_domain_provisioning(uuid, app.domain_provisioning_status, text, jsonb, boolean, boolean, text) is 'Worker API (service role): records a provisioning step of a custom domain: its status, provider reference, the DNS records to publish, whether TLS is ready, and the DNS verification when the provider checked it. A domain still waiting for DNS is checked again in 15 minutes, for up to 7 days after it was added. A verified host name can be held by one org per purpose at a time.';
revoke all on function app.record_domain_provisioning(uuid, app.domain_provisioning_status, text, jsonb, boolean, boolean, text) from public, anon, authenticated;
grant execute on function app.record_domain_provisioning(uuid, app.domain_provisioning_status, text, jsonb, boolean, boolean, text) to service_role;

-- Downgrade grace ------------------------------------------------------------------------------------------------------------

create table app.white_label_grace (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  plan_from text not null references app.plans (code),
  kept_until timestamptz not null,
  ended_at timestamptz,
  end_reason text,
  constraint white_label_grace_end check ((ended_at is null) = (end_reason is null)),
  constraint white_label_grace_end_reason check (end_reason is null or end_reason in ('reverted', 'plan_regained'))
);

call private.install_domain_table('app.white_label_grace');
create unique index white_label_grace_one_open on app.white_label_grace (org_id) where ended_at is null and deleted_at is null;
create index white_label_grace_plan_from_idx on app.white_label_grace (plan_from);
create index white_label_grace_due_idx on app.white_label_grace (kept_until) where ended_at is null;

call private.describe('app.white_label_grace', 'White label kept after a downgrade (Section 12): when an org''s plan stops including white label, its brand without "Powered by XOS" and its custom domains stay until the end of the billing period already paid for, with notice to every Owner, then revert to default branding. Written only by the subscription trigger and the lifecycle job.', array[
  'plan_from', 'Plan that included white label before the change.',
  'kept_until', 'End of the paid billing period: white label reverts then.',
  'ended_at', 'When the grace ended.',
  'end_reason', 'reverted (the period ended) or plan_regained (the org moved back to a plan with white label).'
]);

call private.install_policies('app.white_label_grace', $$org_id in (select private.orgs_with_capability('org.settings.read'))$$);
call private.install_audit_trail('app.white_label_grace');

insert into private.read_only_exempt_tables (table_name, rationale) values
  ('app.white_label_grace', 'Written by the subscription trigger when billing changes the plan, whatever the org''s state.');
drop trigger if exists t15_refuse_read_only_org on app.white_label_grace;

insert into private.notification_templates (kind, channel, category_code, email_template_code)
select k.kind, c.channel, 'account', case when c.channel = 'Email' then 'notification' end
from (values ('organization.white_label_reverting'), ('organization.white_label_reverted')) as k (kind)
cross join (values ('In App'::app.notification_channel), ('Email'), ('SMS'), ('Push')) as c (channel);

create or replace function private.white_label_in_force(p_org_id uuid, p_feature app.plan_feature_code)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.org_has_feature(p_org_id, p_feature)
    or (p_feature in ('white_label', 'custom_domain')
        and exists (select 1 from app.white_label_grace g
                    where g.org_id = p_org_id and g.ended_at is null and g.deleted_at is null and g.kept_until > now()));
$$;

comment on function private.white_label_in_force(uuid, app.plan_feature_code) is 'True while an org''s white label or custom domains apply: its plan includes the feature, or a downgrade grace keeps them to the end of the paid period (Section 12).';
revoke all on function private.white_label_in_force(uuid, app.plan_feature_code) from public, anon;
grant execute on function private.white_label_in_force(uuid, app.plan_feature_code) to authenticated, service_role;

create or replace function private.org_uses_white_label(p_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from app.org_brands b where b.org_id = p_org_id and b.deleted_at is null and b.suppress_powered_by)
    or exists (select 1 from app.org_domains d where d.org_id = p_org_id and d.deleted_at is null
               and d.purpose in ('Atlas', 'Gateway', 'Email Sending'));
$$;

comment on function private.org_uses_white_label(uuid) is 'True when an org hides "Powered by XOS" or has a custom Atlas, Gateway or sending domain, so a downgrade changes what its people and customers see.';
revoke all on function private.org_uses_white_label(uuid) from public, anon, authenticated;

create or replace function private.track_white_label_grace()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_had boolean;
  v_has boolean;
  v_until timestamptz;
  v_person uuid;
  v_grace uuid;
begin
  if private.in_trusted_operation('billing_handover') then
    return null;
  end if;
  v_had := old.subscription_state <> 'canceled'
    and exists (select 1 from private.plan_features f where f.plan_code = old.plan_code and f.feature_code = 'white_label');
  v_has := private.org_has_feature(new.org_id, 'white_label');
  if v_has then
    update app.white_label_grace set ended_at = now(), end_reason = 'plan_regained'
    where org_id = new.org_id and ended_at is null and deleted_at is null;
    return null;
  end if;
  if not v_had or not private.org_uses_white_label(new.org_id)
     or exists (select 1 from app.white_label_grace g where g.org_id = new.org_id and g.ended_at is null and g.deleted_at is null) then
    return null;
  end if;
  v_until := greatest(now(), coalesce((select max(l.current_period_end) from app.stripe_subscription_links l
                                       where l.subscription_id = old.id and l.deleted_at is null), now()));
  if v_until > now() then
    insert into app.white_label_grace (org_id, plan_from, kept_until) values (new.org_id, old.plan_code, v_until)
    returning id into v_grace;
  end if;
  for v_person in select private.org_owner_ids(new.org_id) loop
    perform private.notify(new.org_id, v_person,
      case when v_until > now() then 'organization.white_label_reverting' else 'organization.white_label_reverted' end,
      'app.organizations', new.org_id, null, jsonb_build_object('plan', old.plan_code, 'until', private.epoch_ms(v_until)));
  end loop;
  return null;
end;
$$;

comment on function private.track_white_label_grace() is 'After a subscription''s plan or state changes: when the org loses white label and uses it, keeps it to the end of the paid Stripe period (or reverts at once when nothing was paid) and tells every Owner; when the org regains it, ends any grace (Section 12). A billing handover (app.leave_partner) changes no plan and is skipped.';
revoke all on function private.track_white_label_grace() from public, anon, authenticated;

create trigger t92_track_white_label_grace after update of plan_code, subscription_state on app.subscriptions
  for each row when (old.plan_code is distinct from new.plan_code or old.subscription_state is distinct from new.subscription_state)
  execute function private.track_white_label_grace();

create or replace function private.revert_white_label(p_now timestamptz default now())
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_grace record;
  v_person uuid;
  v_count integer := 0;
begin
  for v_grace in
    select g.id, g.org_id, g.plan_from, g.kept_until from app.white_label_grace g
    where g.ended_at is null and g.deleted_at is null and g.kept_until <= p_now
  loop
    update app.white_label_grace set ended_at = p_now, end_reason = 'reverted' where id = v_grace.id;
    for v_person in select private.org_owner_ids(v_grace.org_id) loop
      perform private.notify(v_grace.org_id, v_person, 'organization.white_label_reverted', 'app.white_label_grace', v_grace.id, null,
        jsonb_build_object('plan', v_grace.plan_from, 'until', private.epoch_ms(v_grace.kept_until)));
    end loop;
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

comment on function private.revert_white_label(timestamptz) is 'White label step of the lifecycle job: ends each downgrade grace whose paid period is over, so default branding returns, and tells every Owner. Returns how many.';
revoke all on function private.revert_white_label(timestamptz) from public, anon, authenticated;

create or replace function private.run_org_lifecycle(p_now timestamptz default now())
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  return private.run_trials(p_now) + private.expire_ownership_transfers(p_now) + private.revert_white_label(p_now)
    + private.schedule_deletions(p_now) + private.run_org_purges(5);
end;
$$;

comment on function private.run_org_lifecycle(timestamptz) is 'Hourly org lifecycle job (Section 12, Section 14.7): trials, lapsed ownership offers, white label kept past a downgrade, certificates for orgs due for deletion, then the purge of orgs whose storage objects the worker deleted. Returns the actions taken.';

-- Brand resolution honors the grace --------------------------------------------------------------------------------------------

create or replace function private.public_brand(p_org_id uuid)
returns table (
  org_slug text,
  name text,
  logo_light_path text,
  logo_dark_path text,
  favicon_path text,
  app_icon_path text,
  accent_hex text,
  neutral_tint_hex text,
  font_family text,
  radius_scale app.brand_radius_scale,
  suppress_powered_by boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select o.slug,
    coalesce(b.display_name, o.name),
    b.logo_light_path, b.logo_dark_path, b.favicon_path, b.app_icon_path,
    case when d.id is null then b.accent_hex
         when d.allow_client_override then coalesce(b.accent_hex, d.accent_hex)
         else coalesce(d.accent_hex, b.accent_hex) end,
    case when d.id is null then b.neutral_tint_hex
         when d.allow_client_override then coalesce(b.neutral_tint_hex, d.neutral_tint_hex)
         else coalesce(d.neutral_tint_hex, b.neutral_tint_hex) end,
    case when d.id is null then b.font_family
         when d.allow_client_override then coalesce(b.font_family, d.font_family)
         else coalesce(d.font_family, b.font_family) end,
    case when d.id is null or (d.allow_client_override and b.id is not null) then coalesce(b.radius_scale, 'Default')
         else d.radius_scale end,
    coalesce(b.suppress_powered_by, false) and private.white_label_in_force(o.id, 'white_label')
  from app.organizations o
  left join app.org_brands b on b.org_id = o.id and b.deleted_at is null
  left join app.partner_default_brands d on d.org_id = o.parent_org_id and d.deleted_at is null
  where o.id = p_org_id and o.deleted_at is null;
$$;

comment on function private.public_brand(uuid) is 'The public half of an org''s brand. A client org inherits its partner''s default brand: its own values win where the partner allows overrides, the partner''s win otherwise (Section 4.6.1). "Powered by XOS" stays shown unless white label is in force (the plan includes it, or a downgrade grace keeps it to the end of the paid period, Section 12).';

create or replace function api_public.org_brand_for_host(p_host text)
returns table (
  org_id uuid,
  org_slug text,
  name text,
  logo_light_path text,
  logo_dark_path text,
  favicon_path text,
  app_icon_path text,
  accent_hex text,
  neutral_tint_hex text,
  font_family text,
  radius_scale app.brand_radius_scale,
  suppress_powered_by boolean,
  surface app.org_domain_purpose
)
language sql
stable
security definer
set search_path = ''
as $$
  select d.org_id, b.*, d.purpose
  from app.org_domains d
  cross join lateral private.public_brand(d.org_id) b
  where d.hostname = lower(btrim(p_host)) and d.purpose in ('Atlas', 'Gateway')
    and d.verification_state = 'Verified' and d.deleted_at is null
    and private.white_label_in_force(d.org_id, 'custom_domain');
$$;

comment on function api_public.org_brand_for_host(text) is 'White label lookup by request host (Section 4.4.7): the org id and brand of the org whose verified custom Atlas or Gateway domain the host is, with the surface it serves. Returns nothing for any other host, and nothing once custom domains are no longer in force (the plan lost them and any downgrade grace ended, Section 12).';

-- Banner: until when a downgraded org keeps its white label ------------------------------------------------------------------

create or replace function app.org_banner_status(p_org_id uuid)
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
  ownership_expires_at timestamptz
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
begin
  if not private.is_member(p_org_id) then
    raise exception using errcode = '42501', message = 'banner status needs an active membership in the org';
  end if;
  v_reason := private.org_read_only_reason(p_org_id);
  v_staff := private.has_capability(p_org_id, 'org.settings.read');
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
    o.id, o.offered_by, o.expires_at
  from (select 1) one
  left join lateral (
    select t.id, p.full_name as offered_by, t.expires_at from app.ownership_transfers t
    join app.people p on p.id = t.from_person_id
    where t.org_id = p_org_id and t.to_person_id = private.current_person_id()
      and t.accepted_at is null and t.declined_at is null and t.canceled_at is null and t.expired_at is null
      and t.deleted_at is null and t.expires_at > now()
    limit 1
  ) o on true;
end;
$$;

insert into private.retention_policies (table_name, basis, time_column, retention, purge_method, rationale) values
  ('app.white_label_grace', 'Age', 'created_at', interval '7 years', 'Delete', 'A record of what a plan change did to the org''s brand and when it was told.');

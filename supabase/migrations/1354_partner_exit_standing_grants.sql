-- 1354_partner_exit_standing_grants.sql
-- A79 (RRR-124), finding A65-026, Section 4.6.1:
--   "Access requires either a support session granted by the client Owner (Section 8), or a standing grant written into
--    the partner and client agreement, recorded as a record_grants row with scope and expiry."
--   "Exit: a client org can leave its partner and become a direct customer. Its data, members and brand stay intact."
--
--   * app.partner_standing_grants: the client Owner records a grant the partner and client agreement provides: one read
--     capability (the scope), an expiry of at most a year and the clause it comes from. It issues an org-level
--     app.record_grants row for the partner org, like a support session, and lands in the client's audit ledger.
--     Either side may end it early. Partner staff still never write: the scope is a read capability support sessions
--     may grant.
--   * app.leave_partner: the client Owner (org.billing.manage) types the org name. In one transaction the org keeps
--     the brand it renders with now as its own (the partner's inherited values are copied into its own brand), every
--     support session and standing grant of the partner ends, the partner's price for the client is removed, the org
--     stops being a client, and billing moves to the org: the partner-billed subscription ends and a 14-day trial of
--     the same plan starts, which converts when the Owner adds a card, so nothing changes for its members meanwhile.
--     Data and members are untouched. Both sides are told.
-- Partner-to-client billing through Stripe Connect is out of scope here; docs/design/partner-connect-billing.md sets
-- out the design for the owner's decision.

-- Standing grants -------------------------------------------------------------------------------------------------------

create table app.partner_standing_grants (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  partner_org_id uuid not null references app.organizations (id),
  capability_code text not null references app.capabilities (code),
  agreement_reference text not null,
  valid_from timestamptz not null default now(),
  valid_to timestamptz not null,
  record_grant_id uuid not null references app.record_grants (id),
  ended_at timestamptz,
  ended_by uuid references app.people (id),
  constraint partner_standing_grants_not_self check (partner_org_id <> org_id),
  constraint partner_standing_grants_reference check (char_length(btrim(agreement_reference)) between 1 and 300),
  constraint partner_standing_grants_window check (valid_to > valid_from and valid_to <= valid_from + interval '366 days'),
  constraint partner_standing_grants_ended check ((ended_at is null) = (ended_by is null))
);

call private.install_domain_table('app.partner_standing_grants');
create unique index partner_standing_grants_record_grant_key on app.partner_standing_grants (record_grant_id);
create index partner_standing_grants_partner_org_id_idx on app.partner_standing_grants (partner_org_id);
create index partner_standing_grants_capability_code_idx on app.partner_standing_grants (capability_code);
create index partner_standing_grants_ended_by_idx on app.partner_standing_grants (ended_by);

call private.describe('app.partner_standing_grants', 'A standing grant written into the partner and client agreement (Section 4.6.1): the client Owner lets the partner''s staff read one area of the client org until an expiry of at most a year, citing the agreement clause. Each issues an org-level record_grants row; either side may end it early. Partner staff never write through one.', array[
  'org_id', 'Client org that granted the access.',
  'partner_org_id', 'Partner org whose staff may read.',
  'capability_code', 'The scope: one read capability, of those a support session may grant.',
  'agreement_reference', 'The clause of the partner and client agreement that provides the grant.',
  'valid_from', 'When access began.',
  'valid_to', 'When access ends on its own, at most a year after it began.',
  'record_grant_id', 'Org-level record grant the standing grant issued.',
  'ended_at', 'When someone ended the grant early.',
  'ended_by', 'Person who ended it early.'
]);

call private.install_policies('app.partner_standing_grants',
  $$org_id in (select private.orgs_with_capability('org.settings.read')) or partner_org_id in (select private.orgs_with_capability('org.partner.manage'))$$);
call private.install_audit_trail('app.partner_standing_grants');

create or replace function private.guard_partner_standing_grant()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.org_id <> old.org_id or new.partner_org_id <> old.partner_org_id or new.capability_code <> old.capability_code
     or new.valid_from <> old.valid_from or new.valid_to <> old.valid_to or new.record_grant_id <> old.record_grant_id
     or new.agreement_reference <> old.agreement_reference
     or (old.ended_at is not null and new.ended_at is distinct from old.ended_at) then
    perform private.refuse('standing_grant_immutable', 'A standing grant keeps its parties, scope and window; it can only be ended early, once.');
  end if;
  return new;
end;
$$;

comment on function private.guard_partner_standing_grant() is 'Standing grants keep their parties, scope, clause and window; ending early happens once.';
revoke all on function private.guard_partner_standing_grant() from public, anon, authenticated;

create trigger t40_guard_partner_standing_grant before update on app.partner_standing_grants
  for each row execute function private.guard_partner_standing_grant();

create or replace function app.record_standing_grant(p_org_id uuid, p_capability_code text, p_valid_to timestamptz, p_agreement_reference text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
  v_partner uuid;
  v_grant uuid;
  v_id uuid;
begin
  if not private.has_capability(p_org_id, 'org.support_session.grant') then
    raise exception using errcode = '42501', message = 'org.support_session.grant is required';
  end if;
  select o.parent_org_id into v_partner from app.organizations o where o.id = p_org_id and o.deleted_at is null for update;
  if v_partner is null then
    perform private.refuse('standing_grant_no_partner', 'Only a client org records a standing grant for its partner.');
  end if;
  if p_capability_code is null or p_capability_code not in (select private.support_read_capabilities()) then
    perform private.refuse('standing_grant_scope', 'A standing grant covers one read area a support session may cover; partner staff never write.');
  end if;
  if p_valid_to is null or p_valid_to <= now() or p_valid_to > now() + interval '366 days' then
    perform private.refuse('standing_grant_expiry', 'A standing grant ends within a year.');
  end if;
  if p_agreement_reference is null or char_length(btrim(p_agreement_reference)) not between 1 and 300 then
    perform private.refuse('standing_grant_reference', 'Name the clause of the partner agreement, in up to 300 characters.');
  end if;
  insert into app.record_grants (target_kind, target_id, capability_code, grantee_org_id, valid_from, valid_to, reason)
  values ('organization', p_org_id, p_capability_code, v_partner, now(), p_valid_to,
          left('Standing partner grant: ' || btrim(p_agreement_reference), 500))
  returning id into v_grant;
  insert into app.partner_standing_grants (org_id, partner_org_id, capability_code, agreement_reference, valid_from, valid_to, record_grant_id)
  values (p_org_id, v_partner, p_capability_code, btrim(p_agreement_reference), now(), p_valid_to, v_grant)
  returning id into v_id;
  return v_id;
end;
$$;

comment on function app.record_standing_grant(uuid, text, timestamptz, text) is 'The client Owner (org.support_session.grant) records a standing grant of the partner and client agreement (Section 4.6.1): one read capability support sessions may grant, an expiry within a year and the agreement clause. Issues an org-level record grant for the partner org, written to the client''s audit ledger. Returns the standing grant id.';
revoke all on function app.record_standing_grant(uuid, text, timestamptz, text) from public, anon;
grant execute on function app.record_standing_grant(uuid, text, timestamptz, text) to authenticated, service_role;

create or replace function app.end_standing_grant(p_standing_grant_id uuid)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
  v_grant app.partner_standing_grants;
begin
  select * into v_grant from app.partner_standing_grants g where g.id = p_standing_grant_id and g.deleted_at is null for update;
  if v_grant.id is null
     or not (private.has_capability(v_grant.org_id, 'org.support_session.grant')
             or private.has_capability(v_grant.partner_org_id, 'org.partner.manage')) then
    raise exception using errcode = '42501', message = 'standing grant not found';
  end if;
  if v_grant.ended_at is not null or v_grant.valid_to <= now() then
    perform private.refuse('standing_grant_ended', 'This standing grant has already ended.');
  end if;
  update app.record_grants g set valid_to = greatest(now(), g.valid_from) where g.id = v_grant.record_grant_id;
  update app.partner_standing_grants set ended_at = now(), ended_by = v_person where id = v_grant.id;
  return v_grant.id;
end;
$$;

comment on function app.end_standing_grant(uuid) is 'Ends a standing grant early: the client''s Owner or the partner''s staff with org.partner.manage. Its record grant ends at once.';
revoke all on function app.end_standing_grant(uuid) from public, anon;
grant execute on function app.end_standing_grant(uuid) to authenticated, service_role;

-- Leaving the partner ----------------------------------------------------------------------------------------------------

insert into private.notification_templates (kind, channel, category_code, email_template_code)
select 'partner.client_left', c.channel, 'account', case when c.channel = 'Email' then 'notification' end
from (values ('In App'::app.notification_channel), ('Email'), ('SMS'), ('Push')) as c (channel);

create or replace function app.leave_partner(p_org_id uuid, p_confirm_name text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
  v_org app.organizations;
  v_partner uuid;
  v_brand record;
  v_sub app.subscriptions;
  v_staff uuid;
begin
  if not private.has_capability(p_org_id, 'org.billing.manage') then
    raise exception using errcode = '42501', message = 'org.billing.manage is required';
  end if;
  select * into v_org from app.organizations o where o.id = p_org_id and o.deleted_at is null for update;
  v_partner := v_org.parent_org_id;
  if v_partner is null then
    perform private.refuse('leave_partner_no_partner', 'This organization is already a direct customer.');
  end if;
  if p_confirm_name is null or btrim(p_confirm_name) <> v_org.name then
    perform private.refuse('org_name_mismatch', 'Type the organization''s name exactly to confirm.');
  end if;
  if private.org_read_only(p_org_id) then
    perform private.refuse('org_read_only', 'A read-only organization cannot leave its partner.');
  end if;

  -- 1. The brand it renders with now becomes its own.
  select * into v_brand from private.public_brand(p_org_id);
  if exists (select 1 from app.partner_default_brands d where d.org_id = v_partner and d.deleted_at is null) then
    if exists (select 1 from app.org_brands b where b.org_id = p_org_id and b.deleted_at is null) then
      update app.org_brands b
      set accent_hex = v_brand.accent_hex, neutral_tint_hex = v_brand.neutral_tint_hex, font_family = v_brand.font_family,
        radius_scale = v_brand.radius_scale,
        email_sender_name = coalesce(b.email_sender_name, (select d.email_sender_name from app.partner_default_brands d where d.org_id = v_partner and d.deleted_at is null)),
        support_email = coalesce(b.support_email, (select d.support_email from app.partner_default_brands d where d.org_id = v_partner and d.deleted_at is null))
      where b.org_id = p_org_id and b.deleted_at is null;
    else
      insert into app.org_brands (org_id, accent_hex, neutral_tint_hex, font_family, radius_scale, email_sender_name, support_email)
      select p_org_id, v_brand.accent_hex, v_brand.neutral_tint_hex, v_brand.font_family, v_brand.radius_scale,
        d.email_sender_name, d.support_email
      from app.partner_default_brands d where d.org_id = v_partner and d.deleted_at is null;
    end if;
  end if;

  -- 2. The partner's access ends: support sessions and standing grants.
  update app.record_grants g set valid_to = greatest(now(), g.valid_from)
  where g.id in (select sg.record_grant_id from app.support_session_grants sg
                 join app.support_sessions s on s.id = sg.support_session_id
                 where s.org_id = p_org_id and s.ended_at is null and s.ends_at > now())
     or g.id in (select pg.record_grant_id from app.partner_standing_grants pg
                 where pg.org_id = p_org_id and pg.ended_at is null and pg.valid_to > now());
  update app.support_sessions set ended_at = now(), ended_by = v_person
  where org_id = p_org_id and ended_at is null and ends_at > now();
  update app.partner_standing_grants set ended_at = now(), ended_by = v_person
  where org_id = p_org_id and ended_at is null and valid_to > now();
  update app.record_grants g set valid_to = greatest(now(), g.valid_from)
  where g.org_id = p_org_id and g.grantee_org_id = v_partner and g.valid_to > now();

  -- 3. The partner stops pricing the org, then the org stops being a client.
  update app.partner_client_prices set deleted_at = now()
  where org_id = v_partner and client_org_id = p_org_id and deleted_at is null;
  update app.organizations set parent_org_id = null where id = p_org_id;

  -- 4. Billing moves to the org: the partner-billed subscription ends and a direct trial of the same plan starts. The
  --    billing_handover mark tells plan-change triggers the plan never lapsed (1355: no white label downgrade notice).
  perform private.begin_trusted_operation('billing_handover');
  select * into v_sub from app.subscriptions s
  where s.org_id = p_org_id and s.subscription_state <> 'canceled' and s.deleted_at is null for update;
  if v_sub.id is not null then
    perform private.transition_subscription(v_sub.id, v_sub.subscription_state, 'canceled', 'Left the partner; billing moved to the organization.');
  end if;
  if coalesce(v_sub.plan_code, 'access') = 'access' then
    perform private.create_subscription(p_org_id, 'access');
  else
    perform private.start_trial(p_org_id, v_sub.plan_code, now() + private.trial_length(),
      format('Left the partner: the %s plan continues for 14 days and stays once a card is added.', v_sub.plan_code));
  end if;
  perform private.end_trusted_operation('billing_handover');

  -- 5. Both sides are told.
  for v_staff in
    select distinct m.person_id from app.memberships m
    where m.org_id = v_partner and m.deleted_at is null and m.valid_from <= now() and m.valid_to is null
      and private.person_capability_reach(m.person_id, v_partner, 'org.partner.manage', false) = 'organization'
  loop
    perform private.notify(v_partner, v_staff, 'partner.client_left', 'app.organizations', p_org_id, null,
      jsonb_build_object('org', v_org.name));
  end loop;
  return p_org_id;
end;
$$;

comment on function app.leave_partner(uuid, text) is 'A client org leaves its partner and becomes a direct customer (Section 4.6.1): the Owner (org.billing.manage) types the org name. The brand it renders with now becomes its own, the partner''s support sessions, standing grants and other record grants end, the partner''s price for it is removed, it stops being a client, and the partner-billed subscription ends with a 14-day trial of the same plan that converts once a card is added (Access stays Access). Data and members are untouched; the partner''s staff are told. Returns the org id.';
revoke all on function app.leave_partner(uuid, text) from public, anon;
grant execute on function app.leave_partner(uuid, text) to authenticated, service_role;

insert into private.retention_policies (table_name, basis, time_column, retention, purge_method, rationale) values
  ('app.partner_standing_grants', 'Age', 'created_at', interval '7 years', 'Delete', 'Partner access to client data is an access record (Section 4.6.1, Section 8.4).');

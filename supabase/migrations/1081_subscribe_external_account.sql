-- 1081_subscribe_external_account.sql
-- A38 (RRR-82), journey 60 (Section 20.2): a vendor company with an external account subscribes and
-- starts using Atlas, and its organization record, profile, ratings and history carry over with no
-- duplicate. Until now the only way into Atlas was app.create_organization, which makes a new
-- organization row, so the company's counterparties, engagements and ratings stayed on the old one.
--
-- app.subscribe_external_account turns the external account itself into a subscribed org: the
-- caller must be its Account Owner, the account must have no live subscription, and the call adds an
-- Access subscription and makes the caller the org's Owner. The organization row, its slug, its
-- account members and every counterparty row other orgs hold for it are untouched, so nothing is
-- copied and nothing is duplicated. app.my_subscribable_accounts lists the accounts the caller could
-- subscribe this way, for the Atlas organization step.

create or replace function app.my_subscribable_accounts()
returns table (id uuid, name text, slug text)
language sql
stable
security definer
set search_path = ''
as $$
  select o.id, o.name, o.slug
  from app.organizations o
  where o.deleted_at is null
    and o.id in (select private.my_account_ids(array['Account Owner']::app.account_role[]))
    and not exists (select 1 from app.subscriptions s where s.org_id = o.id and s.deleted_at is null)
  order by o.name;
$$;

comment on function app.my_subscribable_accounts() is 'External accounts the caller owns (Account Owner) that have no subscription yet: the companies they could start using in Atlas without creating a second organization (journey 60).';
revoke all on function app.my_subscribable_accounts() from public, anon;
grant execute on function app.my_subscribable_accounts() to authenticated, service_role;

create or replace function app.subscribe_external_account(p_account_id uuid)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
begin
  if p_account_id is null
     or p_account_id not in (select private.my_account_ids(array['Account Owner']::app.account_role[])) then
    raise exception using errcode = '42501', message = 'only the account''s Account Owner subscribes it';
  end if;
  perform 1 from app.organizations o where o.id = p_account_id and o.deleted_at is null for update;
  if exists (select 1 from app.subscriptions s where s.org_id = p_account_id and s.deleted_at is null) then
    perform private.refuse('account_already_subscribed', 'This company already uses Atlas; open it from the organization switcher.');
  end if;
  perform private.create_subscription(p_account_id, 'access');

  perform private.begin_trusted_operation('membership_write');
  with m as (
    insert into app.memberships (org_id, person_id) values (p_account_id, v_person) returning id
  )
  insert into app.membership_roles (membership_id, role_id, granted_by)
  select m.id, private.system_role_id('owner'), null from m;
  perform private.end_trusted_operation('membership_write');
  return p_account_id;
end;
$$;

comment on function app.subscribe_external_account(uuid) is 'Journey 60: the Account Owner of an external account starts using Atlas with it. Adds an Access subscription and makes the caller the Owner of the same organization row, so its profile, ratings, engagements and counterparty history carry over with no duplicate. Refuses account_already_subscribed (XR001) for an org that already subscribes; anyone but an Account Owner gets 42501.';
revoke all on function app.subscribe_external_account(uuid) from public, anon;
grant execute on function app.subscribe_external_account(uuid) to authenticated, service_role;

-- 1353_dunning_read_only.sql
-- A79 (RRR-124), finding A65-015, Section 16: "The org becomes read-only on day 21, with a banner to every Owner and
-- Admin. Data is never deleted for non-payment."
--   * private.run_dunning (0560) moves the subscription to read_only on day 21 and tells the billing owners, but nothing
--     refused writes. private.org_read_only_reason now names dunning while the org's subscription is read_only, so the
--     row guard of 1063 refuses a person's writes with the reason and the fix. Billing (the service role) still writes,
--     so a recovered payment restores writes at once.
--   * app.org_banner_status: one call for every org banner Atlas shows above each page: the read-only reason with its
--     dates, the running trial, and the dunning state with the day it began. Owners and Admins (org.settings.read) see
--     the dunning state from day 0; everyone sees it once the org is read-only, because their writes are refused.

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
  end;
$$;

comment on function private.org_read_only_reason(uuid) is 'Why an org is read-only: deletion while a deletion request waits out its recovery window, canceled during a cancellation (Section 14.7), dunning from day 21 of a failed payment (Section 16), or null when it is writable. Takes the org id as an argument (ADR 0016 rule 14).';

comment on function private.org_read_only(uuid) is 'True while an org is read-only: canceled and not reactivated, waiting for deletion and not recovered (Section 14.7), or past day 21 of dunning (Section 16). Takes the org id as an argument (ADR 0016 rule 14).';

create or replace function private.refuse_read_only_org()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := ((case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end) ->> 'org_id')::uuid;
  v_reason text;
begin
  if private.current_person_id() is null or v_org is null then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  v_reason := private.org_read_only_reason(v_org);
  if v_reason = 'deletion' then
    perform private.refuse('org_read_only', 'This organization is waiting to be deleted and is read-only. The Owner can recover it in Settings, Danger zone, during the 7 days.');
  elsif v_reason = 'canceled' then
    perform private.refuse('org_read_only', 'This organization is canceled and read-only. The Owner can reactivate it in Settings, Danger zone, during the 30 days.');
  elsif v_reason = 'dunning' then
    perform private.refuse('org_read_only', 'This organization is read-only because a payment is overdue. An Owner can update the payment method in Settings, Billing and plan; no data is deleted.');
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

comment on function private.refuse_read_only_org() is 'Refuses a person''s write to a row of a read-only org: canceled, waiting for deletion (Section 14.7) or past day 21 of dunning (Section 16), each with its fix. Workers, billing and retention (no person) still write.';

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
  white_label_until timestamptz
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
    null::timestamptz;
end;
$$;

comment on function app.org_banner_status(uuid) is 'Everything the org banners show, in one call, for an active member: why the org is read-only with its dates (cancellation, deletion request, dunning), the running trial and its end, the dunning state and when the payment first failed (Owners and Admins from day 0, everyone once the org is read-only), and until when a downgraded org keeps its white label (1355).';
revoke all on function app.org_banner_status(uuid) from public, anon;
grant execute on function app.org_banner_status(uuid) to authenticated, service_role;

revoke all on function private.past_due_since(uuid) from public, anon, authenticated;

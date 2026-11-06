-- 6142_console_billing_alerts.sql
-- Legal billing issue 1 (RRR-248, ADR 0161): the operator console lists open billing alerts, so the platform owner can see
-- them whether or not the email reached anyone, and closes one once it is dealt with, such as a charge refunded by hand.

create or replace function app.console_billing_alerts(p_limit integer default 100)
returns table (
  alert_id uuid,
  alert_kind text,
  subject_org_id uuid,
  org_name text,
  stripe_subscription_id text,
  detail text,
  raised_at timestamptz,
  occurrences integer,
  sent_at timestamptz
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  perform private.require_platform_operator('tenants.read');
  return query
    select a.id, a.alert_kind, a.subject_org_id,
      coalesce(o.name, (select c.org_name from private.stripe_cancellations c where c.subject_org_id = a.subject_org_id and c.org_name is not null order by c.created_at desc limit 1)),
      a.stripe_subscription_id, a.detail, a.raised_at, a.occurrences, a.sent_at
    from private.billing_alerts a
    left join app.organizations o on o.id = a.subject_org_id
    where a.resolved_at is null
    order by a.raised_at desc
    limit greatest(1, least(coalesce(p_limit, 100), 200));
end;
$$;

comment on function app.console_billing_alerts(integer) is 'Open billing alerts for the operator console (tenants.read), newest first, with the org''s name even after its purge.';
revoke all on function app.console_billing_alerts(integer) from public, anon;
grant execute on function app.console_billing_alerts(integer) to authenticated;

create or replace function app.console_resolve_billing_alert(p_alert_id uuid, p_reason text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_operator uuid := private.require_platform_operator('plans.write');
  v_alert private.billing_alerts;
begin
  if p_reason is null or char_length(btrim(p_reason)) not between 1 and 500 then
    perform private.refuse('billing_alert_reason', 'Say what was done about it, in up to 500 characters.');
  end if;
  update private.billing_alerts a set resolved_at = now()
  where a.id = p_alert_id and a.resolved_at is null
  returning a.* into v_alert;
  if v_alert.id is null then
    perform private.refuse('billing_alert_unknown', 'This alert is already closed.');
  end if;
  perform private.log_operator_action('billing_alert.resolved',
    (select o.id from app.organizations o where o.id = v_alert.subject_org_id), 'private.billing_alerts', v_alert.id, p_reason,
    jsonb_build_object('kind', v_alert.alert_kind, 'stripe_subscription_id', v_alert.stripe_subscription_id, 'operator', v_operator));
  return v_alert.id;
end;
$$;

comment on function app.console_resolve_billing_alert(uuid, text) is 'An operator (plans.write) closes a billing alert with what was done about it, such as refunding a charge. It lands in the console ledger. Returns the alert id.';
revoke all on function app.console_resolve_billing_alert(uuid, text) from public, anon;
grant execute on function app.console_resolve_billing_alert(uuid, text) to authenticated;

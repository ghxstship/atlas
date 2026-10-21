-- 1393_notification_sender_fixes.sql
-- Orchestrator block (ADR 0022, 1390 to 1399), RRR-125. Fixes to the notification dispatcher and the push and SMS
-- senders of A80 (1361, 1367) found by the batch-c audit. Each function below starts from its latest definition
-- (named in its section) and keeps every behavior later migrations added.
--   1. A Twilio status callback settles every delivery its text carried, so all the held texts of a summary
--      (record_sms_summary writes one SID on each) become Delivered or Bounced, not only the newest.
--   2. Held texts sent as a summary honor a category-scoped SMS suppression, as single texts do.

-- 1. Status callbacks settle every delivery of the text (from 1361) ----------------------------------------------------

create or replace function app.record_sms_status(p_provider_message_id text, p_status text, p_error text default null)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if p_provider_message_id is null or not exists (
    select 1 from app.notification_deliveries d where d.channel = 'SMS' and d.provider_message_id = p_provider_message_id) then
    return false;
  end if;
  -- A summary text carries several held deliveries under one SID (1367); its status settles all of them.
  if p_status = 'delivered' then
    update app.notification_deliveries set message_status = 'Delivered'
    where channel = 'SMS' and provider_message_id = p_provider_message_id and message_status in ('Sent', 'Delivered');
  elsif p_status in ('undelivered', 'failed') then
    update app.notification_deliveries set message_status = 'Bounced', last_error = left(coalesce(p_error, p_status), 2000)
    where channel = 'SMS' and provider_message_id = p_provider_message_id and message_status in ('Sent', 'Delivered');
  end if;
  return true;
end;
$$;

comment on function app.record_sms_status(text, text, text) is 'SMS webhook API (service role): records a Twilio status callback by message SID for every delivery the text carried, all the held texts of a summary included (1393). delivered marks them Delivered; undelivered and failed mark them Bounced with the carrier error (a retry would fail the same way). Other statuses change nothing. Returns false for an unknown SID.';

-- 2. Summaries honor category-scoped suppressions (from 1367) ----------------------------------------------------------

create or replace function app.claim_sms_summaries(p_limit integer default 50)
returns table (
  org_id uuid, recipient_person_id uuid, address text, delivery_ids uuid[], held_count integer,
  kind text, message_args jsonb
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_group record;
  v_person uuid;
  v_active boolean;
  v_project uuid;
  v_quiet timestamptz;
  v_address text;
  v_reason text;
  v_ids uuid[];
  v_drop uuid[];
  v_top record;
begin
  for v_group in
    select q.org_id, q.membership_id from app.sms_summary_queue q
    where q.sent_at is null and q.deleted_at is null and q.due_at <= now()
    group by q.org_id, q.membership_id
    order by min(q.due_at)
    limit least(greatest(p_limit, 1), 200)
  loop
    select array_agg(q.notification_delivery_id order by q.notification_created_at) into v_ids
    from (select q2.notification_delivery_id, q2.notification_created_at from app.sms_summary_queue q2
          where q2.org_id = v_group.org_id and q2.membership_id = v_group.membership_id
            and q2.sent_at is null and q2.deleted_at is null and q2.due_at <= now()
          for update skip locked) q;
    if v_ids is null then
      continue;
    end if;
    select m.person_id, (m.deleted_at is null and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now()))
    into v_person, v_active from app.memberships m where m.id = v_group.membership_id;
    select n.project_id into v_project from app.notification_deliveries d
    join app.notifications n on n.id = d.notification_id and n.created_at = d.notification_created_at
    where d.id = any (v_ids) order by n.created_at desc limit 1;

    v_reason := null;
    v_address := private.recipient_address(v_person, 'SMS');
    if not coalesce(v_active, false) then
      v_reason := 'Recipient no longer belongs to the org.';
    else
      -- The member may have moved their quiet hours or their zone since the texts were held.
      v_quiet := private.sms_quiet_until(v_group.membership_id, v_project, now());
      if v_quiet is not null then
        update app.sms_summary_queue set due_at = v_quiet
        where notification_delivery_id = any (v_ids) and sent_at is null;
        continue;
      end if;
      if v_address is null then
        v_reason := 'No verified address on the channel.';
      elsif exists (select 1 from app.suppression_list s
                    where s.org_id = v_group.org_id and s.channel = 'SMS' and s.address = v_address and s.lifted_at is null
                      and s.deleted_at is null
                      and (s.reason in ('Hard Bounce', 'Complaint', 'STOP', 'Manual') or s.category_code is null)) then
        v_reason := 'Address is on the suppression list.';
      elsif not coalesce((select c.may_text from app.sms_consent_status c
                          where c.org_id = v_group.org_id and c.phone_e164 = v_address), false) then
        v_reason := 'No SMS consent for the number.';
      end if;
    end if;
    if v_reason is not null then
      update app.notification_deliveries set message_status = 'Suppressed', last_error = v_reason where id = any (v_ids);
      update app.sms_summary_queue set sent_at = now() where notification_delivery_id = any (v_ids) and sent_at is null;
      continue;
    end if;

    -- A suppression limited to a category (an unsubscribe from it) drops the held texts of that category, as
    -- app.claim_notification_deliveries does for a single text; they neither count nor become the summary's line.
    select array_agg(d.id) into v_drop
    from app.notification_deliveries d
    join app.notifications n on n.id = d.notification_id and n.created_at = d.notification_created_at
    join private.notification_templates t on t.kind = n.kind and t.channel = 'SMS'
    left join private.email_templates e on e.code = t.email_template_code
    where d.id = any (v_ids)
      and not coalesce(e.transactional, false)
      and exists (select 1 from app.suppression_list s
                  where s.org_id = v_group.org_id and s.channel = 'SMS' and s.address = v_address and s.lifted_at is null
                    and s.deleted_at is null and s.category_code = t.category_code);
    if v_drop is not null then
      update app.notification_deliveries set message_status = 'Suppressed', last_error = 'Address is on the suppression list.'
      where id = any (v_drop);
      update app.sms_summary_queue set sent_at = now() where notification_delivery_id = any (v_drop) and sent_at is null;
      v_ids := array(select u.x from unnest(v_ids) with ordinality u(x, i) where u.x <> all (v_drop) order by u.i);
      if cardinality(v_ids) = 0 then
        continue;
      end if;
    end if;

    -- The most important held text: an urgent category first, then the latest.
    select n.kind, n.message_args into v_top
    from app.notification_deliveries d
    join app.notifications n on n.id = d.notification_id and n.created_at = d.notification_created_at
    join private.notification_templates t on t.kind = n.kind and t.channel = 'SMS'
    join private.notification_categories c on c.code = t.category_code
    where d.id = any (v_ids)
    order by c.urgent desc, n.created_at desc
    limit 1;

    -- Claimed: due again in 10 minutes unless the outcome is recorded.
    update app.sms_summary_queue set due_at = now() + interval '10 minutes'
    where notification_delivery_id = any (v_ids) and sent_at is null;
    update app.notification_deliveries set attempt_count = attempt_count + 1 where id = any (v_ids);

    org_id := v_group.org_id;
    recipient_person_id := v_person;
    address := v_address;
    delivery_ids := v_ids;
    held_count := cardinality(v_ids);
    kind := v_top.kind;
    message_args := v_top.message_args;
    return next;
  end loop;
end;
$$;

comment on function app.claim_sms_summaries(integer) is 'SMS sender API (service role): claims the members whose held texts are due (their quiet hours ended), one row per member and org with every held delivery, the count and the most important text (an urgent category first, then the latest). Holds again a member still inside quiet hours, and suppresses, with the reason, the held texts of someone who left the org, lost their verified number, is suppressed or withdrew consent. A suppression limited to a category drops only the held texts of that category (1393). A claimed summary is due again after 10 minutes unless its outcome is recorded.';

-- Privileges (create or replace keeps them; restated for review) -------------------------------------------------------

revoke all on function app.record_sms_status(text, text, text) from public, anon, authenticated;
grant execute on function app.record_sms_status(text, text, text) to service_role;
revoke all on function app.claim_sms_summaries(integer) from public, anon, authenticated;
grant execute on function app.claim_sms_summaries(integer) to service_role;

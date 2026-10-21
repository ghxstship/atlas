-- 1366_sms_consent_capture.sql
-- A80 (RRR-125), finding A65-012, Section 14.5 (TCPA and 10DLC: express consent capture). The SMS sender texts
-- only numbers with recorded consent in the org (app.sms_consent_status, 0501), but nothing in the apps let a
-- person give or withdraw it. Personal settings, Notifications now asks, and these RPCs record the answer
-- against the person's verified sign-in phone, never a typed number:
--   * app.my_sms_status: the verified phone and whether the org may text it
--   * app.record_my_sms_consent: an Opt In or Opt Out event (source Web) for that phone in the org; an Opt In
--     also lifts a STOP suppression the person placed by text, since they asked for texts again

create or replace function app.my_sms_status(p_org_id uuid)
returns table (phone_e164 text, may_text boolean)
language sql
stable
security definer
set search_path = ''
as $$
  with phone as (
    select private.recipient_address(private.current_person_id(), 'SMS') as phone_e164
    where private.my_membership_in(p_org_id) is not null
  )
  select phone.phone_e164,
    coalesce((select c.may_text from app.sms_consent_status c where c.org_id = p_org_id and c.phone_e164 = phone.phone_e164), false)
      and not exists (select 1 from app.suppression_list s where s.org_id = p_org_id and s.channel = 'SMS'
                      and s.address = phone.phone_e164 and s.lifted_at is null and s.deleted_at is null)
  from phone;
$$;

comment on function app.my_sms_status(uuid) is 'The signed-in member''s verified sign-in phone (E.164, null without one) and whether the org may text it: consent recorded and no suppression (Section 14.5). Empty for someone who is not a member.';

create or replace function app.record_my_sms_consent(p_org_id uuid, p_consent boolean)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
  v_phone text;
begin
  perform private.require_membership_in(p_org_id);
  v_phone := private.recipient_address(v_person, 'SMS');
  if v_phone is null then
    perform private.refuse('sms_phone_unverified', 'Verify a phone number on your account before turning on texts.');
  end if;
  insert into app.sms_consent_events (org_id, person_id, phone_e164, action, source)
  values (p_org_id, v_person, v_phone, (case when p_consent then 'Opt In' else 'Opt Out' end)::app.sms_consent_action, 'Web');
  if p_consent then
    update app.suppression_list set lifted_at = now()
    where org_id = p_org_id and channel = 'SMS' and address = v_phone and reason = 'STOP' and lifted_at is null and deleted_at is null;
  end if;
end;
$$;

comment on function app.record_my_sms_consent(uuid, boolean) is 'Records the signed-in member''s express consent to texts in an org, or its withdrawal, for their verified sign-in phone (TCPA, Section 14.5). Consenting again lifts a STOP the person sent. Refused without a verified phone.';

revoke all on function app.my_sms_status(uuid) from public, anon;
grant execute on function app.my_sms_status(uuid) to authenticated;
revoke all on function app.record_my_sms_consent(uuid, boolean) from public, anon;
grant execute on function app.record_my_sms_consent(uuid, boolean) to authenticated;

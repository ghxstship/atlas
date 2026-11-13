-- 4.13, block 01 (RRR-266): START by text turns texts back on only where a texted STOP turned them off.
-- Until now app.record_sms_keyword (1361) recorded an Opt In for every org that had ever logged a consent event for
-- the number. Because app.sms_consent_status (0501) reads the latest decision, START quietly turned texts back on for
-- an org the person had turned off in Personal settings (source Web, 1366), and for an org they never agreed to that
-- only held a HELP or STOP event. Express consent is given per org (TCPA, Section 14.5), so START now reverses only
-- the texted opt-outs: in each org it records an Opt In and lifts the STOP suppression when the latest decision is an
-- Opt Out that came by text and the latest decision before those texted opt-outs was an Opt In. STOP and HELP still
-- reach every org that has a consent event for the number. The arguments and the return value are unchanged.

create or replace function app.record_sms_keyword(p_phone_e164 text, p_action app.sms_consent_action, p_keyword text)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_org uuid;
  v_person uuid;
  v_count integer := 0;
begin
  if p_phone_e164 is null or p_phone_e164 !~ '^\+[1-9][0-9]{6,14}$' then
    perform private.refuse('sms_phone_invalid', 'The number is not in E.164 format.');
  end if;
  select p.id into v_person from auth.users u join app.people p on p.user_id = u.id
  where '+' || ltrim(u.phone, '+') = p_phone_e164 and u.phone_confirmed_at is not null
  limit 1;
  for v_org in select distinct e.org_id from app.sms_consent_events e where e.phone_e164 = p_phone_e164 and e.deleted_at is null loop
    if p_action = 'Opt In' and not (
      -- The org's current decision is a texted opt-out ...
      coalesce((select e.action = 'Opt Out' and e.source = 'SMS' from app.sms_consent_events e
                where e.org_id = v_org and e.phone_e164 = p_phone_e164 and e.action in ('Opt In', 'Opt Out') and e.deleted_at is null
                order by e.occurred_at desc, e.id desc limit 1), false)
      -- ... and before the texted opt-outs the person had agreed.
      and coalesce((select e.action = 'Opt In' from app.sms_consent_events e
                    where e.org_id = v_org and e.phone_e164 = p_phone_e164 and e.deleted_at is null
                      and (e.action = 'Opt In' or (e.action = 'Opt Out' and e.source <> 'SMS'))
                    order by e.occurred_at desc, e.id desc limit 1), false)
    ) then
      continue;
    end if;
    insert into app.sms_consent_events (org_id, person_id, phone_e164, action, keyword, source)
    values (v_org, v_person, p_phone_e164, p_action, left(upper(btrim(p_keyword)), 20), 'SMS');
    if p_action = 'Opt Out' then
      insert into app.suppression_list (org_id, channel, address, reason)
      select v_org, 'SMS', p_phone_e164, 'STOP'
      where not exists (select 1 from app.suppression_list s where s.org_id = v_org and s.channel = 'SMS' and s.address = p_phone_e164
                        and s.reason = 'STOP' and s.lifted_at is null and s.deleted_at is null);
    elsif p_action = 'Opt In' then
      update app.suppression_list set lifted_at = now()
      where org_id = v_org and channel = 'SMS' and address = p_phone_e164 and reason = 'STOP' and lifted_at is null and deleted_at is null;
    end if;
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

comment on function app.record_sms_keyword(text, app.sms_consent_action, text) is 'SMS webhook API (service role): records an inbound keyword (TCPA and 10DLC, Section 14.5). STOP and its synonyms record an Opt Out and the STOP suppression in every org that has a consent event for the number; HELP is recorded there as a Help event. START records an Opt In and lifts the STOP suppression only in an org whose texts a texted STOP turned off after the person agreed (904130101): an org the person turned off in settings, or never agreed to, stays off. Returns how many orgs it touched.';

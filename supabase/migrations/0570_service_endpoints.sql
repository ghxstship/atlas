-- 0570_service_endpoints.sql
-- A18 Platform Services. Service-role RPCs the Edge Functions call through the API (the private schema is
-- never exposed):
--   * app.reply_address_local_part: the signed reply address of a notification email (Section 4.6.5)
--   * one-click unsubscribe (Section 14.5 CAN-SPAM and CASL, RFC 8058): a token signed per org, person and
--     category, and the RPC that turns it into a suppression list entry

create or replace function app.reply_address_local_part(p_person_id uuid, p_subject_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select private.reply_local_part(p_person_id, p_subject_id);
$$;

comment on function app.reply_address_local_part(uuid, uuid) is 'Email dispatch API (service role): the local part of the reply address signed for one person and one thread.';

create or replace function private.unsubscribe_signature(p_org_id uuid, p_person_id uuid, p_category text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select left(encode(extensions.hmac(convert_to('unsubscribe.' || p_org_id::text || '.' || p_person_id::text || '.' || p_category, 'UTF8'),
    convert_to((select s.decrypted_secret from vault.decrypted_secrets s where s.name = 'xos_inbound_reply_secret'), 'UTF8'), 'sha256'), 'hex'), 32);
$$;

comment on function private.unsubscribe_signature(uuid, uuid, text) is 'HMAC-SHA256 signature binding an unsubscribe link to one org, person and category (or all), with the per-environment Vault secret.';

create or replace function app.unsubscribe_token(p_org_id uuid, p_person_id uuid, p_category text)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_category <> 'all' and p_category not in (select c.code from private.notification_categories c) then
    perform private.refuse('notification_category_unknown', format('%s is not a notification category.', p_category));
  end if;
  return replace(p_org_id::text, '-', '') || '.' || replace(p_person_id::text, '-', '') || '.' || p_category || '.'
    || private.unsubscribe_signature(p_org_id, p_person_id, p_category);
end;
$$;

comment on function app.unsubscribe_token(uuid, uuid, text) is 'Email dispatch API (service role): the signed token of a one-click unsubscribe link for a person, an org and a category or all non-transactional email.';

create or replace function app.unsubscribe_by_token(p_token text)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_parts text[] := regexp_match(coalesce(p_token, ''), '^([0-9a-f]{32})\.([0-9a-f]{32})\.([a-z_]+)\.([0-9a-f]{32})$');
  v_org uuid;
  v_person uuid;
  v_category text;
  v_email text;
begin
  if v_parts is null then
    return null;
  end if;
  v_org := v_parts[1]::uuid;
  v_person := v_parts[2]::uuid;
  v_category := v_parts[3];
  if private.unsubscribe_signature(v_org, v_person, v_category) <> v_parts[4] then
    return null;
  end if;
  select lower(u.email) into v_email from auth.users u join app.people p on p.user_id = u.id where p.id = v_person;
  if v_email is null then
    return null;
  end if;
  insert into app.suppression_list (org_id, channel, address, reason, category_code)
  select v_org, 'Email', v_email, 'Unsubscribe', nullif(v_category, 'all')
  where not exists (
    select 1 from app.suppression_list s
    where s.org_id = v_org and s.channel = 'Email' and s.address = v_email and s.reason = 'Unsubscribe'
      and s.category_code is not distinct from nullif(v_category, 'all') and s.lifted_at is null and s.deleted_at is null);
  return (select o.slug from app.organizations o where o.id = v_org);
end;
$$;

comment on function app.unsubscribe_by_token(text) is 'One-click unsubscribe API (service role, called by the email-unsubscribe Edge Function for GET and RFC 8058 POST): verifies the signed token, suppresses the person''s email for the category once, and returns the org slug for the redirect to its notification settings. A bad token returns null and changes nothing.';

revoke all on function app.reply_address_local_part(uuid, uuid) from public, anon, authenticated;
grant execute on function app.reply_address_local_part(uuid, uuid) to service_role;
revoke all on function private.unsubscribe_signature(uuid, uuid, text) from public, anon, authenticated;
revoke all on function app.unsubscribe_token(uuid, uuid, text) from public, anon, authenticated;
grant execute on function app.unsubscribe_token(uuid, uuid, text) to service_role;
revoke all on function app.unsubscribe_by_token(text) from public, anon, authenticated;
grant execute on function app.unsubscribe_by_token(text) to service_role;

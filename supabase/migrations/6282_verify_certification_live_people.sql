-- 6282_verify_certification_live_people.sql
-- Owner audit of 2026-11-06 (ADR 0142): api_public.verify_certification answers only the holder's name, the certification,
-- its issuing body and its expiry, and only for the right code, a holder who consented and a certificate still current.
-- That is what a certificate check needs, so the columns stay. A removed person's certificate no longer confirms.

create or replace function api_public.verify_certification(p_verification_code text)
returns table (holder_name text, certification text, issuing_body text, expires_on date)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_client text := coalesce(host(private.request_ip()), 'unknown');
  v_found integer := 0;
begin
  if private.rate_limit_exceeded('verify_certification.failure', v_client, 10, interval '15 minutes') then
    return;
  end if;
  return query
  select p.full_name, c.name, c.issuing_body, h.expires_on
  from app.certification_holders h
  join app.certifications c on c.id = h.certification_id and c.deleted_at is null
  join app.people p on p.id = h.person_id and p.deleted_at is null
  where h.verification_code = p_verification_code and h.public_verification_consented and h.deleted_at is null
    and (h.expires_on is null or h.expires_on >= current_date);
  get diagnostics v_found = row_count;
  if v_found = 0 then
    perform private.note_rate_event('verify_certification.failure', v_client);
  end if;
end;
$$;

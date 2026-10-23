-- 1501_wallet_passes.sql
-- A93 (RRR-138, A65-011 part 4): wallet passes for credentials and shift passes (Section 11.10 item 14:
-- "Credentials and shift passes can be added to Apple Wallet and Google Wallet, and work offline"; Section
-- 11.13: the badge in one tap from the lock screen).
--
-- app.my_wallet_pass returns what one pass shows, for the signed-in person's own credential (they hold it)
-- or own shift (through their membership or their engagement), and nothing for anyone else's: a person
-- never adds another person's badge to their wallet. The wallet-pass Edge Function reads it with the
-- caller's own token, then builds and signs the Apple pass or the Google Wallet link behind its signing
-- seam (the certificates and keys are owner secrets). The credential's barcode is the same XOSCR1 payload
-- the Compass badge shows, so the gate scans a wallet pass like the badge. Nothing here writes.

create or replace function app.my_wallet_pass(p_kind text, p_id uuid)
returns table (
  kind text,
  serial text,
  org_id uuid,
  org_name text,
  accent_hex text,
  title text,
  holder_name text,
  project_name text,
  barcode text,
  starts_at timestamptz,
  ends_at timestamptz,
  time_zone text,
  voided boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select 'credential', c.id::text, c.org_id, b.name, b.accent_hex, cc.name, p.full_name, pr.name,
    'XOSCR1:' || c.credential_number, c.valid_from, c.valid_to, pr.time_zone,
    c.revoked_at is not null or (c.valid_to is not null and c.valid_to <= now())
  from app.credentials c
  join app.credential_categories cc on cc.id = c.credential_category_id
  join app.people p on p.id = c.holder_person_id
  join app.projects pr on pr.id = c.project_id
  cross join lateral private.public_brand(c.org_id) b
  where p_kind = 'credential' and c.id = p_id and c.deleted_at is null
    and c.holder_person_id = private.current_person_id()
  union all
  select 'shift', s.id::text, s.org_id, b.name, b.accent_hex, coalesce(r.job_title, s.role_code, pr.name),
    me.full_name, pr.name, null, s.starts_at, s.ends_at, s.time_zone, s.shift_state::text = 'Canceled'
  from app.shifts s
  join app.projects pr on pr.id = s.project_id
  join app.people me on me.id = private.current_person_id()
  left join xpms.role r on r.role_code = s.role_code
  cross join lateral private.public_brand(s.org_id) b
  where p_kind = 'shift' and s.id = p_id and s.deleted_at is null
    and (
      s.membership_id in (select m.id from app.memberships m where m.person_id = me.id and m.deleted_at is null)
      or s.engagement_id in (select e.id from app.engagements e where e.person_id = me.id and e.deleted_at is null)
    );
$$;

comment on function app.my_wallet_pass(text, uuid) is 'Wallet passes (Section 11.10 item 14): what an Apple or Google Wallet pass shows for the signed-in person''s own credential (kind credential, barcode the badge''s XOSCR1 payload) or own shift (kind shift, through their membership or engagement), with the org''s public brand and whether the pass is void (revoked, expired or canceled). Nothing for another person''s credential or shift.';
revoke all on function app.my_wallet_pass(text, uuid) from public, anon;
grant execute on function app.my_wallet_pass(text, uuid) to authenticated, service_role;

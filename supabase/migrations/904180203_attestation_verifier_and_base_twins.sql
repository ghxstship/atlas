-- The attestation verifier and the ungated helper twins (RRR-243; ADR 0169 work package 2, the gate core;
-- release 4.18, block 02, part 3 of 4).
--
-- 1. The attestation (ADR 0169 D3). Atlas, Gateway, Console, the XOS API and the Edge Functions that act for a
--    signed-in person prove a call is theirs with one request header, x-xos-attestation:
--
--      v1,t=<unix seconds>,a=<client address | unknown>,sid=<session id | none>,s=<64 hex characters>
--
--    s is HMAC-SHA256, in hex, of the five lines  v1 / <sub> / <sid> / <t> / <a>  joined by a line feed, under the
--    server-only key XOS_DATA_ATTEST_KEY. The database verifies it: the key matches, t is no older than five minutes
--    and no more than one minute ahead, and sub and sid are the token's own, so an attestation lifted from one
--    request is worthless under another person's or another session's token and stops working five minutes after it
--    was signed. Inside that window the same session can present it again; that is the design (ADR 0169 D3), because
--    a read-only request cannot record a nonce. The attestation never grants an identity: it states an address and
--    marks the call as server-mediated.
--
--    The key is read from Supabase Vault under the name xos_data_attest_key. The owner enters it (owner decision
--    7); no migration creates it and the repository holds no value. Local and test stacks create their own random
--    value. A second secret, xos_data_attest_key_next, is accepted beside it, so a rotation adds the new key,
--    deploys, and removes the old one with no window in which calls fail. A key shorter than 32 characters is
--    ignored. Until a key is entered no attestation verifies and every call counts as direct.
--
--    The staging probe of 2026-11-21 answered that a custom request header reaches the database whole (Q2
--    reached), so private.request_attestation reads the header as designed.
--
-- 2. The twins (ADR 0169 D6). private.my_org_ids_base, private.my_membership_ids_base and
--    private.person_capability_reach_base are new functions holding the current bodies of private.my_org_ids
--    (latest definition 1563_oauth_server.sql; 0204 before it), private.my_membership_ids (its only definition,
--    0204_access_helpers.sql) and private.person_capability_reach (latest definition 1563_oauth_server.sql; 0204,
--    0936, 1203 and 1298 before it), copied from the database after every migration to 904180101 applied. The
--    originals are not touched here: package 3 gates them, and the recovery functions of 904180204 and two read
--    policies of package 3 use the twins, so a refused session can still name its organizations.

-- The attestation -----------------------------------------------------------------------------------------------------------

create or replace function private.attestation_keys()
returns text[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(array_agg(s.decrypted_secret order by s.name), '{}'::text[])
  from vault.decrypted_secrets s
  where s.name in ('xos_data_attest_key', 'xos_data_attest_key_next')
    and char_length(s.decrypted_secret) >= 32;
$$;

comment on function private.attestation_keys() is 'The keys an attestation may be signed with (ADR 0169 D3): the Vault secrets xos_data_attest_key and, during a rotation, xos_data_attest_key_next. A value shorter than 32 characters is ignored. Empty until the owner enters the key, and then no attestation verifies.';
revoke all on function private.attestation_keys() from public, anon, authenticated;

create or replace function private.verify_attestation(p_attestation text, p_user_id uuid, p_session_id uuid)
returns table (verified boolean, client_address inet, signed_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_parts text[];
  v_signed timestamptz;
  v_sid text := coalesce(p_session_id::text, 'none');
  v_message bytea;
  v_key text;
  v_ok boolean := false;
begin
  verified := false;
  client_address := null;
  signed_at := null;
  if p_attestation is null or p_user_id is null or char_length(p_attestation) > 256 then
    return next;
    return;
  end if;
  v_parts := regexp_match(p_attestation,
    '^v1,t=([0-9]{1,11}),a=([0-9A-Fa-f:.]{2,45}|unknown),sid=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|none),s=([0-9a-f]{64})$');
  if v_parts is null or v_parts[3] <> v_sid then
    return next;
    return;
  end if;
  v_signed := to_timestamp(v_parts[1]::bigint);
  if v_signed <= now() - interval '5 minutes' or v_signed > now() + interval '1 minute' then
    return next;
    return;
  end if;
  v_message := convert_to(concat_ws(chr(10), 'v1', p_user_id::text, v_sid, v_parts[1], v_parts[2]), 'UTF8');
  -- Both sides are hashed before they are compared, so the comparison tells nothing about a partly right signature.
  foreach v_key in array private.attestation_keys() loop
    if extensions.digest(encode(extensions.hmac(v_message, convert_to(v_key, 'UTF8'), 'sha256'), 'hex'), 'sha256')
       = extensions.digest(v_parts[4], 'sha256') then
      v_ok := true;
    end if;
  end loop;
  if not v_ok then
    return next;
    return;
  end if;
  verified := true;
  client_address := case when v_parts[2] <> 'unknown' then private.safe_inet(v_parts[2]) end;
  signed_at := v_signed;
  return next;
end;
$$;

comment on function private.verify_attestation(text, uuid, uuid) is 'Verifies a server attestation (ADR 0169 D3) for one person and session: the format v1,t=,a=,sid=,s=, a signature under one of private.attestation_keys, a time no older than five minutes and no more than one minute ahead, and the session id of the token. Always one row: verified, the attested client address (NULL when the server knew none or it is not an address) and when it was signed. Reads Vault only for a well-formed, timely attestation.';
revoke all on function private.verify_attestation(text, uuid, uuid) from public, anon, authenticated;

create or replace function private.request_attestation()
returns table (verified boolean, client_address inet, signed_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select a.verified, a.client_address, a.signed_at
  from private.verify_attestation(private.request_header('x-xos-attestation'), (select auth.uid()), private.session_id()) a;
$$;

comment on function private.request_attestation() is 'The attestation on the current request, verified against the token''s own sub and session_id (ADR 0169 D3): the header x-xos-attestation. One row; verified is false for a direct call.';
revoke all on function private.request_attestation() from public, anon, authenticated;

-- The twins ---------------------------------------------------------------------------------------------------------------

create or replace function private.my_org_ids_base()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select m.org_id from app.memberships m
  where m.person_id = private.current_person_id()
    and m.deleted_at is null
    and m.valid_from <= now()
    and (m.valid_to is null or m.valid_to > now())
    and (private.oauth_client_id() is null or m.org_id = private.oauth_org_id());
$$;

comment on function private.my_org_ids_base() is 'Orgs where the signed-in person holds an active membership; for an app''s session only the org that registered the app (ADR 0055). The ungated twin of private.my_org_ids (ADR 0169 D6): it never reads the session verdict, and only the gate''s recovery functions and the read policies on app.organizations and the caller''s own app.memberships use it.';
revoke all on function private.my_org_ids_base() from public, anon;
grant execute on function private.my_org_ids_base() to authenticated, service_role;

create or replace function private.my_membership_ids_base()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select m.id from app.memberships m
  where m.person_id = private.current_person_id()
    and m.deleted_at is null
    and m.valid_from <= now()
    and (m.valid_to is null or m.valid_to > now());
$$;

comment on function private.my_membership_ids_base() is 'Active memberships of the signed-in person. The ungated twin of private.my_membership_ids (ADR 0169 D6): it never reads the session verdict, and only the gate''s recovery functions and the read policies on app.organizations and the caller''s own app.memberships use it.';
revoke all on function private.my_membership_ids_base() from public, anon;
grant execute on function private.my_membership_ids_base() to authenticated, service_role;

create or replace function private.person_capability_reach_base(p_person_id uuid, p_org_id uuid, p_capability text, p_include_delegations boolean)
returns app.capability_reach
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_person_id is null or p_org_id is null then
    return null;
  end if;
  -- A22-001: an API-key session reaches only the capability groups in the key's scopes.
  if p_person_id = private.current_person_id()
     and private.api_key_scopes() is not null
     and not (split_part(p_capability, '.', 1) = any (private.api_key_scopes())) then
    return null;
  end if;
  -- A99 (ADR 0055): an app's session reaches only the org that registered the app.
  if p_person_id = private.current_person_id()
     and private.oauth_client_id() is not null
     and p_org_id is distinct from private.oauth_org_id() then
    return null;
  end if;
  return (
    select max(s.reach) from (
      select rc.reach
      from app.memberships m
      join app.membership_roles mr on mr.membership_id = m.id and mr.deleted_at is null
      join app.roles r on r.id = mr.role_id and r.deleted_at is null
      join app.role_capabilities rc on rc.role_id = r.id and rc.deleted_at is null
      where m.person_id = p_person_id and m.org_id = p_org_id
        and m.deleted_at is null and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now())
        and rc.capability_code = p_capability
      union all
      select 'organization'::app.capability_reach
      from app.user_capability_grants g
      join app.memberships m on m.id = g.membership_id
      where m.person_id = p_person_id and m.org_id = p_org_id
        and m.deleted_at is null and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now())
        and g.capability_code = p_capability and g.scope_id is null and g.deleted_at is null
        and g.valid_from <= now() and (g.valid_to is null or g.valid_to > now())
      union all
      select 'organization'::app.capability_reach
      from app.record_grants rg
      where rg.org_id = p_org_id and rg.target_kind = 'organization' and rg.target_id = p_org_id
        and rg.capability_code = p_capability and rg.deleted_at is null
        and rg.valid_from <= now() and rg.valid_to > now()
        and (rg.grantee_person_id = p_person_id
             or rg.grantee_org_id in (select private.person_org_ids(p_person_id)))
      union all
      -- 1203: an open break-glass session (Section 8.4) reaches the Owner role's capabilities org-wide, while the
      -- membership is active. 1298 (A69-009): only for the holder themself, in a second-factor session that is not an
      -- API key, so it never reaches a delegate or another session of the holder.
      select 'organization'::app.capability_reach
      from app.break_glass_sessions b
      join app.memberships m on m.person_id = b.person_id and m.org_id = b.org_id
      join app.role_capabilities rc on rc.capability_code = p_capability and rc.deleted_at is null
        and rc.reach = 'organization'
        and rc.role_id = (select r.id from app.roles r where r.org_id is null and r.code = 'owner')
      where b.person_id = p_person_id and b.org_id = p_org_id and b.deleted_at is null
        and b.started_at <= now() and b.expires_at > now() and b.ended_at is null
        and m.deleted_at is null and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now())
        and p_person_id = private.current_person_id()
        and private.session_aal() = 'aal2'
        and private.api_key_scopes() is null
      union all
      select private.person_capability_reach_base(dm.person_id, p_org_id, p_capability, false)
      from app.delegations d
      join app.memberships em on em.id = d.delegate_membership_id
      join app.memberships dm on dm.id = d.delegator_membership_id
      where p_include_delegations
        and d.org_id = p_org_id and d.deleted_at is null
        and d.valid_from <= now() and d.valid_to > now()
        and em.person_id = p_person_id
        and em.deleted_at is null and em.valid_from <= now() and (em.valid_to is null or em.valid_to > now())
        and dm.deleted_at is null and dm.valid_from <= now() and (dm.valid_to is null or dm.valid_to > now())
        and (d.capability_code = p_capability
             or (d.capability_code is null and exists (
               select 1 from app.capabilities c where c.code = p_capability and c.capability_class = 'approve')))
    ) s
  );
end;
$$;

comment on function private.person_capability_reach_base(uuid, uuid, text, boolean) is 'The widest reach a person holds for a capability in an org, through roles, direct grants, an organization record grant, the holder''s own open break-glass session at aal2, and delegations. The ungated twin of private.person_capability_reach (ADR 0169 D6): it never reads the session verdict, its delegation branch calls itself, and only the gate''s recovery functions use it.';
revoke all on function private.person_capability_reach_base(uuid, uuid, text, boolean) from public, anon, authenticated;

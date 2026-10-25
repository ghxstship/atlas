-- 2011_supplier_certificate_number_encryption.sql
-- A100 (RRR-145), trace row S9-12. 1464 classified a supplier diversity certificate number as a Restricted government
-- identifier (data.restricted.read.government_id) but stored it in plain text, and handed it whole to every org reader
-- holding that capability. It now follows the passport number of 1340, the government identifier rule of decision 38
-- (ADR 0033), and the key handling of decision 49:
--   * the number is encrypted with pgp_sym_encrypt under its own Vault key, xos_supplier_certificate_number_key; its
--     last four letters or digits sit beside it in certificate_number_last4 (Confidential), as passport_number_last4
--     does
--   * nobody signed in selects or writes the ciphertext. The owner sets or clears it through
--     app.set_supplier_diversity_certificate_number, which keeps its letters and digits; the owner still sees only the
--     last four (1464: write-only to the owner)
--   * an org reads shared certifications through app.shared_supplier_diversity with the number masked to its last four
--     for every reader. The whole number leaves only through app.reveal_shared_supplier_diversity_number: a live share
--     with an org running its program, vendors.vendor.read and data.restricted.read.government_id in that org, step-up
--     (aal2) and a written reason, logged with the reason in the owner's access log and the org's audit ledger
--   * existing numbers are encrypted in place (private.encrypt_column_in_place, 2010) as stored; their last four is
--     derived from their letters and digits, and a number with none (only punctuation) identifies nothing and is
--     cleared. Neither counts as the owner's edit, so the access log gains no rows

do $$
begin
  if not exists (select 1 from vault.secrets where name = 'xos_supplier_certificate_number_key') then
    perform vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'xos_supplier_certificate_number_key',
      'Symmetric key that encrypts supplier diversity certificate numbers on app.supplier_diversity_certifications (Sections 8.3 and 9).');
  end if;
end $$;

create or replace function private.supplier_certificate_number_key()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select s.decrypted_secret from vault.decrypted_secrets s where s.name = 'xos_supplier_certificate_number_key';
$$;

comment on function private.supplier_certificate_number_key() is 'The Vault key that encrypts supplier diversity certificate numbers. Never granted to signed-in callers.';
revoke all on function private.supplier_certificate_number_key() from public, anon, authenticated;

-- The certificate number ------------------------------------------------------------------------------------------------

alter table app.supplier_diversity_certifications add column certificate_number_last4 text;
-- 1464's length check reads the plain text; the ciphertext gets the pair and format checks below instead.
alter table app.supplier_diversity_certifications drop constraint supplier_diversity_certifications_number;

alter table app.supplier_diversity_certifications disable trigger user;
update app.supplier_diversity_certifications c set
  certificate_number = case when regexp_replace(c.certificate_number, '[^0-9A-Za-z]', '', 'g') <> '' then c.certificate_number end,
  certificate_number_last4 = nullif(right(upper(regexp_replace(c.certificate_number, '[^0-9A-Za-z]', '', 'g')), 4), '')
where c.certificate_number is not null;
alter table app.supplier_diversity_certifications enable trigger user;

call private.encrypt_column_in_place('app.supplier_diversity_certifications', 'certificate_number', 'xos_supplier_certificate_number_key');

alter table app.supplier_diversity_certifications
  add constraint supplier_diversity_certifications_last4 check (certificate_number_last4 is null or certificate_number_last4 ~ '^[0-9A-Z]{1,4}$'),
  add constraint supplier_diversity_certifications_number_pair check ((certificate_number is null) = (certificate_number_last4 is null));

call private.describe('app.supplier_diversity_certifications', 'Self-declared supplier diversity certifications (Section 4.4.1) of a person or an external account, used only where an org runs a supplier diversity program and shared one org at a time under separate consent (app.supplier_diversity_shares). Only the owner reads and writes them: the person, or the account''s Owner and Admin members. The certificate number is Restricted and encrypted.', array[
  'certificate_number', 'Certificate number encrypted with pgp_sym_encrypt under the Vault key xos_supplier_certificate_number_key. Restricted (data.restricted.read.government_id): never selectable or writable by signed-in callers; set by the owner through app.set_supplier_diversity_certificate_number and read whole only through the audited app.reveal_shared_supplier_diversity_number.',
  'certificate_number_last4', 'Last four letters or digits of the certificate number, shown to the owner and to the orgs it is shared with in place of the masked number; NULL when none is recorded. Set only with the number.'
]);

insert into private.column_classifications (table_name, column_name, classification, read_capability) values
  ('app.supplier_diversity_certifications', 'certificate_number_last4', 'Confidential', null);

-- The owner selects the last four; the number is written only by the RPC (the dropped column took its insert and
-- update grants with it).
grant select (certificate_number_last4) on app.supplier_diversity_certifications to authenticated;

create or replace function private.guard_supplier_diversity_certification()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and (new.person_id is distinct from old.person_id or new.account_id is distinct from old.account_id) then
    perform private.refuse('owner_immutable', 'A supplier diversity certification never moves to another owner.');
  end if;
  if new.account_id is not null and not exists (
      select 1 from app.account_memberships m where m.org_id = new.account_id and m.deleted_at is null) then
    perform private.refuse('supplier_diversity_account', 'A company declares supplier diversity certifications on its external account.');
  end if;
  if (tg_op = 'INSERT' and (new.certificate_number is not null or new.certificate_number_last4 is not null))
     or (tg_op = 'UPDATE' and (new.certificate_number is distinct from old.certificate_number
                               or new.certificate_number_last4 is distinct from old.certificate_number_last4)) then
    if not private.in_trusted_operation('supplier_certificate_number_write') then
      perform private.refuse('certificate_number_rpc_only', 'A certificate number is written only through app.set_supplier_diversity_certificate_number, which encrypts it.');
    end if;
  end if;
  new.certifying_body := btrim(new.certifying_body);
  return new;
end;
$$;

comment on function private.guard_supplier_diversity_certification() is 'Supplier diversity certifications keep their owner, belong to a person or an external account, store a trimmed certifying body, and change their certificate number and its last four only inside the encrypting RPC.';
revoke all on function private.guard_supplier_diversity_certification() from public, anon, authenticated;

create or replace function app.set_supplier_diversity_certificate_number(p_certification_id uuid, p_certificate_number text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_cert app.supplier_diversity_certifications;
  v_clean text := upper(regexp_replace(coalesce(p_certificate_number, ''), '[^0-9A-Za-z]', '', 'g'));
begin
  perform private.require_person();
  select * into v_cert from app.supplier_diversity_certifications c where c.id = p_certification_id and c.deleted_at is null;
  if v_cert.id is null or not private.owns_supplier_diversity(v_cert.person_id, v_cert.account_id) then
    perform private.refuse('supplier_diversity_not_yours', 'Only the owner sets a certificate number.');
  end if;
  if p_certificate_number is not null and char_length(v_clean) not between 1 and 100 then
    perform private.refuse('certificate_number_format', 'A certificate number has 1 to 100 letters and digits.');
  end if;
  perform private.begin_trusted_operation('supplier_certificate_number_write');
  update app.supplier_diversity_certifications c set
    certificate_number = case when p_certificate_number is null then null
                              else extensions.pgp_sym_encrypt(v_clean, private.supplier_certificate_number_key()) end,
    certificate_number_last4 = case when p_certificate_number is null then null else right(v_clean, 4) end
  where c.id = v_cert.id;
  perform private.end_trusted_operation('supplier_certificate_number_write');
end;
$$;

comment on function app.set_supplier_diversity_certificate_number(uuid, text) is 'The owner sets or clears (NULL) a supplier diversity certificate number: keeps its letters and digits, encrypts them under the Vault key and stores the last four. The owner''s access log records the change as an update, never the value.';
revoke all on function app.set_supplier_diversity_certificate_number(uuid, text) from public, anon;
grant execute on function app.set_supplier_diversity_certificate_number(uuid, text) to authenticated, service_role;

-- The owner's access log carries reveals and their reason -------------------------------------------------------------

alter table app.supplier_diversity_events
  add column reason text,
  add constraint supplier_diversity_events_reason_length check (reason is null or char_length(reason) <= 500),
  drop constraint supplier_diversity_events_action,
  add constraint supplier_diversity_events_action check (action in (
    'supplier_diversity.created', 'supplier_diversity.updated', 'supplier_diversity.removed', 'supplier_diversity.shared',
    'supplier_diversity.share_revoked', 'supplier_diversity.viewed', 'supplier_diversity.revealed'));

call private.describe('app.supplier_diversity_events', 'The owner''s access log for their supplier diversity certifications (Section 8.4 access transparency): every change they make, every share and revocation, every read by an org and every reveal of a certificate number, never a value. Written only by the database; the owner reads all of theirs and an org''s audit readers read the rows naming their org.', array[
  'action', 'What happened: created, updated, removed, shared, share_revoked, viewed or revealed.',
  'reason', 'Why an org member revealed the certificate number, as they wrote it; NULL for every other action.'
]);

drop function private.log_supplier_diversity_event(uuid, text, uuid);

create or replace function private.log_supplier_diversity_event(p_certification_id uuid, p_action text, p_org_id uuid default null,
  p_reason text default null)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  insert into app.supplier_diversity_events (supplier_diversity_certification_id, person_id, account_id, actor_person_id, org_id, action,
    request_id, reason)
  select c.id, c.person_id, c.account_id, private.current_person_id(), p_org_id, p_action, left(private.request_header('x-request-id'), 200),
    p_reason
  from app.supplier_diversity_certifications c where c.id = p_certification_id;
end;
$$;

comment on function private.log_supplier_diversity_event(uuid, text, uuid, text) is 'Writes one row to the owner''s supplier diversity access log, with the acting person and request id from the session and, for a reveal, the reason given.';
revoke all on function private.log_supplier_diversity_event(uuid, text, uuid, text) from public, anon, authenticated;

-- Read paths -------------------------------------------------------------------------------------------------------------

create or replace function app.my_supplier_diversity(p_account_id uuid default null)
returns table (
  id uuid,
  diversity_kind app.supplier_diversity_kind,
  certifying_body text,
  certificate_number_last4 text,
  issued_on date,
  expires_on date,
  evidence_path text,
  shares jsonb
)
language sql
stable
security definer
set search_path = ''
as $$
  select c.id, c.diversity_kind, c.certifying_body, c.certificate_number_last4, c.issued_on, c.expires_on, c.evidence_path,
    coalesce((select jsonb_agg(jsonb_build_object('shareId', s.id, 'orgId', s.org_id, 'orgName', o.name, 'sharedAt', s.shared_at)
                                order by o.name)
              from app.supplier_diversity_shares s join app.organizations o on o.id = s.org_id
              where s.supplier_diversity_certification_id = c.id and s.revoked_at is null and s.deleted_at is null), '[]'::jsonb)
  from app.supplier_diversity_certifications c
  where c.deleted_at is null
    and ((p_account_id is null and c.person_id = private.current_person_id())
      or (p_account_id is not null and c.account_id = p_account_id
          and p_account_id in (select private.my_account_ids(array['Account Owner', 'Account Admin']::app.account_role[]))))
  order by c.diversity_kind, c.certifying_body;
$$;

comment on function app.my_supplier_diversity(uuid) is 'The signed-in person''s own supplier diversity certifications, or an account''s they are an Owner or Admin of, with the certificate number''s last four characters (the number itself is encrypted and write-only to the owner) and the orgs each is shared with now.';
revoke all on function app.my_supplier_diversity(uuid) from public, anon;
grant execute on function app.my_supplier_diversity(uuid) to authenticated, service_role;

-- The result columns change (the whole number gives way to its last four), so the function is replaced.
drop function app.shared_supplier_diversity(uuid);

create function app.shared_supplier_diversity(p_org_id uuid)
returns table (
  share_id uuid,
  certification_id uuid,
  person_id uuid,
  person_name text,
  account_id uuid,
  account_name text,
  diversity_kind app.supplier_diversity_kind,
  certifying_body text,
  certificate_number_last4 text,
  issued_on date,
  expires_on date,
  shared_at timestamptz
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_row record;
  v_count integer := 0;
begin
  perform private.require_person();
  if not private.has_capability(p_org_id, 'vendors.vendor.read') then
    raise exception using errcode = '42501', message = 'vendors.vendor.read is required';
  end if;
  if not private.supplier_diversity_program_on(p_org_id) then
    return;
  end if;
  for v_row in
    select s.id as share_id, c.id as certification_id, c.person_id, p.full_name as person_name, c.account_id, a.name as account_name,
      c.diversity_kind, c.certifying_body, c.certificate_number_last4, c.issued_on, c.expires_on, s.shared_at
    from app.supplier_diversity_shares s
    join app.supplier_diversity_certifications c on c.id = s.supplier_diversity_certification_id and c.deleted_at is null
    left join app.people p on p.id = c.person_id
    left join app.organizations a on a.id = c.account_id
    where s.org_id = p_org_id and s.revoked_at is null and s.deleted_at is null
    order by coalesce(a.name, p.full_name), c.diversity_kind
  loop
    share_id := v_row.share_id;
    certification_id := v_row.certification_id;
    person_id := v_row.person_id;
    person_name := v_row.person_name;
    account_id := v_row.account_id;
    account_name := v_row.account_name;
    diversity_kind := v_row.diversity_kind;
    certifying_body := v_row.certifying_body;
    certificate_number_last4 := v_row.certificate_number_last4;
    issued_on := v_row.issued_on;
    expires_on := v_row.expires_on;
    shared_at := v_row.shared_at;
    perform private.log_supplier_diversity_event(v_row.certification_id, 'supplier_diversity.viewed', p_org_id);
    v_count := v_count + 1;
    return next;
  end loop;
  if v_count > 0 then
    perform private.write_audit_event(p_org_id, 'supplier_diversity.viewed', 'app.supplier_diversity_shares', null,
      jsonb_build_object('certifications', v_count));
  end if;
end;
$$;

comment on function app.shared_supplier_diversity(uuid) is 'Supplier diversity certifications shared with an org, for its members holding vendors.vendor.read, only while each share stands and the org runs a supplier diversity program (Section 4.4.1). The certificate number is a Restricted government identifier: every reader sees its last four characters, and the whole number leaves only through app.reveal_shared_supplier_diversity_number (decision 38). Every read is logged in each owner''s access log and once in the org''s audit ledger.';
revoke all on function app.shared_supplier_diversity(uuid) from public, anon;
grant execute on function app.shared_supplier_diversity(uuid) to authenticated, service_role;

create or replace function app.reveal_shared_supplier_diversity_number(p_share_id uuid, p_reason text)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_share app.supplier_diversity_shares;
  v_cert app.supplier_diversity_certifications;
begin
  perform private.require_person();
  select * into v_share from app.supplier_diversity_shares s
  where s.id = p_share_id and s.revoked_at is null and s.deleted_at is null;
  if v_share.id is null or not private.has_capability(v_share.org_id, 'vendors.vendor.read') then
    raise exception using errcode = '42501', message = 'vendors.vendor.read is required';
  end if;
  if not private.has_capability(v_share.org_id, 'data.restricted.read.government_id') then
    raise exception using errcode = '42501', message = 'data.restricted.read.government_id is required';
  end if;
  select * into v_cert from app.supplier_diversity_certifications c
  where c.id = v_share.supplier_diversity_certification_id and c.deleted_at is null;
  if v_cert.id is null or not private.supplier_diversity_program_on(v_share.org_id) then
    perform private.refuse('supplier_diversity_not_shared', 'This certification is not shared with the organization.');
  end if;
  perform private.require_second_factor('reveal a certificate number', false);
  if char_length(btrim(coalesce(p_reason, ''))) < 10 then
    perform private.refuse('certificate_reveal_reason', 'Write why you need the certificate number, in at least 10 characters.');
  end if;
  if v_cert.certificate_number is null then
    perform private.refuse('certificate_number_missing', 'No certificate number is recorded.');
  end if;
  perform private.log_supplier_diversity_event(v_cert.id, 'supplier_diversity.revealed', v_share.org_id, left(btrim(p_reason), 500));
  perform private.write_audit_event(v_share.org_id, 'supplier_diversity.number_revealed', 'app.supplier_diversity_shares', v_share.id,
    jsonb_build_object('reason', left(btrim(p_reason), 500)));
  return extensions.pgp_sym_decrypt(v_cert.certificate_number, private.supplier_certificate_number_key());
end;
$$;

comment on function app.reveal_shared_supplier_diversity_number(uuid, text) is 'The explicit reveal of a shared supplier diversity certificate number to a member of the org it is shared with (decision 38): needs a live share with an org that runs a supplier diversity program, vendors.vendor.read and data.restricted.read.government_id in that org, step-up authentication (aal2) and a written reason. Logged with the reason, never the value, in the owner''s access log and the org''s audit ledger.';
revoke all on function app.reveal_shared_supplier_diversity_number(uuid, text) from public, anon;
grant execute on function app.reveal_shared_supplier_diversity_number(uuid, text) to authenticated, service_role;

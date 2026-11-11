-- 2350_supplier_diversity_add_with_number.sql
-- A100 (RRR-145), follow-up to 2011. Declaring a certification with a certificate number took two requests: an insert
-- through row level security, then app.set_supplier_diversity_certificate_number on the new row. When the second
-- request failed (a refusal, a timeout, a dropped connection) the certification stayed without its number, the owner
-- saw an error and a resubmit declared it twice. Every number set that way also logged a spurious
-- 'supplier_diversity.updated' in the owner's access log and, for a company, its audit ledger.
--   * app.add_supplier_diversity_certification declares a certification and its number in one call and one INSERT:
--     the number is checked first (letters and digits, 1 to 100), then encrypted under the Vault key inside the
--     supplier_certificate_number_write trusted operation, so a refused number leaves no row and a declaration logs
--     only 'supplier_diversity.created'
--   * it admits only the owner, as the insert policy of 1464 does (private.owns_supplier_diversity); the insert
--     triggers (guard, audit columns, access log) run unchanged
--   * app.set_supplier_diversity_certificate_number stays for setting or clearing the number of an existing row

create or replace function app.add_supplier_diversity_certification(
  p_kind app.supplier_diversity_kind,
  p_certifying_body text,
  p_person_id uuid default null,
  p_account_id uuid default null,
  p_certificate_number text default null,
  p_issued_on date default null,
  p_expires_on date default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_clean text := upper(regexp_replace(coalesce(p_certificate_number, ''), '[^0-9A-Za-z]', '', 'g'));
begin
  perform private.require_person();
  if not coalesce(private.owns_supplier_diversity(p_person_id, p_account_id), false) then
    perform private.refuse('supplier_diversity_not_yours', 'Only the owner declares a supplier diversity certification.');
  end if;
  if p_certificate_number is not null and char_length(v_clean) not between 1 and 100 then
    perform private.refuse('certificate_number_format', 'A certificate number has 1 to 100 letters and digits.');
  end if;
  perform private.begin_trusted_operation('supplier_certificate_number_write');
  insert into app.supplier_diversity_certifications (person_id, account_id, diversity_kind, certifying_body, certificate_number,
    certificate_number_last4, issued_on, expires_on)
  values (p_person_id, p_account_id, p_kind, p_certifying_body,
    case when p_certificate_number is null then null
         else extensions.pgp_sym_encrypt(v_clean, private.supplier_certificate_number_key()) end,
    case when p_certificate_number is null then null else right(v_clean, 4) end,
    p_issued_on, p_expires_on)
  returning id into v_id;
  perform private.end_trusted_operation('supplier_certificate_number_write');
  return v_id;
end;
$$;

comment on function app.add_supplier_diversity_certification(app.supplier_diversity_kind, text, uuid, uuid, text, date, date) is 'The owner (a person for themselves, or an account''s Owner or Admin for the company) declares a supplier diversity certification and, optionally, its certificate number in one call: the number keeps its letters and digits, is encrypted under the Vault key and its last four stored in the same insert, so a refused number leaves no row. Logged once as created in the owner''s access log, never the value. Returns the certification id.';
revoke all on function app.add_supplier_diversity_certification(app.supplier_diversity_kind, text, uuid, uuid, text, date, date) from public, anon;
grant execute on function app.add_supplier_diversity_certification(app.supplier_diversity_kind, text, uuid, uuid, text, date, date) to authenticated, service_role;

comment on column app.supplier_diversity_certifications.certificate_number is 'Certificate number encrypted with pgp_sym_encrypt under the Vault key xos_supplier_certificate_number_key. Restricted (data.restricted.read.government_id): never selectable or writable by signed-in callers; set by the owner through app.add_supplier_diversity_certification (with the declaration) or app.set_supplier_diversity_certificate_number, and read whole only through the audited app.reveal_shared_supplier_diversity_number.';

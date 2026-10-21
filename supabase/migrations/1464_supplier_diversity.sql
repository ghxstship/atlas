-- 1464_supplier_diversity.sql
-- A89 (RRR-134), finding A65-031, work package WP8. Section 4.4.1: an external party's profile carries "optional
-- self-declared supplier diversity certifications, used only where an org runs a supplier diversity program, with
-- separate consent". Nothing stored them.
--   * app.supplier_diversity_certifications: owned by a person (a sole proprietor or freelancer) or by an external
--     account (a company), self-declared: the kind (minority-, women-, veteran-, disability- or LGBTQ+-owned, small
--     disadvantaged business, HUBZone), the certifying body, the certificate number, dates and evidence. Only the owner
--     reads and writes them: the person, or the account's Owner and Admin members
--   * the certificate number is Restricted (Section 8.3: a government identifier when a public agency certifies, as
--     the SBA and state DBE programs do), under data.restricted.read.government_id: nobody signed in selects the
--     column, the owner sees its last four characters, and an org reader sees it whole only with that capability. The
--     kind is Confidential: ownership by a protected group is special category data under GDPR Article 9, so no AI
--     feature reads the table (Section 14.3)
--   * separate consent: app.share_supplier_diversity shares one certification with one org under a supplier_diversity
--     consent record for that org (never the profile_sharing consent), only while the org runs a program
--     (gateway.supplier_diversity_program, off by default). app.revoke_supplier_diversity_share revokes at once and
--     withdraws the consent with the org's last live share
--   * an org reads shared certifications only through app.shared_supplier_diversity: members holding
--     vendors.vendor.read, only while the share stands and the program is on; turning the program off hides them
--   * audited: every change by the owner, every share and revocation and every org read lands in
--     app.supplier_diversity_events, the owner's own access log, without values; org reads, shares and revocations also
--     land in the org's audit ledger
--   * account deletion (1112) deletes a person's own certifications and revokes their shares

insert into private.consent_purposes (code, lawful_basis, sort_order) values ('supplier_diversity', 'consent', 70);

select private.define_setting('gateway.supplier_diversity_program', 'Boolean', 'org.gateway.write', array['organization'], false, p_default_boolean => false);

create type app.supplier_diversity_kind as enum (
  'Minority-Owned', 'Women-Owned', 'Veteran-Owned', 'Service-Disabled Veteran-Owned', 'Disability-Owned', 'LGBTQ+-Owned',
  'Small Disadvantaged Business', 'HUBZone', 'Other'
);
comment on type app.supplier_diversity_kind is 'Kinds of supplier diversity certification a person or company may declare (Section 4.4.1), as US supplier diversity programs name them.';

-- Certifications --------------------------------------------------------------------------------------------------------

create table app.supplier_diversity_certifications (
  id uuid primary key default private.uuid_v7(),
  person_id uuid references app.people (id),
  account_id uuid references app.organizations (id),
  diversity_kind app.supplier_diversity_kind not null,
  certifying_body text not null,
  certificate_number text,
  issued_on date,
  expires_on date,
  evidence_path text,
  created_at timestamptz not null default now(),
  created_by uuid references app.people (id),
  updated_at timestamptz not null default now(),
  updated_by uuid references app.people (id),
  deleted_at timestamptz,
  constraint supplier_diversity_certifications_one_owner check (num_nonnulls(person_id, account_id) = 1),
  constraint supplier_diversity_certifications_body check (char_length(btrim(certifying_body)) between 1 and 200),
  constraint supplier_diversity_certifications_number check (certificate_number is null or char_length(btrim(certificate_number)) between 1 and 100),
  constraint supplier_diversity_certifications_dates check (expires_on is null or issued_on is null or expires_on >= issued_on),
  constraint supplier_diversity_certifications_evidence check (evidence_path is null or evidence_path ~ '^[0-9a-f-]{36}/[A-Za-z0-9._-]{1,120}$')
);

create index supplier_diversity_certifications_person_id_idx on app.supplier_diversity_certifications (person_id);
create index supplier_diversity_certifications_account_id_idx on app.supplier_diversity_certifications (account_id);

call private.install_audit_columns('app.supplier_diversity_certifications');
call private.describe('app.supplier_diversity_certifications', 'Self-declared supplier diversity certifications (Section 4.4.1) of a person or an external account, used only where an org runs a supplier diversity program and shared one org at a time under separate consent (app.supplier_diversity_shares). Only the owner reads and writes them: the person, or the account''s Owner and Admin members.', array[
  'id', 'Primary key, UUID v7.',
  'person_id', 'Person who declared it for themselves; NULL when an account owns it.',
  'account_id', 'External account (company) that declared it; NULL when a person owns it.',
  'diversity_kind', 'Kind of certification. Confidential: special category data, never read by AI.',
  'certifying_body', 'Body that certified it, for example a state DBE program, or Self-Declared.',
  'certificate_number', 'Certificate number. Restricted (data.restricted.read.government_id): write-only to the owner, who sees its last four characters.',
  'issued_on', 'Day issued.',
  'expires_on', 'Day it expires.',
  'evidence_path', 'Certificate scan: object path in the profile-media bucket, starting with the owner id.'
]);

alter table app.supplier_diversity_certifications enable row level security;
revoke all on app.supplier_diversity_certifications from public, anon, authenticated;
grant all on app.supplier_diversity_certifications to service_role;
grant select (id, person_id, account_id, diversity_kind, certifying_body, issued_on, expires_on, evidence_path, created_at, created_by,
  updated_at, updated_by, deleted_at) on app.supplier_diversity_certifications to authenticated;
grant insert (person_id, account_id, diversity_kind, certifying_body, certificate_number, issued_on, expires_on, evidence_path)
  on app.supplier_diversity_certifications to authenticated;
grant update (diversity_kind, certifying_body, certificate_number, issued_on, expires_on, evidence_path, deleted_at)
  on app.supplier_diversity_certifications to authenticated;

insert into private.column_classifications (table_name, column_name, classification, read_capability) values
  ('app.supplier_diversity_certifications', 'certificate_number', 'Restricted', 'data.restricted.read.government_id'),
  ('app.supplier_diversity_certifications', 'diversity_kind', 'Confidential', null),
  ('app.supplier_diversity_certifications', 'evidence_path', 'Confidential', null);

insert into private.ai_excluded_tables (table_name, reason) values
  ('app.supplier_diversity_certifications', 'Supplier diversity certifications reveal ownership by a protected group, special category data (Section 14.3).');

create or replace function private.owns_supplier_diversity(p_person_id uuid, p_account_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (p_person_id is not null and p_person_id = private.current_person_id())
    or (p_account_id is not null and p_account_id in (
      select private.my_account_ids(array['Account Owner', 'Account Admin']::app.account_role[])));
$$;

comment on function private.owns_supplier_diversity(uuid, uuid) is 'True when the signed-in person owns a supplier diversity certification with these owner columns: it is theirs, or it is an account''s they are an Owner or Admin of. Takes column values (ADR 0016 item 14).';
revoke all on function private.owns_supplier_diversity(uuid, uuid) from public, anon;
grant execute on function private.owns_supplier_diversity(uuid, uuid) to authenticated, service_role;

create policy supplier_diversity_certifications_read on app.supplier_diversity_certifications for select to authenticated
  using (private.owns_supplier_diversity(person_id, account_id));
create policy supplier_diversity_certifications_insert on app.supplier_diversity_certifications for insert to authenticated
  with check (private.owns_supplier_diversity(person_id, account_id));
create policy supplier_diversity_certifications_update on app.supplier_diversity_certifications for update to authenticated
  using (private.owns_supplier_diversity(person_id, account_id)) with check (private.owns_supplier_diversity(person_id, account_id));

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
  new.certifying_body := btrim(new.certifying_body);
  new.certificate_number := nullif(btrim(new.certificate_number), '');
  return new;
end;
$$;

comment on function private.guard_supplier_diversity_certification() is 'Supplier diversity certifications keep their owner, belong to a person or an external account, and store trimmed text.';
revoke all on function private.guard_supplier_diversity_certification() from public, anon, authenticated;

create trigger t40_guard_supplier_diversity_certification before insert or update on app.supplier_diversity_certifications
  for each row execute function private.guard_supplier_diversity_certification();

call private.install_default_retention('app.supplier_diversity_certifications');

-- Access log -------------------------------------------------------------------------------------------------------------

create table app.supplier_diversity_events (
  id uuid primary key default private.uuid_v7(),
  supplier_diversity_certification_id uuid not null references app.supplier_diversity_certifications (id),
  person_id uuid references app.people (id),
  account_id uuid references app.organizations (id),
  actor_person_id uuid references app.people (id),
  org_id uuid references app.organizations (id),
  action text not null,
  request_id text,
  created_at timestamptz not null default now(),
  constraint supplier_diversity_events_owner check (num_nonnulls(person_id, account_id) = 1),
  constraint supplier_diversity_events_action check (action in (
    'supplier_diversity.created', 'supplier_diversity.updated', 'supplier_diversity.removed', 'supplier_diversity.shared',
    'supplier_diversity.share_revoked', 'supplier_diversity.viewed')),
  constraint supplier_diversity_events_request_id_length check (request_id is null or char_length(request_id) <= 200)
);

create index supplier_diversity_events_certification_idx on app.supplier_diversity_events (supplier_diversity_certification_id, created_at);
create index supplier_diversity_events_person_id_idx on app.supplier_diversity_events (person_id);
create index supplier_diversity_events_account_id_idx on app.supplier_diversity_events (account_id);
create index supplier_diversity_events_actor_person_id_idx on app.supplier_diversity_events (actor_person_id);
create index supplier_diversity_events_org_id_idx on app.supplier_diversity_events (org_id);

call private.describe('app.supplier_diversity_events', 'The owner''s access log for their supplier diversity certifications (Section 8.4 access transparency): every change they make, every share and revocation, and every read by an org, never a value. Written only by the database; the owner reads all of theirs and an org''s audit readers read the rows naming their org.', array[
  'id', 'Primary key, UUID v7.',
  'supplier_diversity_certification_id', 'Certification touched.',
  'person_id', 'Owner, when a person owns it.',
  'account_id', 'Owner, when an external account owns it.',
  'actor_person_id', 'Person who acted; NULL for the database.',
  'org_id', 'Org the certification was shared with or read by; NULL for the owner''s own changes.',
  'action', 'What happened: created, updated, removed, shared, share_revoked or viewed.',
  'request_id', 'API request id, for correlating with logs.',
  'created_at', 'When it happened. Set by the database.'
]);

alter table app.supplier_diversity_events enable row level security;
revoke all on app.supplier_diversity_events from public, anon, authenticated;
grant select on app.supplier_diversity_events to authenticated;
grant all on app.supplier_diversity_events to service_role;
create policy supplier_diversity_events_read on app.supplier_diversity_events for select to authenticated
  using (private.owns_supplier_diversity(person_id, account_id)
    or org_id in (select private.orgs_with_capability('audit.log.read')));

insert into private.retention_policies (table_name, basis, time_column, retention, purge_method, rationale) values
  ('app.supplier_diversity_events', 'Age', 'created_at', interval '7 years', 'Delete', 'Access log kept as long as the audit ledger; it holds no values.');

create or replace function private.log_supplier_diversity_event(p_certification_id uuid, p_action text, p_org_id uuid default null)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  insert into app.supplier_diversity_events (supplier_diversity_certification_id, person_id, account_id, actor_person_id, org_id, action, request_id)
  select c.id, c.person_id, c.account_id, private.current_person_id(), p_org_id, p_action, left(private.request_header('x-request-id'), 200)
  from app.supplier_diversity_certifications c where c.id = p_certification_id;
end;
$$;

comment on function private.log_supplier_diversity_event(uuid, text, uuid) is 'Writes one row to the owner''s supplier diversity access log, with the acting person and request id from the session.';
revoke all on function private.log_supplier_diversity_event(uuid, text, uuid) from public, anon, authenticated;

create or replace function private.log_supplier_diversity_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.log_supplier_diversity_event(new.id,
    case when tg_op = 'INSERT' then 'supplier_diversity.created'
         when new.deleted_at is not null and old.deleted_at is null then 'supplier_diversity.removed'
         else 'supplier_diversity.updated' end);
  if new.account_id is not null then
    perform private.write_audit_event(new.account_id,
      case when tg_op = 'INSERT' then 'supplier_diversity.created'
           when new.deleted_at is not null and old.deleted_at is null then 'supplier_diversity.removed'
           else 'supplier_diversity.updated' end,
      'app.supplier_diversity_certifications', new.id, '{}'::jsonb);
  end if;
  return null;
end;
$$;

comment on function private.log_supplier_diversity_change() is 'After a supplier diversity certification is added, changed or removed: logs it in the owner''s access log, and in the account''s audit ledger for a company, without values.';
revoke all on function private.log_supplier_diversity_change() from public, anon, authenticated;

create trigger t80_log_supplier_diversity_change after insert or update on app.supplier_diversity_certifications
  for each row execute function private.log_supplier_diversity_change();

-- Shares under separate consent ----------------------------------------------------------------------------------------------

create table app.supplier_diversity_shares (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  supplier_diversity_certification_id uuid not null references app.supplier_diversity_certifications (id),
  consent_record_id uuid not null references app.consent_records (id),
  shared_at timestamptz not null default now(),
  revoked_at timestamptz,
  deleted_at timestamptz,
  constraint supplier_diversity_shares_revoked_after check (revoked_at is null or revoked_at >= shared_at)
);

create index supplier_diversity_shares_certification_idx on app.supplier_diversity_shares (supplier_diversity_certification_id);
create index supplier_diversity_shares_consent_record_idx on app.supplier_diversity_shares (consent_record_id);
create unique index supplier_diversity_shares_live_key on app.supplier_diversity_shares (org_id, supplier_diversity_certification_id)
  where revoked_at is null and deleted_at is null;

call private.install_domain_table('app.supplier_diversity_shares', null, null, array['app.consent_records', 'consent_record_id']);
call private.describe('app.supplier_diversity_shares', 'An owner sharing one supplier diversity certification with one org that runs a supplier diversity program, under a supplier_diversity consent record for that org (Section 4.4.1: separate consent). Written only through app.share_supplier_diversity and app.revoke_supplier_diversity_share; the org reads the certification only through app.shared_supplier_diversity.', array[
  'org_id', 'Org the certification is shared with.',
  'supplier_diversity_certification_id', 'Certification shared.',
  'consent_record_id', 'The supplier_diversity consent the owner gave the org.',
  'shared_at', 'When it was shared.',
  'revoked_at', 'When the owner revoked the share.'
]);

create or replace function private.my_supplier_diversity_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select c.id from app.supplier_diversity_certifications c
  where c.deleted_at is null and private.owns_supplier_diversity(c.person_id, c.account_id);
$$;

comment on function private.my_supplier_diversity_ids() is 'Supplier diversity certifications the signed-in person owns, directly or as an account Owner or Admin. Reads the certifications, never the share table its caller protects.';
revoke all on function private.my_supplier_diversity_ids() from public, anon;
grant execute on function private.my_supplier_diversity_ids() to authenticated, service_role;

-- Revoking stays possible while an org is canceled and read-only (Section 14.7, GDPR Article 7(3)): consent is
-- withdrawn as easily as it was given. New shares with a read-only org are refused by app.share_supplier_diversity.
-- The access log records permitted acts, like the audit ledger.
insert into private.read_only_exempt_tables (table_name, rationale) values
  ('app.supplier_diversity_shares', 'An owner revokes a supplier diversity share at any time; new shares with a read-only org are refused by the RPC.'),
  ('app.supplier_diversity_events', 'The supplier diversity access log records permitted acts, like the audit ledger.');
drop trigger if exists t15_refuse_read_only_org on app.supplier_diversity_shares;

call private.install_policies('app.supplier_diversity_shares',
  $$supplier_diversity_certification_id in (select private.my_supplier_diversity_ids())
    or org_id in (select private.orgs_with_capability('vendors.vendor.read'))$$);
revoke insert, update on app.supplier_diversity_shares from authenticated;

call private.install_default_retention('app.supplier_diversity_shares');

create or replace function private.supplier_diversity_program_on(p_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(private.setting_boolean(p_org_id, 'gateway.supplier_diversity_program'), false);
$$;

comment on function private.supplier_diversity_program_on(uuid) is 'True when the org runs a supplier diversity program (setting gateway.supplier_diversity_program, off by default). Only then can anyone share a supplier diversity certification with it, and only then does it read the ones shared (Section 4.4.1).';
revoke all on function private.supplier_diversity_program_on(uuid) from public, anon, authenticated;

create or replace function app.share_supplier_diversity(p_certification_id uuid, p_org_id uuid, p_notice_version text default '1.0.0')
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_me uuid := private.require_person();
  v_cert app.supplier_diversity_certifications;
  v_consent uuid;
  v_id uuid;
begin
  select * into v_cert from app.supplier_diversity_certifications c where c.id = p_certification_id and c.deleted_at is null;
  if v_cert.id is null or not private.owns_supplier_diversity(v_cert.person_id, v_cert.account_id) then
    perform private.refuse('supplier_diversity_not_yours', 'Only the owner shares a supplier diversity certification.');
  end if;
  if not exists (select 1 from app.organizations o where o.id = p_org_id and o.deleted_at is null) then
    perform private.refuse('org_unknown', 'The organization does not exist.');
  end if;
  if not private.supplier_diversity_program_on(p_org_id) then
    perform private.refuse('supplier_diversity_no_program', 'This organization does not run a supplier diversity program, so it takes no diversity certifications.');
  end if;
  if private.org_read_only(p_org_id) then
    perform private.refuse('org_read_only', 'This organization is canceled and read-only, so it takes no new shares.');
  end if;
  select s.id into v_id from app.supplier_diversity_shares s
  where s.org_id = p_org_id and s.supplier_diversity_certification_id = p_certification_id and s.revoked_at is null and s.deleted_at is null;
  if v_id is not null then
    return v_id;
  end if;
  select r.id into v_consent from app.consent_records r
  where r.org_id = p_org_id and r.person_id = v_me and r.purpose_code = 'supplier_diversity'
    and r.withdrawn_at is null and r.deleted_at is null;
  if v_consent is null then
    insert into app.consent_records (org_id, person_id, purpose_code, notice_version, source)
    values (p_org_id, v_me, 'supplier_diversity', coalesce(nullif(btrim(p_notice_version), ''), '1.0.0'), 'Web')
    returning id into v_consent;
  end if;
  insert into app.supplier_diversity_shares (org_id, supplier_diversity_certification_id, consent_record_id)
  values (p_org_id, p_certification_id, v_consent)
  returning id into v_id;
  perform private.log_supplier_diversity_event(p_certification_id, 'supplier_diversity.shared', p_org_id);
  perform private.write_audit_event(p_org_id, 'supplier_diversity.shared', 'app.supplier_diversity_shares', v_id, '{}'::jsonb);
  return v_id;
end;
$$;

comment on function app.share_supplier_diversity(uuid, uuid, text) is 'The owner shares one supplier diversity certification with an org that runs a supplier diversity program, recording supplier_diversity consent for that org when none stands (separate from profile sharing). Idempotent while the share stands. Logged in the owner''s access log and the org''s audit ledger. Returns the share id.';

create or replace function app.revoke_supplier_diversity_share(p_share_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_share app.supplier_diversity_shares;
begin
  perform private.require_person();
  select s.* into v_share from app.supplier_diversity_shares s
  where s.id = p_share_id and s.revoked_at is null and s.deleted_at is null
    and s.supplier_diversity_certification_id in (select private.my_supplier_diversity_ids());
  if v_share.id is null then
    perform private.refuse('supplier_diversity_not_yours', 'Only the owner revokes a live share.');
  end if;
  update app.supplier_diversity_shares set revoked_at = now() where id = v_share.id;
  if not exists (select 1 from app.supplier_diversity_shares s
                 where s.consent_record_id = v_share.consent_record_id and s.revoked_at is null and s.deleted_at is null) then
    update app.consent_records set withdrawn_at = now() where id = v_share.consent_record_id and withdrawn_at is null;
  end if;
  perform private.log_supplier_diversity_event(v_share.supplier_diversity_certification_id, 'supplier_diversity.share_revoked', v_share.org_id);
  perform private.write_audit_event(v_share.org_id, 'supplier_diversity.share_revoked', 'app.supplier_diversity_shares', v_share.id, '{}'::jsonb);
end;
$$;

comment on function app.revoke_supplier_diversity_share(uuid) is 'The owner revokes a supplier diversity share at once; the supplier_diversity consent for the org is withdrawn with its last live share. Logged in the owner''s access log and the org''s audit ledger.';

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
  select c.id, c.diversity_kind, c.certifying_body, right(c.certificate_number, 4), c.issued_on, c.expires_on, c.evidence_path,
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

comment on function app.my_supplier_diversity(uuid) is 'The signed-in person''s own supplier diversity certifications, or an account''s they are an Owner or Admin of, with the certificate number''s last four characters (Restricted) and the orgs each is shared with now.';

create or replace function app.supplier_diversity_programs(p_account_id uuid default null)
returns table (org_id uuid, org_name text)
language sql
stable
security definer
set search_path = ''
as $$
  select o.id, o.name from app.organizations o
  where o.deleted_at is null and private.supplier_diversity_program_on(o.id)
    and (
      (p_account_id is null and (
        o.id in (select private.party_org_ids(private.current_person_id()))
        or o.id in (select a.org_id from app.applications a where a.applicant_person_id = private.current_person_id() and a.deleted_at is null)))
      or (p_account_id is not null
        and p_account_id in (select private.my_account_ids(array['Account Owner', 'Account Admin']::app.account_role[]))
        and (o.id in (select c.org_id from app.counterparties c where c.organization_id = p_account_id and c.deleted_at is null)
          or o.id in (select a.org_id from app.applications a where a.applicant_organization_id = p_account_id and a.deleted_at is null))))
  order by o.name;
$$;

comment on function app.supplier_diversity_programs(uuid) is 'Orgs that run a supplier diversity program among those the signed-in person (or an account they are an Owner or Admin of) works with or applied to: where a certification can be shared.';

create or replace function app.shared_supplier_diversity(p_org_id uuid)
returns table (
  share_id uuid,
  certification_id uuid,
  person_id uuid,
  person_name text,
  account_id uuid,
  account_name text,
  diversity_kind app.supplier_diversity_kind,
  certifying_body text,
  certificate_number text,
  certificate_number_masked boolean,
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
  v_unmask boolean;
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
  v_unmask := private.has_capability(p_org_id, 'data.restricted.read.government_id');
  for v_row in
    select s.id as share_id, c.id as certification_id, c.person_id, p.full_name as person_name, c.account_id, a.name as account_name,
      c.diversity_kind, c.certifying_body, c.certificate_number, c.issued_on, c.expires_on, s.shared_at
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
    certificate_number := case when v_unmask then v_row.certificate_number end;
    certificate_number_masked := v_row.certificate_number is not null and not v_unmask;
    issued_on := v_row.issued_on;
    expires_on := v_row.expires_on;
    shared_at := v_row.shared_at;
    perform private.log_supplier_diversity_event(v_row.certification_id, 'supplier_diversity.viewed', p_org_id);
    v_count := v_count + 1;
    return next;
  end loop;
  if v_count > 0 then
    perform private.write_audit_event(p_org_id, 'supplier_diversity.viewed', 'app.supplier_diversity_shares', null,
      jsonb_build_object('certifications', v_count, 'restricted_unmasked', v_unmask));
  end if;
end;
$$;

comment on function app.shared_supplier_diversity(uuid) is 'Supplier diversity certifications shared with an org, for its members holding vendors.vendor.read, only while each share stands and the org runs a supplier diversity program (Section 4.4.1). The certificate number is Restricted: whole only with data.restricted.read.government_id, otherwise NULL and marked masked (Section 8.3). Every read is logged in each owner''s access log and once in the org''s audit ledger.';

-- Account deletion -------------------------------------------------------------------------------------------------------------

create or replace function private.erase_supplier_diversity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_share app.supplier_diversity_shares;
begin
  for v_share in
    select s.* from app.supplier_diversity_shares s
    join app.supplier_diversity_certifications c on c.id = s.supplier_diversity_certification_id
    where c.person_id = new.id and s.revoked_at is null and s.deleted_at is null
  loop
    update app.supplier_diversity_shares set revoked_at = now() where id = v_share.id;
    update app.consent_records set withdrawn_at = now() where id = v_share.consent_record_id and withdrawn_at is null;
  end loop;
  delete from app.supplier_diversity_events e using app.supplier_diversity_certifications c
    where e.supplier_diversity_certification_id = c.id and c.person_id = new.id;
  delete from app.supplier_diversity_shares s using app.supplier_diversity_certifications c
    where s.supplier_diversity_certification_id = c.id and c.person_id = new.id;
  delete from app.supplier_diversity_certifications where person_id = new.id;
  return null;
end;
$$;

comment on function private.erase_supplier_diversity() is 'After a person is deleted (account deletion, 1112): revokes their supplier diversity shares, withdraws the consents and deletes their own certifications, shares and access log. An account''s certifications stay with the account.';
revoke all on function private.erase_supplier_diversity() from public, anon, authenticated;

create trigger t62_erase_supplier_diversity after update of deleted_at on app.people
  for each row when (old.deleted_at is null and new.deleted_at is not null)
  execute function private.erase_supplier_diversity();

-- Privileges -------------------------------------------------------------------------------------------------------------------

revoke all on function app.share_supplier_diversity(uuid, uuid, text) from public, anon;
revoke all on function app.revoke_supplier_diversity_share(uuid) from public, anon;
revoke all on function app.my_supplier_diversity(uuid) from public, anon;
revoke all on function app.supplier_diversity_programs(uuid) from public, anon;
revoke all on function app.shared_supplier_diversity(uuid) from public, anon;
grant execute on function app.share_supplier_diversity(uuid, uuid, text) to authenticated, service_role;
grant execute on function app.revoke_supplier_diversity_share(uuid) to authenticated, service_role;
grant execute on function app.my_supplier_diversity(uuid) to authenticated, service_role;
grant execute on function app.supplier_diversity_programs(uuid) to authenticated, service_role;
grant execute on function app.shared_supplier_diversity(uuid) to authenticated, service_role;

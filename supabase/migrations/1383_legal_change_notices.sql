-- 1383_legal_change_notices.sql
-- A82 compliance flows (RRR-127), finding A65-014 (Section 14.4, legal/policies/change-management.md section 6): a material
-- change to a legal document needs in-app re-acceptance with 30 days' notice. app.current_legal_acceptances (0850) could
-- support a prompt, but nothing recorded when a notice started or asked anyone to accept. This migration adds:
--   * private.legal_change_notices: the platform team's record that a new version of a document was announced, when, and
--     the date it takes effect. The notice time comes from the database, so it is evidence of the 30 days; a change that
--     takes effect sooner is refused;
--   * app.announce_legal_change and app.withdraw_legal_change, for the platform team (service role);
--   * app.pending_legal_reacceptances, which the shells read to show the prompt: for an org, to those who may accept for
--     it (org.legal.accept) until the org accepts the announced version; for a personal document such as the Worker
--     Terms, to each person who accepted an earlier version, until they accept this one. A notice is Upcoming during its
--     30 days and Required from its effective date. Acceptances still go through app.record_legal_acceptances (0850).
-- Whether access stops after the effective date for someone who has not accepted is an owner decision; the prompt stays
-- until they accept.

create table private.legal_change_notices (
  id uuid primary key default private.uuid_v7(),
  document_slug text not null,
  document_version text not null,
  acceptance text not null,
  summary text not null,
  noticed_at timestamptz not null default now(),
  effective_on date not null,
  withdrawn_at timestamptz,
  constraint legal_change_notices_slug check (document_slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and char_length(document_slug) <= 80),
  constraint legal_change_notices_version check (document_version ~ '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9a-z.]+)?$'),
  constraint legal_change_notices_acceptance check (acceptance in ('Org', 'Personal')),
  constraint legal_change_notices_summary check (char_length(btrim(summary)) between 1 and 500),
  constraint legal_change_notices_period check (effective_on >= (noticed_at at time zone 'UTC')::date + 30),
  constraint legal_change_notices_once unique (document_slug, document_version)
);

comment on table private.legal_change_notices is 'Announced material changes to legal documents (Section 14.4): which version of which document, when the notice started (database time, the evidence of 30 days) and when it takes effect. Written by the platform team through app.announce_legal_change; read by the shells through app.pending_legal_reacceptances.';
comment on column private.legal_change_notices.id is 'Notice id (UUID v7).';
comment on column private.legal_change_notices.document_slug is 'Legal document slug from legal/index.yaml.';
comment on column private.legal_change_notices.document_version is 'The new version people are asked to accept.';
comment on column private.legal_change_notices.acceptance is 'Org: accepted for an org by someone with org.legal.accept (Terms of Service, DPA). Personal: accepted by each person (Worker Terms, Mobile EULA).';
comment on column private.legal_change_notices.summary is 'What changes, in plain words, shown with the prompt.';
comment on column private.legal_change_notices.noticed_at is 'When the notice started. Set by the database.';
comment on column private.legal_change_notices.effective_on is 'Date the new version takes effect: at least 30 days after the notice.';
comment on column private.legal_change_notices.withdrawn_at is 'When the platform team withdrew the notice; a withdrawn notice prompts no one.';

alter table private.legal_change_notices enable row level security;
revoke all on private.legal_change_notices from public, anon, authenticated;
grant select on private.legal_change_notices to service_role;

-- Announcing a change (platform team) ----------------------------------------------------------------------------------

create or replace function app.announce_legal_change(
  p_document_slug text,
  p_document_version text,
  p_acceptance text,
  p_summary text,
  p_effective_on date
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if p_effective_on is null or p_effective_on < (now() at time zone 'UTC')::date + 30 then
    perform private.refuse('legal_notice_period', 'A material change takes effect at least 30 days after its notice (Section 14.4).');
  end if;
  insert into private.legal_change_notices (document_slug, document_version, acceptance, summary, effective_on)
  values (p_document_slug, p_document_version, p_acceptance, btrim(p_summary), p_effective_on)
  returning id into v_id;
  return v_id;
end;
$$;

comment on function app.announce_legal_change(text, text, text, text, date) is 'Service role only (the platform team): records that a new version of a legal document was announced as a material change, starting its notice now. Refuses an effective date less than 30 days ahead. From then on the shells ask for acceptance (app.pending_legal_reacceptances). Answers the notice id.';
revoke all on function app.announce_legal_change(text, text, text, text, date) from public, anon, authenticated;
grant execute on function app.announce_legal_change(text, text, text, text, date) to service_role;

create or replace function app.withdraw_legal_change(p_document_slug text, p_document_version text)
returns boolean
language sql
volatile
security definer
set search_path = ''
as $$
  with withdrawn as (
    update private.legal_change_notices set withdrawn_at = now()
    where document_slug = p_document_slug and document_version = p_document_version and withdrawn_at is null
    returning 1
  )
  select exists (select 1 from withdrawn);
$$;

comment on function app.withdraw_legal_change(text, text) is 'Service role only (the platform team): withdraws an announced change, so it prompts no one. Answers false when there was nothing to withdraw.';
revoke all on function app.withdraw_legal_change(text, text) from public, anon, authenticated;
grant execute on function app.withdraw_legal_change(text, text) to service_role;

-- The prompt ------------------------------------------------------------------------------------------------------------

create or replace function app.pending_legal_reacceptances(p_org_id uuid default null)
returns table (
  document_slug text,
  document_version text,
  summary text,
  noticed_at timestamptz,
  effective_on date,
  required boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select n.document_slug, n.document_version, n.summary, n.noticed_at, n.effective_on,
    (now() at time zone 'UTC')::date >= n.effective_on
  from private.legal_change_notices n
  where n.withdrawn_at is null
    and private.current_person_id() is not null
    and (
      -- An org's acceptance: asked of those who may accept for it, until the org accepts this version.
      (p_org_id is not null and n.acceptance = 'Org'
        and private.has_capability(p_org_id, 'org.legal.accept')
        and not exists (
          select 1 from app.legal_acceptances a
          where a.org_id = p_org_id and a.document_slug = n.document_slug
            and a.document_version = n.document_version and a.deleted_at is null))
      or
      -- A personal acceptance: asked of each person who accepted an earlier version, until they accept this one.
      (p_org_id is null and n.acceptance = 'Personal'
        and exists (
          select 1 from app.legal_acceptances a
          where a.person_id = private.current_person_id() and a.org_id is null
            and a.document_slug = n.document_slug and a.deleted_at is null)
        and not exists (
          select 1 from app.legal_acceptances a
          where a.person_id = private.current_person_id() and a.org_id is null
            and a.document_slug = n.document_slug and a.document_version = n.document_version
            and a.deleted_at is null))
    )
  order by n.effective_on, n.document_slug;
$$;

comment on function app.pending_legal_reacceptances(uuid) is 'Announced material changes the signed-in person is asked to accept (Section 14.4): with an org, the org''s documents when the person holds org.legal.accept there and the org has not accepted the announced version; without one, the personal documents the person accepted an earlier version of. required is true from the effective date. Accept through app.record_legal_acceptances.';
revoke all on function app.pending_legal_reacceptances(uuid) from public, anon;
grant execute on function app.pending_legal_reacceptances(uuid) to authenticated, service_role;

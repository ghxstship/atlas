-- 3040_aurora_intake_scope.sql
-- B15 Aurora intake and drafting extensions (RRR-239; parity gaps G-59, G-177, G-173, G-225, G-240; ADR 0154). An intake
-- is its open suggestions: extraction requests with subject app.projects/<project>, which last 7 days and belong to the
-- person who asked (ADR 0154 D3), so there is no batch table and a reload resumes the review.
--
--   1. app.aurora_intake_scope: the capability check of an intake or governance draft, run before any model call or
--      metering, and, for a contract, what the caller may be asked and may write.
--   2. t40_guard_ai_suggestion_field_restricted and the read policy of app.ai_suggestion_fields: a fee read from a contract
--      and its currency are Restricted (ADR 0154 D2), held only for a payroll reader, hidden from other audit readers.
--   3. Comments naming the new operations. travelSegments.create, engagements.createFromContract and advanceAnswers.record
--      name no API handler, so the generic confirm returns ai_suggestion_operation_unavailable and moves the suggestion
--      back to Proposed, and app.transition_ai_suggestion (3830) is not redefined (ADR 0154 D5).
-- 3046 to 3048 are reserved and unused.

-- 1. Scope -----------------------------------------------------------------------------------------------------------------

create or replace function app.aurora_intake_scope(p_kind text, p_project_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_project app.projects;
  v_capability text;
begin
  v_capability := case p_kind
    when 'itinerary' then 'hospitality.fulfillment.write'
    when 'contract' then 'opportunities.engagement.write'
    when 'governance' then 'work.record.write'
  end;
  if v_capability is null then
    perform private.refuse('aurora_intake_kind', 'Aurora has no intake of this kind.');
  end if;
  select p.* into v_project from app.projects p where p.id = p_project_id and p.deleted_at is null;
  -- A share reaches project_ids_with from an outside org (P3 C4), so a capability always pairs with membership.
  if v_project.id is null or not private.is_member(v_project.org_id)
     or not private.can_on_project(p_project_id, v_capability) then
    raise exception using errcode = '42501', message = format('this needs %s on the project in your org', v_capability);
  end if;
  if p_kind = 'contract' then
    return jsonb_build_object(
      'project_id', v_project.id,
      'fee_visible', private.has_capability(v_project.org_id, 'data.restricted.read.payroll'),
      'can_write_riders', private.can_on_project(p_project_id, 'advancing.rider.write'));
  end if;
  return jsonb_build_object('project_id', v_project.id);
end;
$$;

comment on function app.aurora_intake_scope(text, uuid) is 'What an Aurora intake or governance draft may do on a project, checked before any model call or metering (B15, ADR 0154). itinerary needs hospitality.fulfillment.write, contract opportunities.engagement.write and governance work.record.write, each with membership in the project''s org, otherwise 42501 (404 at the API). A contract also answers fee_visible, whether the caller holds data.restricted.read.payroll across the org and so whether the model is asked for a fee, and can_write_riders, advancing.rider.write on the project. An unknown kind refuses aurora_intake_kind.';

-- 2. Restricted fees ---------------------------------------------------------------------------------------------------------

create or replace function private.guard_ai_suggestion_field_restricted()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.field_path in ('agreed_rate_minor', 'agreed_rate_currency_code')
     and new.org_id not in (select private.orgs_with_capability('data.restricted.read.payroll')) then
    perform private.refuse('ai_field_restricted', 'A fee is proposed only to someone who may read pay.');
  end if;
  return new;
end;
$$;

comment on function private.guard_ai_suggestion_field_restricted() is 'Before insert on app.ai_suggestion_fields (B15, ADR 0154 D2): a fee read from a contract (agreed_rate_minor) and its currency (agreed_rate_currency_code) are stored only for a holder of data.restricted.read.payroll across the org, refused ai_field_restricted otherwise.';

create trigger t40_guard_ai_suggestion_field_restricted before insert on app.ai_suggestion_fields
  for each row execute function private.guard_ai_suggestion_field_restricted();

call private.install_policies('app.ai_suggestion_fields',
  'private.ai_suggestion_visible(suggestion_id) and (field_path not in (''agreed_rate_minor'', ''agreed_rate_currency_code'') or org_id in (select private.orgs_with_capability(''data.restricted.read.payroll'')))');

-- 3. Comments ----------------------------------------------------------------------------------------------------------------

comment on column app.ai_settings.extraction_enabled is 'Document extraction from riders, insurance certificates, invoices, receipts, quotes, itineraries and booking contracts, with the line items of invoices and receipts.';
comment on column app.ai_settings.drafting_enabled is 'Drafting of SOPs, advance packets, emails, day sheets, change order descriptions, running orders, risk assessments, event plans, event briefs, approval packs, waste plans and advance answers.';
comment on column app.ai_suggestions.operation_id is 'Public API operation that performs the change, for example records.create or savedViews.create. A drafted list''s suggestions (drafting requests about app.run_of_show or app.projects) are applied together by app.apply_drafted_list. travelSegments.create, engagements.createFromContract and advanceAnswers.record name no API handler: they are applied only by app.apply_itinerary_lines, app.apply_contract_intake and app.record_drafted_advance_answer, and the generic confirm returns ai_suggestion_operation_unavailable. invoiceLines.create suggestions of an invoice extraction are applied by app.apply_invoice_line_suggestions.';

-- Privileges -----------------------------------------------------------------------------------------------------------------

revoke all on function private.guard_ai_suggestion_field_restricted() from public, anon, authenticated;
revoke all on function app.aurora_intake_scope(text, uuid) from public, anon;
grant execute on function app.aurora_intake_scope(text, uuid) to authenticated, service_role;

-- 1133_external_sponsor_assets.sql
-- A44 Gateway, notification and Compass gaps (RRR-88), finding A38-005 (journey 47: "assets are approved in Gateway").
-- Sponsor assets (A16, 0492) were reviewed by the org only, so Gateway's Asset approvals tab could never show them:
--   * api_external.sponsor_assets: the assets of the entitlements the caller's sponsor account is owed, while its
--     Sponsor engagement has the operational area open, with their review state and revision. Who decided on the org
--     side never appears
--   * app.respond_sponsor_asset: the sponsor's Account Owner or Admin approves or returns (with a reason) an asset the
--     org submitted, or resubmits a returned asset as a new revision. Compare-and-set through the same lifecycle and
--     ledger as the org's app.transition_sponsor_asset, so every move is recorded and emits sponsor_asset.state_changed

create or replace function private.sponsor_side_open(p_sponsor_entitlement_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from app.sponsor_entitlements s
    where s.id = p_sponsor_entitlement_id and s.deleted_at is null
      and exists (select 1 from app.engagements e
                  where e.project_id = s.project_id and e.counterparty_id = s.counterparty_id and e.deleted_at is null
                    and e.role_type = 'Sponsor')
      and private.counterparty_area_open(s.project_id, s.counterparty_id, 'operational',
        array['Account Owner', 'Account Admin']::app.account_role[]));
$$;

comment on function private.sponsor_side_open(uuid) is 'Section 8.7: true when the signed-in person answers for the sponsor an entitlement is owed to (an Account Owner or Admin of the sponsor account) while its Sponsor engagement on the project has the operational area open. Takes the entitlement id.';

create view api_external.sponsor_assets as
select a.id, a.sponsor_entitlement_id, x.project_id, x.project_name, x.account_id, x.description as entitlement_description,
  a.asset_kind, a.title, a.usage_note, a.due_on, a.revision, a.asset_state, a.decided_at,
  (a.asset_state = 'Submitted') as awaiting_sponsor
from app.sponsor_assets a
join api_external.sponsor_entitlements x on x.id = a.sponsor_entitlement_id
where a.deleted_at is null and a.asset_state <> 'Proposed';

call private.describe('api_external.sponsor_assets', 'Brand assets of the entitlements the caller''s sponsor account is owed (journey 47), once the org submits them, while the Sponsor engagement is in the operational area. Drafts the org has not submitted and who decided on the org side never appear.', array[
  'id', 'Asset.', 'sponsor_entitlement_id', 'Entitlement.', 'project_id', 'Project.', 'project_name', 'Project name.',
  'account_id', 'The caller''s sponsor account.', 'entitlement_description', 'What the entitlement is.',
  'asset_kind', 'Logo, Artwork, Copy, Video or Other.', 'title', 'What the asset is.', 'usage_note', 'Where and how it is used.',
  'due_on', 'When it is needed.', 'revision', 'Revision number.', 'asset_state', 'Submitted, Approved, Returned or Canceled.',
  'decided_at', 'When it was last approved or returned.', 'awaiting_sponsor', 'True while the sponsor''s answer is awaited.']);

create or replace function app.respond_sponsor_asset(
  p_sponsor_asset_id uuid,
  p_expected app.review_state,
  p_next app.review_state,
  p_reason text
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
  v_row app.sponsor_assets;
  v_entry uuid;
begin
  select * into v_row from app.sponsor_assets a where a.id = p_sponsor_asset_id and a.deleted_at is null for update;
  -- A draft the org has not submitted is not the sponsor's to see, so it is answered like a missing one.
  if v_row.id is null or v_row.asset_state = 'Proposed' or not private.sponsor_side_open(v_row.sponsor_entitlement_id) then
    raise exception using errcode = '42501', message = 'only the sponsor answers for this asset';
  end if;
  if not ((p_expected = 'Submitted' and p_next in ('Approved', 'Returned')) or (p_expected = 'Returned' and p_next = 'Submitted')) then
    perform private.refuse('sponsor_asset_response', 'A sponsor approves or returns a submitted asset, or resubmits a returned one.');
  end if;
  if p_next = 'Returned' and nullif(btrim(p_reason), '') is null then
    perform private.refuse('sponsor_asset_return_reason', 'Say what to change when returning an asset.');
  end if;
  v_entry := private.transition_lifecycle('sponsor_asset', 'app.sponsor_assets', 'asset_state', 'app.sponsor_asset_state_transitions',
    'sponsor_asset_id', p_sponsor_asset_id, p_expected::text, p_next::text,
    coalesce(nullif(btrim(p_reason), ''), case p_next when 'Approved' then 'Approved by the sponsor.' else 'Resubmitted by the sponsor.' end));
  perform private.begin_trusted_operation('sponsor_asset_review');
  if p_next in ('Approved', 'Returned') then
    update app.sponsor_assets set decided_by = v_person, decided_at = now() where id = p_sponsor_asset_id;
  else
    update app.sponsor_assets set revision = revision + 1 where id = p_sponsor_asset_id;
  end if;
  perform private.end_trusted_operation('sponsor_asset_review');
  return v_entry;
end;
$$;

comment on function app.respond_sponsor_asset(uuid, app.review_state, app.review_state, text) is 'The sponsor''s answer on a brand asset (journey 47): an Account Owner or Admin of the sponsor account, while its Sponsor engagement is in the operational area, approves or returns a Submitted asset (a return says what to change) or resubmits a Returned one as a new revision. Compare-and-set; the move is recorded in the asset''s ledger and emits sponsor_asset.state_changed.';

revoke all on function private.sponsor_side_open(uuid) from public, anon;
grant execute on function private.sponsor_side_open(uuid) to authenticated, service_role;
revoke all on function app.respond_sponsor_asset(uuid, app.review_state, app.review_state, text) from public, anon;
grant execute on function app.respond_sponsor_asset(uuid, app.review_state, app.review_state, text) to authenticated, service_role;
revoke all on api_external.sponsor_assets from public, anon;
grant select on api_external.sponsor_assets to authenticated, service_role;

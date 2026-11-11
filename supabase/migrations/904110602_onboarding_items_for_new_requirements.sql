-- 4.11 fix (4.9 surface crawl): a requirement added after an engagement exists reaches that engagement's onboarding.
-- 0730 creates onboarding items only when an engagement is inserted (t85_create_onboarding_items), while the activation
-- guard and private.engagement_open_blocking_requirements read the requirements that apply now. A blocking requirement
-- added later therefore refused the move to Active (onboarding_incomplete) without ever appearing in the worker's
-- Onboarding tab or on Gateway Home, and nothing in the product could add the item: the worker had nothing to complete,
-- and the org could unblock only by deleting the requirement or making it non-blocking.
--
--   * private.create_requirement_onboarding_items (trigger t85 on app.onboarding_requirements, after insert, and after
--     an update that can change where a requirement applies: its role type, its jurisdiction, or its restoration from
--     deletion): one item for each live, unfinished engagement (not Complete or Canceled) of the org the requirement now
--     applies to (private.engagement_requirement_ids, 0730's rule), where it has no live item yet.
--   * The same rule backfills the items missing today, so engagements blocked this way show what they owe.
-- An item keeps its engagement and requirement (0730's guard); removing a requirement still leaves its items, and the
-- guard stops counting it, as before.

create or replace function private.create_requirement_onboarding_items()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.deleted_at is not null then
    return null;
  end if;
  insert into app.onboarding_items (engagement_id, onboarding_requirement_id)
  select e.id, new.id
  from app.engagements e
  where e.org_id = new.org_id and e.deleted_at is null
    and e.engagement_state not in ('Complete', 'Canceled')
    and new.id in (select private.engagement_requirement_ids(e.id))
    and not exists (
      select 1 from app.onboarding_items i
      where i.engagement_id = e.id and i.onboarding_requirement_id = new.id and i.deleted_at is null);
  return null;
end;
$$;

comment on function private.create_requirement_onboarding_items() is 'After an onboarding requirement is added, restored, or changes its role type or jurisdiction (904110602): one onboarding item for each live engagement of the org that is not Complete or Canceled, that the requirement now applies to (private.engagement_requirement_ids) and that has no live item for it, so a requirement that blocks activation always shows in the worker''s onboarding.';
revoke all on function private.create_requirement_onboarding_items() from public, anon, authenticated;

create trigger t85_create_requirement_onboarding_items after insert or update of role_type, jurisdiction_id, deleted_at
  on app.onboarding_requirements
  for each row execute function private.create_requirement_onboarding_items();

-- The items missing today: every live requirement that applies to a live, unfinished engagement without its item.
insert into app.onboarding_items (engagement_id, onboarding_requirement_id)
select e.id, r.id
from app.engagements e
cross join lateral private.engagement_requirement_ids(e.id) r (id)
where e.deleted_at is null and e.engagement_state not in ('Complete', 'Canceled')
  and not exists (
    select 1 from app.onboarding_items i
    where i.engagement_id = e.id and i.onboarding_requirement_id = r.id and i.deleted_at is null);

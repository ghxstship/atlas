-- 2623_engagement_offerings_view.sql
-- R3 Org and project offerings (RRR-181, owner decision 7). Gateway reads what the org offers on each engagement the
-- caller reaches, and shows the Travel and lodging, Per diem, Hospitality and Guest list tabs from it.
--
--   * private.my_engagement_offerings(engagement): the resolver's rows (private.effective_offerings) for one live
--     engagement whose engagement area the caller reaches (private.engagement_scope, so the 18-month time box after
--     Complete or Canceled applies, Section 8.7); no rows for any other engagement. A view checks EXECUTE on the
--     functions it calls as the caller, and the resolver stays closed to signed-in callers, so this definer function
--     is the one door. It takes the engagement so the view calls it laterally per engagement: a reader's
--     engagement_id filter reaches app.engagements first and the resolver runs only for that engagement.
--   * api_external.engagement_offerings: one row per offering for each engagement the caller reaches
--     (private.my_engagement_ids('engagement'), as api_external.engagements), with the mode and caps. Which layer
--     decided is internal to the producing org and never appears.

create or replace function private.my_engagement_offerings(p_engagement_id uuid)
returns table (
  offering app.offering_kind,
  offering_mode app.offering_mode,
  cap_per_engagement integer,
  cap_per_person integer
)
language sql
stable
security definer
set search_path = ''
as $$
  select o.offering, o.offering_mode, o.cap_per_engagement, o.cap_per_person
  from private.effective_offerings(p_engagement_id) o
  where exists (select 1 from private.engagement_scope(p_engagement_id) a where a = 'engagement');
$$;

comment on function private.my_engagement_offerings(uuid) is 'The offerings of one live engagement whose engagement area the signed-in person reaches as an external party (private.engagement_scope, with the Section 8.7 time box), from private.effective_offerings, without the deciding layer; no rows for any other engagement. Serves api_external.engagement_offerings (R3).';
revoke all on function private.my_engagement_offerings(uuid) from public, anon;
grant execute on function private.my_engagement_offerings(uuid) to authenticated, service_role;

create view api_external.engagement_offerings as
select e.id as engagement_id, m.offering, m.offering_mode, m.cap_per_engagement, m.cap_per_person
from app.engagements e
cross join lateral private.my_engagement_offerings(e.id) m
where e.deleted_at is null and e.id in (select private.my_engagement_ids('engagement'));

call private.describe('api_external.engagement_offerings', 'What the producing org offers on the caller''s engagements (R3, owner decision 7): one row per offering for each engagement whose engagement area the caller reaches, Not Offered unless the org, the project or an audience rule offers it. The layer that decided never appears.', array[
  'engagement_id', 'Engagement the offering applies to.',
  'offering', 'Offering.',
  'offering_mode', 'How the offering reaches the engagement: Not Offered, Provided, Reimbursed or Buyout.',
  'cap_per_engagement', 'Most units the engagement may request; NULL for no cap.',
  'cap_per_person', 'Most units one person may request; NULL for no cap.'
]);

revoke all on api_external.engagement_offerings from public, anon;
grant select on api_external.engagement_offerings to authenticated, service_role;

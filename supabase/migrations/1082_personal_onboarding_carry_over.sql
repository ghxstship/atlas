-- 1082_personal_onboarding_carry_over.sql
-- A38 (RRR-82), found by journey 42. private.requirement_satisfied (0730) carries a verified item over
-- from any other engagement of the same person OR the same counterparty in the org. For a company-level
-- step (a W-9, an insurance certificate, payout details) sharing across the company's engagements is
-- right. For a personal step it is not: when a staffing agency supplies several people, one staff
-- member's verified safety-briefing acknowledgment satisfied the same requirement for every colleague,
-- so a person who never acknowledged anything could be made Active and given positions.
--
-- Personal kinds (Training, Acknowledgment, Certification, Background Check) now carry over only from
-- the same person's engagements; every other kind keeps the person-or-company rule. Same signature, so
-- the blocking guard, the item status view and every caller pick it up.

create or replace function private.requirement_satisfied(p_engagement_id uuid, p_requirement_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from app.engagements e
    join app.onboarding_requirements r on r.id = p_requirement_id
    join app.engagements e2 on e2.org_id = e.org_id and e2.deleted_at is null
      and (
        e2.id = e.id
        or e2.person_id = e.person_id
        or (r.item_kind not in ('Training', 'Acknowledgment', 'Certification', 'Background Check')
            and e2.counterparty_id = e.counterparty_id)
      )
    join app.onboarding_items i on i.engagement_id = e2.id and i.onboarding_requirement_id = p_requirement_id and i.deleted_at is null
    where e.id = p_engagement_id and private.onboarding_item_passes(i.id)
  );
$$;

comment on function private.requirement_satisfied(uuid, uuid) is 'True when the engagement has a passing item for the requirement, or a verified, unexpired item for the same requirement carries over from another engagement in the org: of the same person for personal steps (Training, Acknowledgment, Certification, Background Check), of the same person or the same company for every other step (Section 4.4.4; A38, 1082).';

-- 6822_crew_ratings_rating_rule.sql
-- RRR-248, ADR 0158 (merge train 11). B9's crew_ratings report source (6517) read every Organization rating on the
-- engagements its reader reads. A rating of a person stays with the org that gave it (6820): a partner on a shared project
-- must not read it, and a rating removed by an upheld dispute leaves every product read. app.crew_ratings now applies the
-- same rule as app.ratings, through private.internal_rating_engagement_ids and private.removed_rating_ids. Its columns
-- are 6517's.

create or replace view app.crew_ratings as
select g.id, g.org_id, e.project_id, coalesce(o.name, ep.full_name) as party_name, e.role_type::text as role_type, g.score,
  g.submitted_at
from app.ratings g
join app.engagements e on e.id = g.engagement_id
left join app.counterparties c on c.id = e.counterparty_id
left join app.organizations o on o.id = c.organization_id
left join app.people ep on ep.id = e.person_id
where g.deleted_at is null and g.rater_side = 'Organization'
  and g.engagement_id in (select private.internal_rating_engagement_ids())
  and g.id not in (select private.removed_rating_ids());

call private.describe('app.crew_ratings', 'Report source crew_ratings (B9): the org''s own ratings of the parties it engaged (rater_side Organization), on engagements whose rating the reader reads as the org (private.internal_rating_engagement_ids, ADR 0158), without ratings removed by an upheld dispute. Comments never appear. Owner-rights view with its own row filter.', array[
  'id', 'Rating.',
  'org_id', 'Org.',
  'project_id', 'Project of the engagement.',
  'party_name', 'The party rated: the company, or the person engaged.',
  'role_type', 'Role type of the engagement.',
  'score', 'Score from 1 to 5.',
  'submitted_at', 'When the rating was submitted.'
]);

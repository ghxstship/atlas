-- 0981_people_crew_late.sql
-- A13 People and Crew, late slot (ADR 0022 section 2). Pieces that reference later ranges:
--   * Per diems for external crew: app.per_diems gains a nullable engagement_id (app.engagements, 0700),
--     like time entries in A03F's 0940. A per diem names exactly one of membership_id or engagement_id,
--     the engagement belongs to the same project and must be Active or Closing for a new allowance, and
--     the engaged person reads their own allowances within the Section 8.7 time box.
--   * agreements.offer_id references app.offers (A28, 0720); A03F created the column and its index.
--   * People and Crew records become commentable through A18's comment service (0580).

-- Per diems for external crew -----------------------------------------------------------------------------

alter table app.per_diems add column engagement_id uuid references app.engagements (id);
create index per_diems_engagement_id_idx on app.per_diems (engagement_id, day);
alter table app.per_diems alter column membership_id drop not null;
alter table app.per_diems add constraint per_diems_one_worker check (num_nonnulls(membership_id, engagement_id) = 1);
create unique index per_diems_one_per_engagement_day on app.per_diems (project_id, engagement_id, day)
  where engagement_id is not null and deleted_at is null;

comment on column app.per_diems.engagement_id is 'Engagement of the external person paid, when they have no membership. Exactly one of membership_id and engagement_id.';
comment on column app.per_diems.membership_id is 'Membership of the person paid; NULL for external crew, who are paid through engagement_id.';

call private.install_tenant_guards('app.per_diems', 'app.projects', 'project_id',
  array['app.memberships', 'membership_id', 'app.engagements', 'engagement_id']);

create trigger t39_per_diem_engagement_project before insert or update of engagement_id on app.per_diems
  for each row execute function private.assert_same_project('app.engagements', 'engagement_id');
create trigger t38_guard_engaged_worker before insert or update of engagement_id on app.per_diems
  for each row execute function private.guard_engaged_worker();

call private.install_policies('app.per_diems',
  $$project_id in (select private.project_ids_with('crew.time_entry.read'))
    or membership_id in (select private.my_membership_ids())
    or engagement_id in (select private.my_engagement_ids('operational'))$$,
  $$project_id in (select private.project_ids_with('crew.time_entry.write'))$$);

-- Agreements made from an offer ----------------------------------------------------------------------------------

alter table app.agreements add constraint agreements_offer_id_fkey foreign key (offer_id) references app.offers (id);

-- Commentable People and Crew records ------------------------------------------------------------------------------

insert into private.comment_subjects (table_name) values
  ('app.shift_swaps'),
  ('app.time_entries'),
  ('app.rate_cards'),
  ('app.pay_periods'),
  ('app.time_off_requests'),
  ('app.requisitions'),
  ('app.agreements'),
  ('app.role_assignments')
on conflict (table_name) do nothing;

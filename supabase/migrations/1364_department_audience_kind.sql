-- 1364_department_audience_kind.sql
-- A80 (RRR-125), finding A65-021, Section 4.9 Feed: announcements and updates reach people "by org, project,
-- department, team or role", and app.audience_kind (0800) had no Department. This migration adds the value and
-- the columns that key a department audience by canon department code (xpms.dim_department, Bible tab 04).
-- The functions that use the new value follow in 1365: Postgres lets a new enum value be used only after the
-- transaction that adds it commits.

alter type app.audience_kind add value if not exists 'Department' after 'Team';
comment on type app.audience_kind is 'Who a feed post, survey or event reaches: the whole org, one project, one team, one canon department (feed posts, 1365), one org role or one group.';

alter table app.feed_posts add column department_code text references xpms.dim_department (dept_code);
comment on column app.feed_posts.department_code is 'Canon department code of a Department audience (xpms.dim_department), for example 5000; set only for Department posts.';
create index feed_posts_department_idx on app.feed_posts (department_code);
comment on column app.feed_posts.audience_kind is 'Who the post reaches: Organization, Project, Team, Department, Role or Group.';

alter table app.groups add column department_code text references xpms.dim_department (dept_code);
comment on column app.groups.department_code is 'Canon department a Department group gathers (xpms.dim_department), so Department audiences reach its members; set only on Department groups.';
create index groups_department_idx on app.groups (department_code);
alter table app.groups add constraint groups_department_kind check (department_code is null or group_kind = 'Department');

-- 2611_individual_artist_riders.sql
-- R2 Advancing read gaps (RRR-180, ADR 0100 to 0104). A rider may belong to an individual artist's engagement rather
-- than to an account, so an artist booked without an agency reads the rider Atlas assigned them (Section 4.4.4
-- Artist: riders).
--
--   * app.riders gains engagement_id: a live Artist engagement of the same project that names a person. A rider names
--     at most one party, a counterparty or an engagement.
--   * api_external.riders (from 0768) left joins the counterparty, so an engagement rider has no account, appends
--     engagement_id, and opens an engagement rider to the engagement's principals (private.engagement_principal, R1:
--     the artist and their Advance representative). Account riders read as before; api_external.rider_lines follows.
-- API v1 is unchanged: the riders resource (packages/api/src/catalog/modules/advancing.ts) does not expose the new
-- column, so scripts/contract-audit reports riders.engagement_id as an expected extra_column.

-- Column ----------------------------------------------------------------------------------------------------------------

alter table app.riders add column engagement_id uuid references app.engagements (id);
create index riders_engagement_id_idx on app.riders (engagement_id);
alter table app.riders add constraint riders_one_party check (num_nonnulls(counterparty_id, engagement_id) <= 1);
comment on column app.riders.engagement_id is 'Artist engagement of the same project the rider belongs to, for an artist booked as a person; never set together with counterparty_id.';

-- The cross-org reference guard now covers the engagement as well as the counterparty (0351), read from pg_trigger.
call private.add_cross_org_references('app.riders', array['app.engagements', 'engagement_id']);

create trigger t39_rider_engagement_project before insert or update on app.riders
  for each row execute function private.assert_same_project('app.engagements', 'engagement_id');

create or replace function private.guard_rider_engagement()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.engagement_id is not null and not exists (
    select 1 from app.engagements e
    where e.id = new.engagement_id and e.deleted_at is null and e.engagement_state not in ('Complete', 'Canceled')
      and e.role_type = 'Artist' and e.person_id is not null) then
    perform private.refuse('rider_engagement_artist', 'A rider belongs to a live Artist engagement that names a person.');
  end if;
  return new;
end;
$$;

comment on function private.guard_rider_engagement() is 'Riders (R2): an engagement, when given, is live (not deleted, Complete or Canceled), an Artist engagement, and names a person.';
revoke all on function private.guard_rider_engagement() from public, anon, authenticated;

create trigger t40_guard_rider_engagement before insert or update of engagement_id on app.riders
  for each row execute function private.guard_rider_engagement();

-- View --------------------------------------------------------------------------------------------------------------------

create or replace view api_external.riders as
select r.id, r.project_id, p.name as project_name, c.organization_id as account_id, r.title, r.engagement_id
from app.riders r
join app.projects p on p.id = r.project_id
left join app.counterparties c on c.id = r.counterparty_id
where r.deleted_at is null
  and (private.rider_party_open(r.project_id, r.counterparty_id)
    or (r.engagement_id is not null and private.engagement_principal(r.engagement_id)));

call private.describe('api_external.riders', 'Riders of the caller''s account on projects where it, or an artist it represents, is engaged in the operational area, and riders of an individual artist''s engagement for its principals (the artist and their Advance representative) while its operational area is open.', array[
  'id', 'Rider.', 'project_id', 'Project.', 'project_name', 'Project name.', 'account_id', 'Account whose rider it is; NULL for an engagement''s rider.',
  'title', 'Title.', 'engagement_id', 'Artist engagement whose rider it is, for an artist booked as a person.']);

-- Grants are kept by create or replace; restated so this file reads whole.
revoke all on api_external.riders from public, anon;
grant select on api_external.riders to authenticated, service_role;

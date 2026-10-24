-- 1390_engagement_project_time_zone.sql
-- Orchestrator (RRR-116). Gateway's engagement pages took "today" from the UTC clock, a day ahead every evening in
-- the Americas: an onboarding item due today showed as overdue, an invoice defaulted to the next month on a month's
-- last evening. The engagement's dates follow its project's calendar (app.projects.time_zone, NOT NULL and checked
-- against the IANA database), the calendar private.project_today uses (1305). api_external.engagements gains that zone
-- as its last column, so external parties can read it; the row filter and every other column are unchanged.

create or replace view api_external.engagements as
select e.id, e.org_id, o.name as org_name, e.project_id, p.name as project_name, e.role_type, e.role_code, r.job_title,
  e.person_id, c.organization_id as account_id, e.pay_basis, e.arrangement,
  case when 'money' = any (a.areas) then coalesce(e.agreed_rate_minor, ol.rate_minor, rc.standard_rate_minor) end as rate_minor,
  case when 'money' = any (a.areas) then
    case when e.agreed_rate_minor is not null then e.currency_code when ol.rate_minor is not null then ol.currency_code else rc.currency_code end
  end as rate_currency_code,
  e.start_date, e.end_date, e.engagement_state, a.areas, p.time_zone as project_time_zone
from app.engagements e
join app.organizations o on o.id = e.org_id
join app.projects p on p.id = e.project_id
join xpms.role r on r.role_code = e.role_code
left join app.counterparties c on c.id = e.counterparty_id
left join xpms.rate_card rc on rc.role_code = e.role_code and rc.worker_classification = e.worker_classification
  and rc.pay_basis = e.pay_basis and rc.arrangement = e.arrangement
left join lateral (
  select l.rate_minor, k.currency_code
  from app.rate_card_lines l join app.rate_cards k on k.id = l.rate_card_id
  where l.org_id = e.org_id and l.deleted_at is null and k.deleted_at is null
    and l.role_code = e.role_code and l.worker_classification = e.worker_classification
    and l.pay_basis = e.pay_basis and l.arrangement = e.arrangement
    and k.effective_from <= e.start_date and (k.effective_to is null or k.effective_to >= e.start_date)
  order by k.effective_from desc limit 1
) ol on true
cross join lateral (select array(select s from private.engagement_scope(e.id) s order by s) as areas) a
where e.deleted_at is null and e.id in (select private.my_engagement_ids('engagement'));

comment on column api_external.engagements.project_time_zone is 'IANA time zone of the engagement''s project: the calendar its dates (due today, this week, the default invoice date) follow.';

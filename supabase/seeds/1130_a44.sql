-- 1130_a44.sql
-- A44 (RRR-88), journey 62 (finding A38-003): the demo org's Public profile shows a verified domain from its
-- verified app.org_domains row and two published case studies, and it appears in Gateway's Explore. Builds on
-- 0010 and 0230 and loads cleanly without them. Idempotent: every insert checks for its row first.

do $$
declare
  v_org constant uuid := '01920000-0000-7000-8000-000000000001';
  v_domain uuid;
begin
  if not exists (select 1 from app.organizations o where o.id = v_org) then
    return;
  end if;

  if not exists (select 1 from app.org_domains d where d.org_id = v_org and d.hostname = 'demo-productions.example.com'
                 and d.purpose = 'Verified Domain' and d.deleted_at is null) then
    insert into app.org_domains (org_id, hostname, purpose)
    values (v_org, 'demo-productions.example.com', 'Verified Domain') returning id into v_domain;
    perform app.record_domain_verification(v_domain, true);
  end if;

  insert into app.organization_case_studies (org_id, title, summary, published, sort_order)
  select v_org, c.title, c.summary, true, c.ord
  from (values
    ('Bayfront Summer Series', 'Six weekends of outdoor concerts: staging, rigging and show operations for 40 performances.', 1),
    ('Arena residency changeovers', 'Overnight changeovers between touring productions, with crews staffed and paid through Atlas.', 2)
  ) as c (title, summary, ord)
  where not exists (select 1 from app.organization_case_studies x where x.org_id = v_org and x.title = c.title and x.deleted_at is null);
end;
$$;

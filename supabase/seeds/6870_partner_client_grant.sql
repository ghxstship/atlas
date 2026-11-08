-- 6870_partner_client_grant.sql
-- The demo partner (1060_a36.sql) may create client orgs, as a platform operator would allow under a signed
-- partner agreement (migration 6870), so the partner console journey can create its clients. The demo has no
-- operator, so the grant names the partner's Owner. Idempotent.

insert into private.partner_client_grants (org_id, reason, granted_by)
select o.id, 'Demo: signed partner agreement.', p.id
from app.organizations o
join app.people p on p.id = '01920000-0000-7000-8000-000010600101'
where o.id = '01920000-0000-7000-8000-000010600001'
on conflict (org_id) do nothing;

-- 0950_project_currency_org_default.sql
-- A07 late slot (ADR 0022: 0950 to 0954). The project currency's last fallback reads A30's settings
-- registry (0850, 0851), which runs after A07's range, so it lives here:
--   given currency, else the jurisdiction country's currency, else the org's org.base_currency
--   setting, else that setting's registry default. A project then always has a currency, and the
--   column becomes required. Section 3.7 is kept: every step is a stated value, none is invented.

create or replace function private.org_base_currency(p_org_id uuid)
returns char(3)
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select upper(v.value_text) from app.setting_values v
     where v.org_id = p_org_id and v.setting_key = 'org.base_currency' and v.scope_kind = 'Organization'
       and v.scope_id = p_org_id and v.deleted_at is null
     limit 1),
    (select upper(d.default_text) from private.setting_definitions d where d.setting_key = 'org.base_currency')
  )::char(3);
$$;

comment on function private.org_base_currency(uuid) is 'The org''s base currency: its org.base_currency setting, else the registry default. Takes the org id as an argument (ADR 0016 rule 14).';

create or replace function private.default_project_currency()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.currency_code is null then
    new.currency_code := coalesce(
      private.project_jurisdiction_currency(new.jurisdiction_id),
      private.org_base_currency(new.org_id));
  end if;
  if new.currency_code is null then
    perform private.refuse('project_currency_required',
      'Choose the project currency, or set the organization''s base currency.');
  end if;
  return new;
end;
$$;

comment on function private.default_project_currency() is 'Before insert or update on app.projects: fills an absent currency from the jurisdiction''s country, then the org base currency setting, and refuses a project with none.';

update app.projects p
set currency_code = coalesce(private.project_jurisdiction_currency(p.jurisdiction_id), private.org_base_currency(p.org_id))
where p.currency_code is null;

alter table app.projects alter column currency_code set not null;

revoke all on function private.org_base_currency(uuid) from public, anon, authenticated;

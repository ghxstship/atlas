-- 0985_credentials_late.sql
-- A14 late slot (broadcast 1, section 6): references to ranges that run after the A14 main range.
-- app.engagements (0700) for party badges, and A18's audit trail (0501) and retention (0550) for the
-- module's tables.

-- Party badges: a credential may belong to an engagement (Section 4.5.7, artist and party badges) ------------------

alter table app.credentials add column engagement_id uuid references app.engagements (id);
create index credentials_engagement_id_idx on app.credentials (engagement_id);
comment on column app.credentials.engagement_id is 'Engagement the credential was issued under, such as an artist''s party badge; NULL for a credential issued directly.';

create or replace function private.guard_credential_engagement()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.engagement_id is not null and not exists (
      select 1 from app.engagements e where e.id = new.engagement_id and e.project_id = new.project_id and e.deleted_at is null) then
    perform private.refuse('credential_engagement_project', 'A credential''s engagement belongs to the same project as its category.');
  end if;
  return new;
end;
$$;
comment on function private.guard_credential_engagement() is 'Credentials: an engagement, when given, is a live engagement on the credential''s project.';
revoke all on function private.guard_credential_engagement() from public, anon, authenticated;
create trigger t42_guard_credential_engagement before insert or update of engagement_id, credential_category_id on app.credentials
  for each row execute function private.guard_credential_engagement();

-- Audit trails (Section 19.6): every change to the module's tables lands in app.audit_events. Restricted
-- medical notes never enter a diff (private.audit_excluded_columns).

call private.install_audit_trail('app.credential_categories');
call private.install_audit_trail('app.credentials');
call private.install_audit_trail('app.access_grid');
call private.install_audit_trail('app.incidents');
call private.install_audit_trail('app.incident_parties');
call private.install_audit_trail('app.incident_media');
call private.install_audit_trail('app.dispatch_assignments');
call private.install_audit_trail('app.medical_encounters');
call private.install_audit_trail('app.crisis_alerts');
call private.install_audit_trail('app.radio_channels');

-- Retention (ADR 0002) for the module's tables that have no policy yet.

call private.install_default_retention('app.credential_categories');
call private.install_default_retention('app.credentials');
call private.install_default_retention('app.access_grid');
call private.install_default_retention('app.access_scans');
call private.install_default_retention('app.incidents');
call private.install_default_retention('app.incident_parties');
call private.install_default_retention('app.incident_media');
call private.install_default_retention('app.dispatch_assignments');
call private.install_default_retention('app.medical_encounters');
call private.install_default_retention('app.crisis_alerts');
call private.install_default_retention('app.radio_channels');

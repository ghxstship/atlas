-- 1201_org_ip_allowlist.sql
-- A52 settings features (RRR-97, ADR 0032 amendment). Settings, Security (Section 4.5.6 item 10) holds the IP allow-list,
-- Section 9 says "Org IP allow-lists cover Atlas and the API", Section 7.3 names `org_ip_allowlist` and Section 16 puts the
-- feature on the Team plan (app.plan_feature_code 'ip_allowlist'). A50 retired orgIpAllowlistEntries because nothing stored
-- or enforced it; the only trace was the free-text setting security.ip_allowlist, which nothing read.
--   * app.org_ip_allowlist holds the allowed networks (CIDR blocks) with a label; read with org.settings.read, written with
--     org.security.write, and only on a plan with the ip_allowlist feature. A block covering every address is refused.
--   * security.ip_allowlist becomes the Boolean switch that turns enforcement on. It defaults to off, so no org is locked
--     out by this migration: an org enforces only after it lists at least one network and turns the switch on. The switch
--     cannot turn on with an empty list, and the last entry cannot be removed while it is on.
--   * Any address an org typed into the old free-text setting is carried into the table (labelled as imported) and the old
--     text value is cleared; enforcement stays off until someone turns it on.
--   * Enforcement is where sessions and API keys are checked, because only those layers see the caller's own address:
--     the public API runtime checks every credential, session or API key, before its handler runs, and Atlas checks
--     before resolving a member's context in an org (pages, server actions and the proxy route guard). Both ask
--     app.network_access, which answers for the caller's own orgs only. Enforcement applies while the org's plan includes
--     the feature; a downgrade keeps the entries and stops enforcing them (Section 16: downgrades never delete data).

create table app.org_ip_allowlist (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  cidr cidr not null,
  label text not null,
  deleted_at timestamptz,
  constraint org_ip_allowlist_label_length check (char_length(btrim(label)) between 1 and 100),
  constraint org_ip_allowlist_not_everything check (masklen(cidr) > 0)
);

create unique index org_ip_allowlist_org_cidr_key on app.org_ip_allowlist (org_id, cidr) where deleted_at is null;

call private.install_domain_table('app.org_ip_allowlist');
call private.describe('app.org_ip_allowlist', 'Networks allowed to reach Atlas and the API for an org (Section 9, Section 4.5.6 item 10). Enforced only while the org''s security.ip_allowlist switch is on and its plan includes the ip_allowlist feature (Team and Enterprise).', array[
  'cidr', 'Allowed network as a CIDR block, IPv4 or IPv6, for example 203.0.113.0/24. A block covering every address is refused.',
  'label', 'What the network is, for example Office or VPN.'
]);

call private.install_policies('app.org_ip_allowlist',
  $$org_id in (select private.orgs_with_capability('org.settings.read'))$$,
  $$org_id in (select private.orgs_with_capability('org.security.write'))$$);

revoke insert, update on app.org_ip_allowlist from authenticated;
grant insert (org_id, cidr, label) on app.org_ip_allowlist to authenticated;
grant update (label, deleted_at) on app.org_ip_allowlist to authenticated;

call private.install_default_retention('app.org_ip_allowlist');
call private.install_audit_trail('app.org_ip_allowlist');

-- The enforcement switch ---------------------------------------------------------------------------------------------
-- security.ip_allowlist was Text (0851); it becomes the Boolean switch. The statement below is the registry rendering of
-- packages/schemas/settings/a30.yaml, pasted verbatim (the settings test compares them).

select private.define_setting('security.ip_allowlist', 'Boolean', 'org.security.write', array['organization'], false, p_default_boolean => false);

create or replace function private.try_cidr(p_text text)
returns cidr
language plpgsql
immutable
set search_path = ''
as $$
begin
  return p_text::cidr;
exception when invalid_text_representation then
  return null;
end;
$$;

comment on function private.try_cidr(text) is 'A CIDR block parsed from text, or NULL when the text is not one (for example host bits set or a typo).';
revoke all on function private.try_cidr(text) from public, anon, authenticated;

-- Carry the addresses an org typed into the old text value into the table, then clear the text value.
insert into app.org_ip_allowlist (org_id, cidr, label)
select distinct v.org_id, private.try_cidr(btrim(part)), 'Imported from the earlier allow-list setting'
from app.setting_values v
cross join lateral regexp_split_to_table(coalesce(v.value_text, ''), '[\s,;]+') as part
where v.setting_key = 'security.ip_allowlist' and v.deleted_at is null and v.value_text is not null
  and btrim(part) <> '' and private.try_cidr(btrim(part)) is not null and masklen(private.try_cidr(btrim(part))) > 0
on conflict do nothing;

update app.setting_values v set deleted_at = now()
where v.setting_key = 'security.ip_allowlist' and v.deleted_at is null and v.value_boolean is null;

-- Guards ---------------------------------------------------------------------------------------------------------------

create or replace function private.ip_allowlist_enforced(p_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select v.value_boolean from app.setting_values v
                   where v.org_id = p_org_id and v.setting_key = 'security.ip_allowlist' and v.scope_kind = 'Organization'
                     and v.scope_id = p_org_id and v.deleted_at is null), false)
    and private.org_has_feature(p_org_id, 'ip_allowlist')
    and exists (select 1 from app.org_ip_allowlist a where a.org_id = p_org_id and a.deleted_at is null);
$$;

comment on function private.ip_allowlist_enforced(uuid) is 'True when an org enforces its IP allow-list: the security.ip_allowlist switch is on, the plan includes ip_allowlist and at least one network is listed. Off by default.';
revoke all on function private.ip_allowlist_enforced(uuid) from public, anon, authenticated;

create or replace function private.ip_allowed(p_org_id uuid, p_ip inet)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select not private.ip_allowlist_enforced(p_org_id)
    or (p_ip is not null and exists (
      select 1 from app.org_ip_allowlist a
      where a.org_id = p_org_id and a.deleted_at is null and p_ip <<= a.cidr));
$$;

comment on function private.ip_allowed(uuid, inet) is 'Whether an address may reach an org: always while the org does not enforce its allow-list, otherwise only an address inside a listed network. An unknown address is refused while enforcing.';
revoke all on function private.ip_allowed(uuid, inet) from public, anon, authenticated;

create or replace function private.guard_org_ip_allowlist()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' and auth.uid() is not null and not private.org_has_feature(new.org_id, 'ip_allowlist') then
    perform private.refuse('plan_feature_ip_allowlist', 'The IP allow-list is part of the Team and Enterprise plans.');
  end if;
  if tg_op = 'UPDATE' and old.deleted_at is not null and new.deleted_at is null then
    perform private.refuse('ip_allowlist_entry_deleted', 'Add a removed network again instead of restoring it.');
  end if;
  if tg_op = 'UPDATE' and new.deleted_at is not null and old.deleted_at is null
     and private.ip_allowlist_enforced(new.org_id)
     and not exists (select 1 from app.org_ip_allowlist a where a.org_id = new.org_id and a.deleted_at is null and a.id <> new.id) then
    perform private.refuse('ip_allowlist_last_entry', 'Turn the allow-list off before removing its last network.');
  end if;
  return new;
end;
$$;

comment on function private.guard_org_ip_allowlist() is 'IP allow-list entries: added only on a plan with the ip_allowlist feature, never restored once removed, and the last entry stays while the allow-list is enforced.';
revoke all on function private.guard_org_ip_allowlist() from public, anon, authenticated;

create trigger t40_guard_org_ip_allowlist before insert or update on app.org_ip_allowlist
  for each row execute function private.guard_org_ip_allowlist();

create or replace function private.guard_ip_allowlist_switch()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.setting_key = 'security.ip_allowlist' and new.deleted_at is null and coalesce(new.value_boolean, false) then
    if not private.org_has_feature(new.org_id, 'ip_allowlist') then
      perform private.refuse('plan_feature_ip_allowlist', 'The IP allow-list is part of the Team and Enterprise plans.');
    end if;
    if not exists (select 1 from app.org_ip_allowlist a where a.org_id = new.org_id and a.deleted_at is null) then
      perform private.refuse('ip_allowlist_empty', 'List at least one network before turning the allow-list on.');
    end if;
  end if;
  return new;
end;
$$;

comment on function private.guard_ip_allowlist_switch() is 'The security.ip_allowlist switch turns on only on a plan with the feature and with at least one network listed, so turning it on never locks out every address.';
revoke all on function private.guard_ip_allowlist_switch() from public, anon, authenticated;

create trigger t41_guard_ip_allowlist_switch before insert or update on app.setting_values
  for each row when (new.setting_key = 'security.ip_allowlist')
  execute function private.guard_ip_allowlist_switch();

-- What Atlas and the API ask -----------------------------------------------------------------------------------------

create or replace function app.network_access(p_org_id uuid, p_ip text)
returns table (enforced boolean, allowed boolean, covered boolean)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_ip inet;
begin
  if p_org_id is null or not (p_org_id in (select private.my_org_ids())) then
    return;
  end if;
  begin
    v_ip := nullif(btrim(coalesce(p_ip, '')), '')::inet;
  exception when invalid_text_representation then
    v_ip := null;
  end;
  return query select private.ip_allowlist_enforced(p_org_id), private.ip_allowed(p_org_id, v_ip),
    (v_ip is not null and exists (select 1 from app.org_ip_allowlist a
                                  where a.org_id = p_org_id and a.deleted_at is null and v_ip <<= a.cidr));
end;
$$;

comment on function app.network_access(uuid, text) is 'Whether the given client address may reach one of the caller''s orgs (Section 9 IP allow-list): enforced says whether the org enforces its list, allowed whether the address passes, and covered whether a listed network contains it (so turning enforcement on would keep the caller in). Answers only for orgs the caller belongs to (no row otherwise). The public API runtime and Atlas call it with the address their proxy reports.';
revoke all on function app.network_access(uuid, text) from public, anon;
grant execute on function app.network_access(uuid, text) to authenticated, service_role;

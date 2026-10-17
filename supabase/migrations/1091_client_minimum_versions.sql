-- 1091_client_minimum_versions.sql
-- A39 Compass device QA. Section 5.1: "Compass checks a server-advertised minimum version at launch.
-- Below it, a blocking screen sends the user to update." Nothing advertised one (journey 40):
--   * private.client_minimum_versions: the lowest native build each client and platform may run, with the
--     store page the update screen opens. Platform configuration, not tenant data: no org, written only by
--     the service role (operations raise it after a release that must not run beside older builds)
--   * api_public.client_minimum_version: reads it. Callable before sign-in (anon), because the check runs at
--     launch, ahead of the sign-in screen
-- Compass 4.0.0 is the first build, so the floor starts there and no current build is blocked. The store
-- pages are not known yet; update_url stays null until the listings exist, and Compass then tells the
-- person to update from their app store.

create table private.client_minimum_versions (
  client text not null,
  platform text not null,
  minimum_version text not null,
  update_url text,
  updated_at timestamptz not null default now(),
  primary key (client, platform),
  constraint client_minimum_versions_client check (client in ('compass')),
  constraint client_minimum_versions_platform check (platform in ('ios', 'android')),
  constraint client_minimum_versions_semver check (minimum_version ~ '^[0-9]+\.[0-9]+\.[0-9]+$'),
  constraint client_minimum_versions_https check (update_url is null or update_url ~ '^https://')
);

comment on table private.client_minimum_versions is 'Lowest native build each client may run, per platform (Section 5.1 forced update, journey 40). Platform configuration written by the service role; read through api_public.client_minimum_version.';
comment on column private.client_minimum_versions.client is 'Client app: compass.';
comment on column private.client_minimum_versions.platform is 'ios or android.';
comment on column private.client_minimum_versions.minimum_version is 'Lowest version (MAJOR.MINOR.PATCH) allowed to run; older builds show the forced update screen.';
comment on column private.client_minimum_versions.update_url is 'Store page the update screen opens; null while no listing exists.';
comment on column private.client_minimum_versions.updated_at is 'When the floor last changed.';

alter table private.client_minimum_versions enable row level security;
revoke all on private.client_minimum_versions from public, anon, authenticated;
grant select, insert, update on private.client_minimum_versions to service_role;

insert into private.client_minimum_versions (client, platform, minimum_version)
values ('compass', 'ios', '4.0.0'), ('compass', 'android', '4.0.0')
on conflict do nothing;

create or replace function api_public.client_minimum_version(p_client text, p_platform text)
returns table (minimum_version text, update_url text)
language sql
stable
security definer
set search_path = ''
as $$
  select v.minimum_version, v.update_url
  from private.client_minimum_versions v
  where v.client = p_client and v.platform = p_platform;
$$;

comment on function api_public.client_minimum_version(text, text) is 'The lowest version a client build may run on a platform, and the store page to update from (Section 5.1, journey 40). Callable before sign-in: Compass checks it at launch. No row means no floor.';

revoke all on function api_public.client_minimum_version(text, text) from public;
grant execute on function api_public.client_minimum_version(text, text) to anon, authenticated, service_role;

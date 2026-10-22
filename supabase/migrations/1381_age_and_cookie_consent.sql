-- 1381_age_and_cookie_consent.sql
-- A82 compliance flows (RRR-127), finding A65-014 (Sections 14.3 and 14.9). The Terms and the Privacy Policy say every
-- account is 16 or older, but no sign-up asked; the cookie consent log and the privacy signal table existed with no
-- banner and no Global Privacy Control capture. This migration:
--   * records the age confirmation: private.age_confirmations holds one row per person (who, which sign-in, which
--     surface, when, from which address). A password or magic link sign-up records it from the sign-up metadata
--     (age_confirmed = '16', set only when the person ticked the box), through a trigger after the person row exists;
--     anyone else, such as a first Google sign-in, confirms through app.confirm_minimum_age before they create or
--     join anything. app.minimum_age_confirmed() answers for the signed-in person;
--   * keeps api_public.record_cookie_consent as the banner's write, with limits that work when the web shells call it
--     from their servers: 20 decisions per visitor and 300 per address in 10 minutes. The web shells call it from the
--     server, so the address is often the shell's own (see the A82 report); the per-visitor limit is the one that
--     binds a person. A Global Privacy Control signal is recorded as a refusal of every non-essential category, as
--     legal/cookie-policy.md section 2 says, not only of marketing.

-- Age confirmation (Section 14.3 Children, Section 14.9 Minors) --------------------------------------------------

create table private.age_confirmations (
  id uuid primary key default private.uuid_v7(),
  person_id uuid not null references app.people (id) on delete cascade,
  user_id uuid not null,
  minimum_age smallint not null default 16,
  surface text not null,
  confirmed_at timestamptz not null default now(),
  ip inet,
  constraint age_confirmations_person_key unique (person_id),
  constraint age_confirmations_minimum_age check (minimum_age = 16),
  constraint age_confirmations_surface check (surface in ('Atlas', 'Gateway', 'Compass'))
);

comment on table private.age_confirmations is 'Each person''s confirmation that they are 16 or older (Section 14.3 Children, Section 14.9 Minors; Terms of Service 3.2): one row per person, written at sign-up from the ticked box or later through app.confirm_minimum_age, never changed. Evidence for the account age rule; read by the person through app.minimum_age_confirmed().';
comment on column private.age_confirmations.id is 'Confirmation id (UUID v7).';
comment on column private.age_confirmations.person_id is 'Person who confirmed.';
comment on column private.age_confirmations.user_id is 'Sign-in the person used, kept as evidence.';
comment on column private.age_confirmations.minimum_age is 'The age confirmed: 16, the account minimum.';
comment on column private.age_confirmations.surface is 'Where the person confirmed: Atlas, Gateway or Compass.';
comment on column private.age_confirmations.confirmed_at is 'When the person confirmed. Set by the database.';
comment on column private.age_confirmations.ip is 'Client address the confirmation came from, as the platform server or the database saw it.';

alter table private.age_confirmations enable row level security;
revoke all on private.age_confirmations from public, anon, authenticated;
grant select on private.age_confirmations to service_role;

create or replace function app.confirm_minimum_age(p_surface text, p_client_ip inet default null)
returns timestamptz
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
  v_at timestamptz;
begin
  if p_surface is null or p_surface not in ('Atlas', 'Gateway', 'Compass') then
    perform private.refuse('age_surface', 'Name the surface the confirmation came from: Atlas, Gateway or Compass.');
  end if;
  insert into private.age_confirmations (person_id, user_id, surface, ip)
  values (v_person, (select auth.uid()), p_surface, coalesce(p_client_ip, private.request_ip()))
  on conflict (person_id) do nothing;
  select c.confirmed_at into v_at from private.age_confirmations c where c.person_id = v_person;
  return v_at;
end;
$$;

comment on function app.confirm_minimum_age(text, inet) is 'Records that the signed-in person confirmed they are 16 or older (Section 14.3, 14.9), on the surface they used. The first confirmation stands; a repeat answers its time. The client address comes from the platform server, or from the request when absent.';
revoke all on function app.confirm_minimum_age(text, inet) from public, anon;
grant execute on function app.confirm_minimum_age(text, inet) to authenticated, service_role;

create or replace function app.minimum_age_confirmed()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from private.age_confirmations c where c.person_id = private.current_person_id());
$$;

comment on function app.minimum_age_confirmed() is 'True when the signed-in person has confirmed they are 16 or older. The shells ask before a new account creates or joins an org.';
revoke all on function app.minimum_age_confirmed() from public, anon;
grant execute on function app.minimum_age_confirmed() to authenticated, service_role;

-- A password or magic link sign-up carries the ticked box in its metadata: age_confirmed '16' and signup_surface.
-- The person row exists by now (xos_create_person runs first, by name).
create or replace function private.record_signup_age_confirmation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_surface text := coalesce(new.raw_user_meta_data ->> 'signup_surface', 'Atlas');
begin
  if coalesce(new.raw_user_meta_data ->> 'age_confirmed', '') <> '16' then
    return new;
  end if;
  insert into private.age_confirmations (person_id, user_id, surface, ip)
  select p.id, new.id, case when v_surface in ('Atlas', 'Gateway', 'Compass') then v_surface else 'Atlas' end, private.request_ip()
  from app.people p where p.user_id = new.id
  on conflict (person_id) do nothing;
  return new;
end;
$$;

comment on function private.record_signup_age_confirmation() is 'After a sign-up whose metadata says age_confirmed = 16 (the person ticked the box on a sign-up form), records the age confirmation for the new person.';
revoke all on function private.record_signup_age_confirmation() from public, anon, authenticated;

create trigger xos_record_age_confirmation after insert on auth.users
  for each row execute function private.record_signup_age_confirmation();

-- Cookie consent (Section 14.3 ePrivacy) ---------------------------------------------------------------------------

comment on column app.cookie_consent_events.functional is 'Preferences cookies allowed (legal/cookie-policy.md: language, theme, workspace and last-opened org kept for 12 months instead of the visit).';
comment on column app.cookie_consent_events.analytics is 'Performance cookies allowed. XOS sets none today; the banner records the choice so a future cookie starts blocked.';
comment on column app.cookie_consent_events.marketing is 'Marketing cookies allowed. XOS sets none and never offers them; always false.';

create or replace function api_public.record_cookie_consent(
  p_visitor_id text,
  p_org_slug text,
  p_functional boolean,
  p_analytics boolean,
  p_marketing boolean,
  p_banner_version text,
  p_global_privacy_control boolean default false
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_org uuid;
  v_client text;
  v_hash bytea;
  v_gpc boolean := coalesce(p_global_privacy_control, false);
begin
  perform private.require_read_write();
  if p_visitor_id is null or char_length(p_visitor_id) not between 16 and 128 then
    return false;
  end if;
  v_client := coalesce(host(private.request_ip()), 'unknown');
  if private.rate_limit_exceeded('cookie_consent.visitor', p_visitor_id, 20, interval '10 minutes')
     or private.rate_limit_exceeded('cookie_consent', v_client, 300, interval '10 minutes') then
    return false;
  end if;
  perform private.note_rate_event('cookie_consent.visitor', p_visitor_id);
  perform private.note_rate_event('cookie_consent', v_client);
  if p_org_slug is not null then
    select o.id into v_org from app.organizations o where o.slug = p_org_slug and o.deleted_at is null;
  end if;
  v_hash := extensions.digest(p_visitor_id, 'sha256');
  -- Global Privacy Control refuses every non-essential category for the browser (legal/cookie-policy.md section 2).
  insert into app.cookie_consent_events (org_id, person_id, visitor_hash, functional, analytics, marketing, banner_version)
  values (v_org, private.current_person_id(), v_hash,
    coalesce(p_functional, false) and not v_gpc,
    coalesce(p_analytics, false) and not v_gpc,
    false,
    left(coalesce(p_banner_version, 'unknown'), 50));
  if v_gpc then
    insert into app.privacy_signals (org_id, person_id, visitor_hash, signal)
    values (v_org, private.current_person_id(), v_hash, 'Global Privacy Control');
  end if;
  return true;
end;
$$;

comment on function api_public.record_cookie_consent(text, text, boolean, boolean, boolean, text, boolean) is 'Named public RPC for the cookie banner (Section 14.3): stores the decision server-side. Preferences map to functional and Performance to analytics; marketing is never offered and always stored false. A Global Privacy Control signal is recorded in app.privacy_signals and refuses every non-essential category. At most 20 decisions per visitor and 300 per client address in 10 minutes. Returns false when refused.';
revoke all on function api_public.record_cookie_consent(text, text, boolean, boolean, boolean, text, boolean) from public;
grant execute on function api_public.record_cookie_consent(text, text, boolean, boolean, boolean, text, boolean) to anon, authenticated, service_role;

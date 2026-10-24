-- 1331_auth_factor_labels.sql
-- A77 Authentication and step-up (RRR-122). Personal settings, Security lists a person's second factors and lets them
-- rename one (Section 4.5.6 personal setting 4, "Security: passkeys, MFA, sessions and devices"). Supabase Auth keeps the
-- name given at enrollment and offers no way to change it, so a renamed factor's label lives here, keyed by the factor and
-- removed with it. Passkeys are renamed in Supabase Auth itself.
--   * Private: signed-in callers read and write labels only through the two RPCs, and only for their own factors.

create table private.auth_factor_labels (
  factor_id uuid primary key references auth.mfa_factors (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  label text not null,
  updated_at timestamptz not null default now(),
  constraint auth_factor_labels_label_length check (char_length(btrim(label)) between 1 and 80)
);

create index auth_factor_labels_user_idx on private.auth_factor_labels (user_id);

alter table private.auth_factor_labels enable row level security;
revoke all on private.auth_factor_labels from public, anon, authenticated;

comment on table private.auth_factor_labels is 'The name a person gave one of their second factors after enrolling it (Supabase Auth cannot rename a factor). Deleted with the factor. Read and written only through app.my_auth_factor_labels and app.set_auth_factor_label.';
comment on column private.auth_factor_labels.factor_id is 'Second factor in Supabase Auth (auth.mfa_factors.id).';
comment on column private.auth_factor_labels.user_id is 'Sign-in that owns the factor.';
comment on column private.auth_factor_labels.label is 'Name shown for the factor, 1 to 80 characters.';
comment on column private.auth_factor_labels.updated_at is 'When the factor was last renamed.';

create or replace function app.set_auth_factor_label(p_factor_id uuid, p_label text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
begin
  if v_user is null or not exists (select 1 from auth.mfa_factors f where f.id = p_factor_id and f.user_id = v_user) then
    raise exception using errcode = '42501', message = 'factor not found';
  end if;
  if char_length(btrim(coalesce(p_label, ''))) not between 1 and 80 then
    perform private.refuse('factor_label_length', 'Name the factor in 1 to 80 characters.');
  end if;
  insert into private.auth_factor_labels (factor_id, user_id, label, updated_at)
  values (p_factor_id, v_user, btrim(p_label), now())
  on conflict (factor_id) do update set label = excluded.label, updated_at = excluded.updated_at;
end;
$$;

comment on function app.set_auth_factor_label(uuid, text) is 'Renames one of the caller''s own second factors (1 to 80 characters). Another person''s factor reads as not found.';
revoke all on function app.set_auth_factor_label(uuid, text) from public, anon;
grant execute on function app.set_auth_factor_label(uuid, text) to authenticated;

create or replace function app.my_auth_factor_labels()
returns table (factor_id uuid, label text)
language sql
stable
security definer
set search_path = ''
as $$
  select l.factor_id, l.label from private.auth_factor_labels l where l.user_id = (select auth.uid());
$$;

comment on function app.my_auth_factor_labels() is 'The names the caller gave their own second factors.';
revoke all on function app.my_auth_factor_labels() from public, anon;
grant execute on function app.my_auth_factor_labels() to authenticated;

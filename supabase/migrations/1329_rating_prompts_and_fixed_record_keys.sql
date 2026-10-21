-- 1329_rating_prompts_and_fixed_record_keys.sql
-- A76 (RRR-121), owner decisions of 2026-10-20 (ADR 0038).
--   * numbering.record_key_format stays fixed for launch. Record keys ({projectKey}-{sequence}, Section 4.5.1) live in
--     URLs, QR codes, offline Compass data and API v1, so no settings screen offers the format and the database refuses
--     any value for it (setting_fixed). A future change would apply only to new records, with old keys resolving
--     permanently and never reused. A value stored before this migration does nothing and may still be cleared.
--   * gateway.ratings_enabled decides only whether the org's own members are prompted to rate the people it engages
--     (Atlas reads it for the list of engagements waiting for a rating and the Rate the party next step). Ratings stay
--     on for everyone: no view, policy or function reads the setting, so turning prompts off never hides, removes or
--     changes a rating, or what a rated party or a marketplace viewer sees (FTC 16 CFR Part 465). Moderation follows
--     policy only (abuse, personal data), whatever the score. The comment on app.ratings now says so.

create or replace function private.guard_fixed_settings()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.deleted_at is null then
    perform private.refuse('setting_fixed',
      'Record keys are fixed: URLs, QR codes, offline Compass data and API v1 depend on them.');
  end if;
  return new;
end;
$$;

comment on function private.guard_fixed_settings() is 'Refuses any live value for numbering.record_key_format, saved or locked at any scope: record keys are fixed for launch (ADR 0038). Clearing a value stored earlier is allowed.';
revoke all on function private.guard_fixed_settings() from public, anon, authenticated;

create trigger t44_guard_fixed_settings before insert or update on app.setting_values
  for each row when (new.setting_key = 'numbering.record_key_format')
  execute function private.guard_fixed_settings();

comment on table app.ratings is 'Two-sided ratings of a completed engagement (Section 4.4.3): the org rates the party and the party rates the org. Both are released together once both are in or 14 days after the engagement completed. Ratings are never edited, withdrawn or suppressed (Section 14.9); gateway.ratings_enabled only decides whether the org''s members are prompted to rate and never hides or removes a rating (ADR 0038). Moderation follows policy only (abuse, personal data), whatever the score. Internal org notes and internal ratings live elsewhere and never appear here.';

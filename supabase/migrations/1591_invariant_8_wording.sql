-- 1591_invariant_8_wording.sql
--
-- Orchestrator block (ADR 0022, 1590-1599), RRR-125. ADR 0033 decision 56 rewords Section 7.5 invariant 8, because a
-- TOTP secret cannot be hashed: the server computes codes from it (finding A54-001). The spec now says access codes,
-- recovery codes and kiosk PINs are stored hashed, and second-factor secrets are held encrypted by the auth service and
-- are never selectable by tenants. private.invariants (1220) still held the old sentence, which counted second factors
-- among the hashed secrets. This restates the row's statement in the spec's words, and its enforced_by with the
-- recovery code table (1560) and the second factors Supabase Auth holds, which pgTAP 1220 checks no tenant role reads.
-- The code, number and area stay, so every assertion that names inv_08_token_rpcs_hashed_secrets still counts.

update private.invariants
set statement = 'Token RPCs require a token and an access code, expire, rate-limit failed attempts, and return only the fields the page renders. Access codes, recovery codes and kiosk PINs are stored hashed and shown once. Second-factor secrets are held encrypted by the auth service and are never selectable by tenants.',
    enforced_by = 'api_public token RPCs with private.rate_limit_exceeded and token lock; hashed columns for access codes, recovery codes (private.recovery_codes) and kiosk PINs; second factors held by Supabase Auth in auth.mfa_factors, with no privilege for anon or authenticated.'
where code = 'inv_08_token_rpcs_hashed_secrets';

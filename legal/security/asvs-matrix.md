---
title: OWASP ASVS 5.0 Level 2 Control Matrix
version: 1.1.0-draft
effective_date: The date this version is approved by the Owner
status: Draft for review before launch
audience: Internal; shared with customers and auditors under confidentiality
owner: A22 Security Review (RRR-41)
---

# OWASP ASVS 5.0 Level 2 Control Matrix

> **Draft for review before launch.** This matrix takes effect when the Owner approves it.

Section 9 of the build specification sets the OWASP Application Security Verification Standard 5.0
at Level 2 as the verification standard for XOS 4.0, and requires every control to map to a test or
a document. A22 (Security Review) verified this matrix in Wave 6 against main at d36918a, with the
fixes for A22-001 to A22-004 merged at 1a63487.

## Source

The chapter titles, requirement identifiers, section names and levels come from the official OWASP
ASVS 5.0.0 release:

- OWASP Foundation, _OWASP Application Security Verification Standard 5.0.0_, released May 2025,
  licensed CC BY-SA 4.0. Machine-readable edition:
  https://github.com/OWASP/ASVS/releases/download/v5.0.0_release/OWASP_Application_Security_Verification_Standard_5.0.0_en.csv
- Chapter files: https://github.com/OWASP/ASVS/tree/master/5.0/en

The chapter titles in the Wave 1 draft of this matrix were checked against that source on
2026-10-16; all seventeen matched and are kept. Requirement text is not reproduced here; read each
identifier in the source.

The matrix lists every Level 1 and Level 2 requirement, 253 in all. Level 3 requirements are out of
scope.

## States

| State             | Meaning                                                                                     |
| ----------------- | ------------------------------------------------------------------------------------------- |
| Verified (test)   | An automated test in this repository proves the control                                     |
| Verified (review) | A22 read the code or configuration and confirmed the control; no dedicated test exists yet  |
| Documented        | The requirement is about documentation, and the named document meets it                     |
| Inherited         | A provider (Supabase or Vercel) operates the control; covered by vendor management          |
| Not Applicable    | XOS does not use the technology the requirement governs; the reason is given                |
| Gap               | The control is missing or incomplete; a finding in `legal/security/findings` tracks the fix |

## Summary

| Chapter                                 | Level 1 and 2 requirements | Verified (test) | Verified (review) | Documented | Inherited | Not Applicable | Gap |
| --------------------------------------- | -------------------------- | --------------- | ----------------- | ---------- | --------- | -------------- | --- |
| V1 Encoding and Sanitization            | 27                         | 5               | 13                | 0          | 0         | 9              | 0   |
| V2 Validation and Business Logic        | 11                         | 7               | 0                 | 3          | 0         | 0              | 1   |
| V3 Web Frontend Security                | 19                         | 11              | 5                 | 1          | 0         | 0              | 2   |
| V4 API and Web Service                  | 10                         | 1               | 0                 | 0          | 3         | 6              | 0   |
| V5 File Handling                        | 9                          | 3               | 2                 | 1          | 0         | 0              | 3   |
| V6 Authentication                       | 35                         | 5               | 4                 | 5          | 11        | 2              | 8   |
| V7 Session Management                   | 18                         | 2               | 1                 | 9          | 6         | 0              | 0   |
| V8 Authorization                        | 7                          | 5               | 0                 | 2          | 0         | 0              | 0   |
| V9 Self-contained Tokens                | 7                          | 3               | 0                 | 0          | 4         | 0              | 0   |
| V10 OAuth and OIDC                      | 29                         | 3               | 0                 | 1          | 9         | 2              | 14  |
| V11 Cryptography                        | 14                         | 0               | 9                 | 3          | 2         | 0              | 0   |
| V12 Secure Communication                | 9                          | 1               | 0                 | 0          | 7         | 1              | 0   |
| V13 Configuration                       | 13                         | 4               | 4                 | 1          | 3         | 0              | 1   |
| V14 Data Protection                     | 9                          | 2               | 3                 | 4          | 0         | 0              | 0   |
| V15 Secure Coding and Architecture      | 13                         | 4               | 5                 | 3          | 1         | 0              | 0   |
| V16 Security Logging and Error Handling | 16                         | 5               | 3                 | 5          | 2         | 0              | 1   |
| V17 WebRTC                              | 7                          | 0               | 0                 | 0          | 0         | 7              | 0   |
| Total                                   | 253                        | 61              | 49                | 38         | 48        | 27             | 30  |

## V1 Encoding and Sanitization

| Requirement | Level | Section                                | State             | Evidence                                                                                                                                           |
| ----------- | ----- | -------------------------------------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| V1.1.1      | L2    | Encoding and Sanitization Architecture | Verified (review) | Zod schemas at every route (`packages/schemas`); `packages/api/test/contract.test.ts`                                                              |
| V1.1.2      | L2    | Encoding and Sanitization Architecture | Verified (review) | `apps/atlas/test/security.test.ts`; `apps/atlas/e2e/security.spec.ts`; `apps/*/lib/security/headers.ts`                                            |
| V1.2.1      | L1    | Injection Prevention                   | Verified (review) | `apps/atlas/test/security.test.ts`; `apps/atlas/e2e/security.spec.ts`; `apps/*/lib/security/headers.ts`                                            |
| V1.2.2      | L1    | Injection Prevention                   | Verified (review) | `apps/atlas/test/security.test.ts`; `apps/atlas/e2e/security.spec.ts`; `apps/*/lib/security/headers.ts`                                            |
| V1.2.3      | L1    | Injection Prevention                   | Verified (review) | `apps/atlas/test/security.test.ts`; `apps/atlas/e2e/security.spec.ts`; `apps/*/lib/security/headers.ts`                                            |
| V1.2.4      | L1    | Injection Prevention                   | Verified (test)   | Parameterized PostgREST and RPC calls through `@supabase/supabase-js`; no SQL strings in app code; `supabase/tests/9900_security_catalog.test.sql` |
| V1.2.5      | L1    | Injection Prevention                   | Not Applicable    | Not Applicable: no operating system command execution in application code                                                                          |
| V1.2.6      | L2    | Injection Prevention                   | Not Applicable    | Not Applicable: no LDAP, XPath, LaTeX, JNDI or memcache use in the codebase                                                                        |
| V1.2.7      | L2    | Injection Prevention                   | Not Applicable    | Not Applicable: no LDAP, XPath, LaTeX, JNDI or memcache use in the codebase                                                                        |
| V1.2.8      | L2    | Injection Prevention                   | Not Applicable    | Not Applicable: no LDAP, XPath, LaTeX, JNDI or memcache use in the codebase                                                                        |
| V1.2.9      | L2    | Injection Prevention                   | Verified (review) | Zod schemas at every route (`packages/schemas`); `packages/api/test/contract.test.ts`                                                              |
| V1.3.1      | L1    | Sanitization                           | Verified (review) | `apps/atlas/test/security.test.ts`; `apps/atlas/e2e/security.spec.ts`; `apps/*/lib/security/headers.ts`                                            |
| V1.3.2      | L1    | Sanitization                           | Verified (test)   | `apps/atlas/test/security.test.ts`; `apps/atlas/e2e/security.spec.ts`; `apps/*/lib/security/headers.ts`                                            |
| V1.3.3      | L2    | Sanitization                           | Verified (review) | Zod schemas at every route (`packages/schemas`); `packages/api/test/contract.test.ts`                                                              |
| V1.3.4      | L2    | Sanitization                           | Verified (test)   | Bucket type allowlists and size caps; `supabase/tests/9908`; 0590 and 0860 suites                                                                  |
| V1.3.5      | L2    | Sanitization                           | Verified (review) | `apps/atlas/test/security.test.ts`; `apps/atlas/e2e/security.spec.ts`; `apps/*/lib/security/headers.ts`                                            |
| V1.3.6      | L2    | Sanitization                           | Verified (test)   | `packages/platform/src/webhooks/dispatch.ts` private-address refusal and manual redirects; `packages/platform/test/services.test.ts`               |
| V1.3.7      | L2    | Sanitization                           | Verified (review) | `legal/policies/secure-development.md`                                                                                                             |
| V1.3.8      | L2    | Sanitization                           | Not Applicable    | Not Applicable: no LDAP, XPath, LaTeX, JNDI or memcache use in the codebase                                                                        |
| V1.3.9      | L2    | Sanitization                           | Not Applicable    | Not Applicable: no LDAP, XPath, LaTeX, JNDI or memcache use in the codebase                                                                        |
| V1.3.10     | L2    | Sanitization                           | Verified (review) | `legal/policies/secure-development.md`                                                                                                             |
| V1.3.11     | L2    | Sanitization                           | Verified (review) | `legal/policies/secure-development.md`                                                                                                             |
| V1.4.1      | L2    | Memory, String, and Unmanaged Code     | Not Applicable    | Not Applicable: TypeScript, SQL and Deno only; no unmanaged memory                                                                                 |
| V1.4.2      | L2    | Memory, String, and Unmanaged Code     | Verified (test)   | pgTAP invariant suites (Section 7.5), for example 0310, 0320 and 0330                                                                              |
| V1.4.3      | L2    | Memory, String, and Unmanaged Code     | Not Applicable    | Not Applicable: TypeScript, SQL and Deno only; no unmanaged memory                                                                                 |
| V1.5.1      | L1    | Safe Deserialization                   | Not Applicable    | Not Applicable: no XML parsing of untrusted input; imports parse CSV and XLSX                                                                      |
| V1.5.2      | L2    | Safe Deserialization                   | Verified (review) | Zod schemas at every route (`packages/schemas`); `packages/api/test/contract.test.ts`                                                              |

## V2 Validation and Business Logic

| Requirement | Level | Section                                     | State           | Evidence                                                                                                                           |
| ----------- | ----- | ------------------------------------------- | --------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| V2.1.1      | L1    | Validation and Business Logic Documentation | Documented      | Zod schemas at every route (`packages/schemas`); `packages/api/test/contract.test.ts`                                              |
| V2.1.2      | L2    | Validation and Business Logic Documentation | Documented      | pgTAP invariant suites (Section 7.5), for example 0310, 0320 and 0330                                                              |
| V2.1.3      | L2    | Validation and Business Logic Documentation | Documented      | pgTAP invariant suites (Section 7.5), for example 0310, 0320 and 0330                                                              |
| V2.2.1      | L1    | Input Validation                            | Verified (test) | Zod schemas at every route (`packages/schemas`); `packages/api/test/contract.test.ts`                                              |
| V2.2.2      | L1    | Input Validation                            | Verified (test) | `packages/api/src/runtime/auth.ts` (caller-token clients, never the service role); `supabase/tests/9900_security_catalog.test.sql` |
| V2.2.3      | L2    | Input Validation                            | Verified (test) | pgTAP invariant suites (Section 7.5), for example 0310, 0320 and 0330                                                              |
| V2.3.1      | L1    | Business Logic Security                     | Verified (test) | `private.transition_lifecycle` compare-and-set (ADR 0016); lifecycle pgTAP suites                                                  |
| V2.3.2      | L2    | Business Logic Security                     | Verified (test) | pgTAP invariant suites (Section 7.5), for example 0310, 0320 and 0330                                                              |
| V2.3.3      | L2    | Business Logic Security                     | Verified (test) | pgTAP invariant suites (Section 7.5), for example 0310, 0320 and 0330                                                              |
| V2.3.4      | L2    | Business Logic Security                     | Verified (test) | `private.transition_lifecycle` compare-and-set (ADR 0016); lifecycle pgTAP suites                                                  |
| V2.4.1      | L2    | Anti-automation                             | Gap             | Gap: finding [A22-012](findings/A22-012.md)                                                                                        |

## V3 Web Frontend Security

| Requirement | Level | Section                               | State             | Evidence                                                                                                                                                   |
| ----------- | ----- | ------------------------------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| V3.2.1      | L1    | Unintended Content Interpretation     | Verified (test)   | `apps/atlas/test/security.test.ts`; `apps/atlas/e2e/security.spec.ts`; `apps/*/lib/security/headers.ts`                                                    |
| V3.2.2      | L1    | Unintended Content Interpretation     | Verified (review) | `apps/atlas/test/security.test.ts`; `apps/atlas/e2e/security.spec.ts`; `apps/*/lib/security/headers.ts`                                                    |
| V3.3.1      | L1    | Cookie Setup                          | Gap               | Gap: finding [A22-014](findings/A22-014.md)                                                                                                                |
| V3.3.2      | L2    | Cookie Setup                          | Verified (test)   | `apps/atlas/lib/supabase/cookies.ts` (httpOnly, SameSite=Lax, Secure on https)                                                                             |
| V3.3.3      | L2    | Cookie Setup                          | Gap               | Gap: finding [A22-014](findings/A22-014.md)                                                                                                                |
| V3.3.4      | L2    | Cookie Setup                          | Verified (test)   | `apps/atlas/lib/supabase/cookies.ts` (httpOnly, SameSite=Lax, Secure on https)                                                                             |
| V3.4.1      | L1    | Browser Security Mechanism Headers    | Verified (test)   | `apps/atlas/test/security.test.ts`; `apps/atlas/e2e/security.spec.ts`; `apps/*/lib/security/headers.ts`                                                    |
| V3.4.2      | L1    | Browser Security Mechanism Headers    | Verified (review) | `apps/atlas/test/security.test.ts`; `apps/atlas/e2e/security.spec.ts`; `apps/*/lib/security/headers.ts`                                                    |
| V3.4.3      | L2    | Browser Security Mechanism Headers    | Verified (test)   | `apps/atlas/test/security.test.ts`; `apps/atlas/e2e/security.spec.ts`; `apps/*/lib/security/headers.ts`                                                    |
| V3.4.4      | L2    | Browser Security Mechanism Headers    | Verified (test)   | `apps/atlas/test/security.test.ts`; `apps/atlas/e2e/security.spec.ts`; `apps/*/lib/security/headers.ts`                                                    |
| V3.4.5      | L2    | Browser Security Mechanism Headers    | Verified (test)   | `apps/atlas/test/security.test.ts`; `apps/atlas/e2e/security.spec.ts`; `apps/*/lib/security/headers.ts`                                                    |
| V3.4.6      | L2    | Browser Security Mechanism Headers    | Verified (test)   | `apps/atlas/test/security.test.ts`; `apps/atlas/e2e/security.spec.ts`; `apps/*/lib/security/headers.ts`                                                    |
| V3.5.1      | L1    | Browser Origin Separation             | Verified (test)   | `packages/api/test/security/auth-attacks.test.ts`; `apps/atlas/test/security.test.ts`; `apps/atlas/e2e/security.spec.ts`; `apps/*/lib/security/headers.ts` |
| V3.5.2      | L1    | Browser Origin Separation             | Verified (test)   | `packages/api/test/security/auth-attacks.test.ts`                                                                                                          |
| V3.5.3      | L1    | Browser Origin Separation             | Verified (test)   | `packages/api/test/security/contract-attacks.test.ts`; `packages/api/test/contract.test.ts`                                                                |
| V3.5.4      | L2    | Browser Origin Separation             | Documented        | `legal/security/threat-model.md`                                                                                                                           |
| V3.5.5      | L2    | Browser Origin Separation             | Verified (review) | `apps/atlas/test/security.test.ts`; `apps/atlas/e2e/security.spec.ts`; `apps/*/lib/security/headers.ts`                                                    |
| V3.7.1      | L2    | Other Browser Security Considerations | Verified (review) | Verified by review: React 19 and Next.js 16 only, no plugins (`object-src none` in the CSP)                                                                |
| V3.7.2      | L2    | Other Browser Security Considerations | Verified (review) | `apps/atlas/test/security.test.ts`; `apps/atlas/e2e/security.spec.ts`; `apps/*/lib/security/headers.ts`                                                    |

## V4 API and Web Service

| Requirement | Level | Section                           | State           | Evidence                                                                                      |
| ----------- | ----- | --------------------------------- | --------------- | --------------------------------------------------------------------------------------------- |
| V4.1.1      | L1    | Generic Web Service Security      | Verified (test) | `packages/api/test/security/contract-attacks.test.ts`; `packages/api/test/contract.test.ts`   |
| V4.1.2      | L2    | Generic Web Service Security      | Inherited       | Inherited from Supabase and Vercel managed TLS; `legal/policies/encryption.md`                |
| V4.1.3      | L2    | Generic Web Service Security      | Inherited       | Inherited from Supabase and Vercel managed TLS; `legal/policies/encryption.md`                |
| V4.2.1      | L2    | HTTP Message Structure Validation | Inherited       | Inherited from Supabase and Vercel managed TLS; `legal/policies/encryption.md`                |
| V4.3.1      | L2    | GraphQL                           | Not Applicable  | Not Applicable: no GraphQL API (ADR 0003 rejected it); pg_graphql is not exposed              |
| V4.3.2      | L2    | GraphQL                           | Not Applicable  | Not Applicable: no GraphQL API (ADR 0003 rejected it); pg_graphql is not exposed              |
| V4.4.1      | L1    | WebSocket                         | Not Applicable  | Not Applicable: no WebSocket endpoint of our own; Supabase Realtime is inherited and uses WSS |
| V4.4.2      | L2    | WebSocket                         | Not Applicable  | Not Applicable: no WebSocket endpoint of our own; Supabase Realtime is inherited and uses WSS |
| V4.4.3      | L2    | WebSocket                         | Not Applicable  | Not Applicable: no WebSocket endpoint of our own; Supabase Realtime is inherited and uses WSS |
| V4.4.4      | L2    | WebSocket                         | Not Applicable  | Not Applicable: no WebSocket endpoint of our own; Supabase Realtime is inherited and uses WSS |

## V5 File Handling

| Requirement | Level | Section                     | State             | Evidence                                                                          |
| ----------- | ----- | --------------------------- | ----------------- | --------------------------------------------------------------------------------- |
| V5.1.1      | L2    | File Handling Documentation | Documented        | Bucket type allowlists and size caps; `supabase/tests/9908`; 0590 and 0860 suites |
| V5.2.1      | L1    | File Upload and Content     | Verified (test)   | Bucket type allowlists and size caps; `supabase/tests/9908`; 0590 and 0860 suites |
| V5.2.2      | L1    | File Upload and Content     | Gap               | Gap: finding [A22-011](findings/A22-011.md)                                       |
| V5.2.3      | L2    | File Upload and Content     | Gap               | Gap: finding [A22-011](findings/A22-011.md)                                       |
| V5.3.1      | L1    | File Storage                | Verified (test)   | Bucket type allowlists and size caps; `supabase/tests/9908`; 0590 and 0860 suites |
| V5.3.2      | L1    | File Storage                | Verified (test)   | Bucket type allowlists and size caps; `supabase/tests/9908`; 0590 and 0860 suites |
| V5.4.1      | L2    | File Download               | Verified (review) | Bucket type allowlists and size caps; `supabase/tests/9908`; 0590 and 0860 suites |
| V5.4.2      | L2    | File Download               | Verified (review) | Bucket type allowlists and size caps; `supabase/tests/9908`; 0590 and 0860 suites |
| V5.4.3      | L2    | File Download               | Gap               | Gap: finding [A22-011](findings/A22-011.md)                                       |

## V6 Authentication

| Requirement | Level | Section                                          | State             | Evidence                                                                                                |
| ----------- | ----- | ------------------------------------------------ | ----------------- | ------------------------------------------------------------------------------------------------------- |
| V6.1.1      | L1    | Authentication Documentation                     | Documented        | `legal/security/threat-model.md`                                                                        |
| V6.1.2      | L2    | Authentication Documentation                     | Gap               | Gap: finding [A22-010](findings/A22-010.md)                                                             |
| V6.1.3      | L2    | Authentication Documentation                     | Documented        | `legal/security/threat-model.md`                                                                        |
| V6.2.1      | L1    | Password Security                                | Gap               | Gap: finding [A22-010](findings/A22-010.md)                                                             |
| V6.2.2      | L1    | Password Security                                | Inherited         | Inherited from Supabase Auth (GoTrue); configured in `supabase/config.toml`                             |
| V6.2.3      | L1    | Password Security                                | Gap               | Gap: finding [A22-010](findings/A22-010.md)                                                             |
| V6.2.4      | L1    | Password Security                                | Gap               | Gap: finding [A22-010](findings/A22-010.md)                                                             |
| V6.2.5      | L1    | Password Security                                | Inherited         | Inherited from Supabase Auth (GoTrue); configured in `supabase/config.toml`                             |
| V6.2.6      | L1    | Password Security                                | Verified (review) | `apps/atlas/test/security.test.ts`; `apps/atlas/e2e/security.spec.ts`; `apps/*/lib/security/headers.ts` |
| V6.2.7      | L1    | Password Security                                | Verified (review) | `apps/atlas/test/security.test.ts`; `apps/atlas/e2e/security.spec.ts`; `apps/*/lib/security/headers.ts` |
| V6.2.8      | L1    | Password Security                                | Inherited         | Inherited from Supabase Auth (GoTrue); configured in `supabase/config.toml`                             |
| V6.2.9      | L2    | Password Security                                | Inherited         | Inherited from Supabase Auth (GoTrue); configured in `supabase/config.toml`                             |
| V6.2.10     | L2    | Password Security                                | Inherited         | Inherited from Supabase Auth (GoTrue); configured in `supabase/config.toml`                             |
| V6.2.11     | L2    | Password Security                                | Gap               | Gap: finding [A22-010](findings/A22-010.md)                                                             |
| V6.2.12     | L2    | Password Security                                | Gap               | Gap: finding [A22-010](findings/A22-010.md)                                                             |
| V6.3.1      | L1    | General Authentication Security                  | Gap               | Gap: finding [A22-012](findings/A22-012.md)                                                             |
| V6.3.2      | L1    | General Authentication Security                  | Verified (review) | Inherited from Supabase Auth (GoTrue); configured in `supabase/config.toml`                             |
| V6.3.3      | L2    | General Authentication Security                  | Gap               | Gap: finding [A22-010](findings/A22-010.md)                                                             |
| V6.3.4      | L2    | General Authentication Security                  | Documented        | `legal/security/threat-model.md`                                                                        |
| V6.4.1      | L1    | Authentication Factor Lifecycle and Recovery     | Verified (test)   | Token RPCs store hashes only, with access codes and lockout (0361, 0430, 0769 suites)                   |
| V6.4.2      | L1    | Authentication Factor Lifecycle and Recovery     | Verified (review) | Inherited from Supabase Auth (GoTrue); configured in `supabase/config.toml`                             |
| V6.4.3      | L2    | Authentication Factor Lifecycle and Recovery     | Inherited         | Inherited from Supabase Auth (GoTrue); configured in `supabase/config.toml`                             |
| V6.4.4      | L2    | Authentication Factor Lifecycle and Recovery     | Documented        | `legal/policies/access-control.md`                                                                      |
| V6.5.1      | L2    | General Multi-factor authentication requirements | Inherited         | Inherited from Supabase Auth (GoTrue); configured in `supabase/config.toml`                             |
| V6.5.2      | L2    | General Multi-factor authentication requirements | Inherited         | Inherited from Supabase Auth (GoTrue); configured in `supabase/config.toml`                             |
| V6.5.3      | L2    | General Multi-factor authentication requirements | Inherited         | Inherited from Supabase Auth (GoTrue); configured in `supabase/config.toml`                             |
| V6.5.4      | L2    | General Multi-factor authentication requirements | Verified (test)   | Token RPCs store hashes only, with access codes and lockout (0361, 0430, 0769 suites)                   |
| V6.5.5      | L2    | General Multi-factor authentication requirements | Verified (test)   | Token RPCs store hashes only, with access codes and lockout (0361, 0430, 0769 suites)                   |
| V6.6.1      | L2    | Out-of-Band authentication mechanisms            | Not Applicable    | Not Applicable: SMS is used for notifications, not for authentication codes                             |
| V6.6.2      | L2    | Out-of-Band authentication mechanisms            | Inherited         | Inherited from Supabase Auth (GoTrue); configured in `supabase/config.toml`                             |
| V6.6.3      | L2    | Out-of-Band authentication mechanisms            | Verified (test)   | Token RPCs store hashes only, with access codes and lockout (0361, 0430, 0769 suites)                   |
| V6.8.1      | L2    | Authentication with an Identity Provider         | Verified (test)   | Inherited from Supabase Auth (GoTrue); configured in `supabase/config.toml`                             |
| V6.8.2      | L2    | Authentication with an Identity Provider         | Inherited         | Inherited from Supabase Auth (GoTrue); configured in `supabase/config.toml`                             |
| V6.8.3      | L2    | Authentication with an Identity Provider         | Not Applicable    | Not Applicable until Enterprise SAML ships; Supabase Auth validates assertions when it does             |
| V6.8.4      | L2    | Authentication with an Identity Provider         | Documented        | `legal/security/threat-model.md`                                                                        |

## V7 Session Management

| Requirement | Level | Section                                 | State             | Evidence                                                                                                                             |
| ----------- | ----- | --------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| V7.1.1      | L2    | Session Management Documentation        | Documented        | `legal/policies/access-control.md`                                                                                                   |
| V7.1.2      | L2    | Session Management Documentation        | Documented        | `legal/policies/access-control.md`                                                                                                   |
| V7.1.3      | L2    | Session Management Documentation        | Documented        | `legal/policies/access-control.md`                                                                                                   |
| V7.2.1      | L1    | Fundamental Session Management Security | Verified (test)   | `packages/api/src/runtime/auth.ts` (caller-token clients, never the service role); `packages/api/test/security/auth-attacks.test.ts` |
| V7.2.2      | L1    | Fundamental Session Management Security | Inherited         | Inherited from Supabase Auth (GoTrue); configured in `supabase/config.toml`                                                          |
| V7.2.3      | L1    | Fundamental Session Management Security | Inherited         | Inherited from Supabase Auth (GoTrue); configured in `supabase/config.toml`                                                          |
| V7.2.4      | L1    | Fundamental Session Management Security | Inherited         | Inherited from Supabase Auth (GoTrue); configured in `supabase/config.toml`                                                          |
| V7.3.1      | L2    | Session Timeout                         | Documented        | `legal/policies/access-control.md`                                                                                                   |
| V7.3.2      | L2    | Session Timeout                         | Documented        | `legal/policies/access-control.md`                                                                                                   |
| V7.4.1      | L1    | Session Termination                     | Inherited         | Inherited from Supabase Auth (GoTrue); configured in `supabase/config.toml`                                                          |
| V7.4.2      | L1    | Session Termination                     | Verified (test)   | `supabase/tests/9904_security_viewer_band.test.sql`; A02 0205 suite                                                                  |
| V7.4.3      | L2    | Session Termination                     | Inherited         | Inherited from Supabase Auth (GoTrue); configured in `supabase/config.toml`                                                          |
| V7.4.4      | L2    | Session Termination                     | Verified (review) | `apps/atlas/test/security.test.ts`; `apps/atlas/e2e/security.spec.ts`; `apps/*/lib/security/headers.ts`                              |
| V7.4.5      | L2    | Session Termination                     | Documented        | `legal/policies/access-control.md`                                                                                                   |
| V7.5.1      | L2    | Defenses Against Session Abuse          | Documented        | `legal/policies/access-control.md`                                                                                                   |
| V7.5.2      | L2    | Defenses Against Session Abuse          | Documented        | `legal/policies/access-control.md`                                                                                                   |
| V7.6.1      | L2    | Federated Re-authentication             | Documented        | `legal/policies/access-control.md`                                                                                                   |
| V7.6.2      | L2    | Federated Re-authentication             | Inherited         | Inherited from Supabase Auth (GoTrue); configured in `supabase/config.toml`                                                          |

## V8 Authorization

| Requirement | Level | Section                            | State           | Evidence                                                                                                                                                                                                                                                               |
| ----------- | ----- | ---------------------------------- | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| V8.1.1      | L1    | Authorization Documentation        | Documented      | `legal/policies/access-control.md`; `legal/security/threat-model.md`                                                                                                                                                                                                   |
| V8.1.2      | L2    | Authorization Documentation        | Documented      | `legal/policies/data-classification.md`; `*_masked` views and column revokes (ADR 0016 item 10); `9900` masking assertion; 0363 suite                                                                                                                                  |
| V8.2.1      | L1    | General Authorization Design       | Verified (test) | `supabase/tests/9904_security_viewer_band.test.sql`; A02 0205 suite; `packages/api/test/security/contract-attacks.test.ts`; `packages/api/test/contract.test.ts`; `supabase/functions/api-token/mint.ts`; `packages/api/test/api-token.test.ts`; `supabase/tests/9905` |
| V8.2.2      | L1    | General Authorization Design       | Verified (test) | `supabase/tests/9901` to `9903` cross-tenant suites; `packages/api/src/runtime/idempotency.ts`; `auth-attacks.test.ts`                                                                                                                                                 |
| V8.2.3      | L2    | General Authorization Design       | Verified (test) | `*_masked` views and column revokes (ADR 0016 item 10); `9900` masking assertion; 0363 suite                                                                                                                                                                           |
| V8.3.1      | L1    | Operation Level Authorization      | Verified (test) | `supabase/tests/9900_security_catalog.test.sql`; `packages/api/src/runtime/auth.ts` (caller-token clients, never the service role)                                                                                                                                     |
| V8.4.1      | L2    | Other Authorization Considerations | Verified (test) | `supabase/tests/9901` to `9903` cross-tenant suites                                                                                                                                                                                                                    |

## V9 Self-contained Tokens

| Requirement | Level | Section                    | State           | Evidence                                                                                                                                                |
| ----------- | ----- | -------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| V9.1.1      | L1    | Token source and integrity | Inherited       | Inherited from Supabase Auth (GoTrue); configured in `supabase/config.toml`                                                                             |
| V9.1.2      | L1    | Token source and integrity | Inherited       | Inherited from Supabase Auth (GoTrue); configured in `supabase/config.toml`                                                                             |
| V9.1.3      | L1    | Token source and integrity | Inherited       | Inherited from Supabase Auth (GoTrue); configured in `supabase/config.toml`                                                                             |
| V9.2.1      | L1    | Token content              | Verified (test) | `supabase/functions/api-token/mint.ts`; `packages/api/test/api-token.test.ts`; `supabase/tests/9905`                                                    |
| V9.2.2      | L2    | Token content              | Verified (test) | `supabase/functions/api-token/mint.ts`; `packages/api/test/api-token.test.ts`; `supabase/tests/9905`; `packages/api/test/security/auth-attacks.test.ts` |
| V9.2.3      | L2    | Token content              | Inherited       | Inherited from Supabase Auth (GoTrue); configured in `supabase/config.toml`                                                                             |
| V9.2.4      | L2    | Token content              | Verified (test) | `supabase/functions/api-token/mint.ts`; `packages/api/test/api-token.test.ts`; `supabase/tests/9905`                                                    |

## V10 OAuth and OIDC

| Requirement | Level | Section                         | State           | Evidence                                                                                                                                                                                          |
| ----------- | ----- | ------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| V10.1.1     | L2    | Generic OAuth and OIDC Security | Verified (test) | `apps/atlas/lib/supabase/cookies.ts` (httpOnly, SameSite=Lax, Secure on https); `packages/api/src/runtime/auth.ts` (caller-token clients, never the service role)                                 |
| V10.1.2     | L2    | Generic OAuth and OIDC Security | Inherited       | Inherited from Supabase Auth (GoTrue); configured in `supabase/config.toml`                                                                                                                       |
| V10.2.1     | L2    | OAuth Client                    | Inherited       | Inherited from Supabase Auth (GoTrue); configured in `supabase/config.toml`                                                                                                                       |
| V10.2.2     | L2    | OAuth Client                    | Inherited       | Inherited from Supabase Auth (GoTrue); configured in `supabase/config.toml`                                                                                                                       |
| V10.3.1     | L2    | OAuth Resource Server           | Inherited       | Inherited from Supabase Auth (GoTrue); configured in `supabase/config.toml`                                                                                                                       |
| V10.3.2     | L2    | OAuth Resource Server           | Verified (test) | `supabase/functions/api-token/mint.ts`; `packages/api/test/api-token.test.ts`; `supabase/tests/9905`; `packages/api/test/security/contract-attacks.test.ts`; `packages/api/test/contract.test.ts` |
| V10.3.3     | L2    | OAuth Resource Server           | Verified (test) | `packages/api/src/runtime/auth.ts` (caller-token clients, never the service role)                                                                                                                 |
| V10.3.4     | L2    | OAuth Resource Server           | Documented      | `legal/policies/access-control.md`                                                                                                                                                                |
| V10.4.1     | L1    | OAuth Authorization Server      | Gap             | Gap: finding [A22-015](findings/A22-015.md)                                                                                                                                                       |
| V10.4.2     | L1    | OAuth Authorization Server      | Gap             | Gap: finding [A22-015](findings/A22-015.md)                                                                                                                                                       |
| V10.4.3     | L1    | OAuth Authorization Server      | Gap             | Gap: finding [A22-015](findings/A22-015.md)                                                                                                                                                       |
| V10.4.4     | L1    | OAuth Authorization Server      | Gap             | Gap: finding [A22-015](findings/A22-015.md)                                                                                                                                                       |
| V10.4.5     | L1    | OAuth Authorization Server      | Gap             | Gap: finding [A22-015](findings/A22-015.md)                                                                                                                                                       |
| V10.4.6     | L2    | OAuth Authorization Server      | Gap             | Gap: finding [A22-015](findings/A22-015.md)                                                                                                                                                       |
| V10.4.7     | L2    | OAuth Authorization Server      | Gap             | Gap: finding [A22-015](findings/A22-015.md)                                                                                                                                                       |
| V10.4.8     | L2    | OAuth Authorization Server      | Gap             | Gap: finding [A22-015](findings/A22-015.md)                                                                                                                                                       |
| V10.4.9     | L2    | OAuth Authorization Server      | Gap             | Gap: finding [A22-015](findings/A22-015.md)                                                                                                                                                       |
| V10.4.10    | L2    | OAuth Authorization Server      | Gap             | Gap: finding [A22-015](findings/A22-015.md)                                                                                                                                                       |
| V10.4.11    | L2    | OAuth Authorization Server      | Gap             | Gap: finding [A22-015](findings/A22-015.md)                                                                                                                                                       |
| V10.5.1     | L2    | OIDC Client                     | Inherited       | Inherited from Supabase Auth (GoTrue); configured in `supabase/config.toml`                                                                                                                       |
| V10.5.2     | L2    | OIDC Client                     | Inherited       | Inherited from Supabase Auth (GoTrue); configured in `supabase/config.toml`                                                                                                                       |
| V10.5.3     | L2    | OIDC Client                     | Inherited       | Inherited from Supabase Auth (GoTrue); configured in `supabase/config.toml`                                                                                                                       |
| V10.5.4     | L2    | OIDC Client                     | Inherited       | Inherited from Supabase Auth (GoTrue); configured in `supabase/config.toml`                                                                                                                       |
| V10.5.5     | L2    | OIDC Client                     | Inherited       | Inherited from Supabase Auth (GoTrue); configured in `supabase/config.toml`                                                                                                                       |
| V10.6.1     | L2    | OpenID Provider                 | Not Applicable  | Not Applicable: XOS is not an OpenID Provider                                                                                                                                                     |
| V10.6.2     | L2    | OpenID Provider                 | Not Applicable  | Not Applicable: XOS is not an OpenID Provider                                                                                                                                                     |
| V10.7.1     | L2    | Consent Management              | Gap             | Gap: finding [A22-015](findings/A22-015.md)                                                                                                                                                       |
| V10.7.2     | L2    | Consent Management              | Gap             | Gap: finding [A22-015](findings/A22-015.md)                                                                                                                                                       |
| V10.7.3     | L2    | Consent Management              | Gap             | Gap: finding [A22-015](findings/A22-015.md)                                                                                                                                                       |

## V11 Cryptography

| Requirement | Level | Section                                   | State             | Evidence                                                                              |
| ----------- | ----- | ----------------------------------------- | ----------------- | ------------------------------------------------------------------------------------- |
| V11.1.1     | L2    | Cryptographic Inventory and Documentation | Documented        | `legal/policies/encryption.md`                                                        |
| V11.1.2     | L2    | Cryptographic Inventory and Documentation | Documented        | `legal/policies/encryption.md`                                                        |
| V11.2.1     | L2    | Secure Cryptography Implementation        | Verified (review) | `legal/policies/encryption.md`                                                        |
| V11.2.2     | L2    | Secure Cryptography Implementation        | Documented        | `legal/policies/encryption.md`                                                        |
| V11.2.3     | L2    | Secure Cryptography Implementation        | Verified (review) | `legal/policies/encryption.md`                                                        |
| V11.3.1     | L1    | Encryption Algorithms                     | Verified (review) | `legal/policies/encryption.md`                                                        |
| V11.3.2     | L1    | Encryption Algorithms                     | Verified (review) | `legal/policies/encryption.md`                                                        |
| V11.3.3     | L2    | Encryption Algorithms                     | Verified (review) | `legal/policies/encryption.md`                                                        |
| V11.4.1     | L1    | Hashing and Hash-based Functions          | Verified (review) | `legal/policies/encryption.md`                                                        |
| V11.4.2     | L2    | Hashing and Hash-based Functions          | Inherited         | Inherited from Supabase Auth (GoTrue); configured in `supabase/config.toml`           |
| V11.4.3     | L2    | Hashing and Hash-based Functions          | Verified (review) | `legal/policies/encryption.md`                                                        |
| V11.4.4     | L2    | Hashing and Hash-based Functions          | Verified (review) | `legal/policies/encryption.md`                                                        |
| V11.5.1     | L2    | Random Values                             | Verified (review) | Token RPCs store hashes only, with access codes and lockout (0361, 0430, 0769 suites) |
| V11.6.1     | L2    | Public Key Cryptography                   | Inherited         | Inherited from Supabase and Vercel managed TLS; `legal/policies/encryption.md`        |

## V12 Secure Communication

| Requirement | Level | Section                                           | State           | Evidence                                                                                                |
| ----------- | ----- | ------------------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------- |
| V12.1.1     | L1    | General TLS Security Guidance                     | Inherited       | Inherited from Supabase and Vercel managed TLS; `legal/policies/encryption.md`                          |
| V12.1.2     | L2    | General TLS Security Guidance                     | Inherited       | Inherited from Supabase and Vercel managed TLS; `legal/policies/encryption.md`                          |
| V12.1.3     | L2    | General TLS Security Guidance                     | Not Applicable  | Not Applicable: no mTLS client certificates are used                                                    |
| V12.2.1     | L1    | HTTPS Communication with External Facing Services | Verified (test) | `apps/atlas/test/security.test.ts`; `apps/atlas/e2e/security.spec.ts`; `apps/*/lib/security/headers.ts` |
| V12.2.2     | L1    | HTTPS Communication with External Facing Services | Inherited       | Inherited from Supabase and Vercel managed TLS; `legal/policies/encryption.md`                          |
| V12.3.1     | L2    | General Service to Service Communication Security | Inherited       | Inherited from Supabase and Vercel managed TLS; `legal/policies/encryption.md`                          |
| V12.3.2     | L2    | General Service to Service Communication Security | Inherited       | Inherited from Supabase and Vercel managed TLS; `legal/policies/encryption.md`                          |
| V12.3.3     | L2    | General Service to Service Communication Security | Inherited       | Inherited from Supabase and Vercel managed TLS; `legal/policies/encryption.md`                          |
| V12.3.4     | L2    | General Service to Service Communication Security | Inherited       | Inherited from Supabase and Vercel managed TLS; `legal/policies/encryption.md`                          |

## V13 Configuration

| Requirement | Level | Section                             | State             | Evidence                                                                                                                                                        |
| ----------- | ----- | ----------------------------------- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| V13.1.1     | L2    | Configuration Documentation         | Gap               | Gap: finding [A22-005](findings/A22-005.md), [A22-006](findings/A22-006.md)                                                                                     |
| V13.2.1     | L2    | Backend Communication Configuration | Verified (test)   | `supabase/functions/api-token/mint.ts`; `packages/api/test/api-token.test.ts`; `supabase/tests/9905`                                                            |
| V13.2.2     | L2    | Backend Communication Configuration | Verified (review) | `packages/api/src/runtime/auth.ts` (caller-token clients, never the service role)                                                                               |
| V13.2.3     | L2    | Backend Communication Configuration | Verified (review) | Supabase Vault for integration credentials and the tax form key (ADR 0019, ADR 0024)                                                                            |
| V13.2.4     | L2    | Backend Communication Configuration | Verified (test)   | `packages/platform/src/webhooks/dispatch.ts` private-address refusal and manual redirects; `packages/platform/test/services.test.ts`                            |
| V13.2.5     | L2    | Backend Communication Configuration | Verified (test)   | `packages/platform/src/webhooks/dispatch.ts` private-address refusal and manual redirects; `packages/platform/test/services.test.ts`                            |
| V13.3.1     | L2    | Secret Management                   | Verified (review) | Supabase Vault for integration credentials and the tax form key (ADR 0019, ADR 0024); gitleaks in CI (`.github/workflows/ci.yml`); A22 tree scan found no leaks |
| V13.3.2     | L2    | Secret Management                   | Verified (test)   | `supabase/tests/9900_security_catalog.test.sql`; Supabase Vault for integration credentials and the tax form key (ADR 0019, ADR 0024)                           |
| V13.4.1     | L1    | Unintended Information Leakage      | Inherited         | Inherited from Supabase and Vercel managed TLS; `legal/policies/encryption.md`                                                                                  |
| V13.4.2     | L2    | Unintended Information Leakage      | Verified (review) | `apps/atlas/test/security.test.ts`; `apps/atlas/e2e/security.spec.ts`; `apps/*/lib/security/headers.ts`                                                         |
| V13.4.3     | L2    | Unintended Information Leakage      | Inherited         | Inherited from Supabase and Vercel managed TLS; `legal/policies/encryption.md`                                                                                  |
| V13.4.4     | L2    | Unintended Information Leakage      | Inherited         | Inherited from Supabase and Vercel managed TLS; `legal/policies/encryption.md`                                                                                  |
| V13.4.5     | L2    | Unintended Information Leakage      | Documented        | `legal/security/threat-model.md`                                                                                                                                |

## V14 Data Protection

| Requirement | Level | Section                       | State             | Evidence                                                                                                                              |
| ----------- | ----- | ----------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| V14.1.1     | L2    | Data Protection Documentation | Documented        | `legal/policies/data-classification.md`; `*_masked` views and column revokes (ADR 0016 item 10); `9900` masking assertion; 0363 suite |
| V14.1.2     | L2    | Data Protection Documentation | Documented        | `legal/policies/data-classification.md`                                                                                               |
| V14.2.1     | L1    | General Data Protection       | Verified (test)   | `packages/api/test/security/contract-attacks.test.ts`; `packages/api/test/contract.test.ts`                                           |
| V14.2.2     | L2    | General Data Protection       | Verified (review) | `supabase/functions/api-token/mint.ts`; `packages/api/test/api-token.test.ts`; `supabase/tests/9905`                                  |
| V14.2.3     | L2    | General Data Protection       | Documented        | `legal/policies/vendor-management.md`; `legal/subprocessors.md`                                                                       |
| V14.2.4     | L2    | General Data Protection       | Documented        | `legal/policies/data-classification.md`; `legal/policies/encryption.md`                                                               |
| V14.3.1     | L1    | Client-side Data Protection   | Verified (review) | `apps/atlas/lib/supabase/cookies.ts` (httpOnly, SameSite=Lax, Secure on https)                                                        |
| V14.3.2     | L2    | Client-side Data Protection   | Verified (review) | `supabase/functions/api-token/mint.ts`; `packages/api/test/api-token.test.ts`; `supabase/tests/9905`                                  |
| V14.3.3     | L2    | Client-side Data Protection   | Verified (test)   | `apps/atlas/lib/supabase/cookies.ts` (httpOnly, SameSite=Lax, Secure on https)                                                        |

## V15 Secure Coding and Architecture

| Requirement | Level | Section                                      | State             | Evidence                                                                                                                                                                                  |
| ----------- | ----- | -------------------------------------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| V15.1.1     | L1    | Secure Coding and Architecture Documentation | Documented        | `legal/policies/secure-development.md`                                                                                                                                                    |
| V15.1.2     | L2    | Secure Coding and Architecture Documentation | Documented        | Exact pins in every `package.json` and `supabase/functions/deno.json`; Actions pinned by SHA; `renovate.json` (A22 supply-chain check)                                                    |
| V15.1.3     | L2    | Secure Coding and Architecture Documentation | Documented        | `legal/security/threat-model.md`                                                                                                                                                          |
| V15.2.1     | L1    | Security Architecture and Dependencies       | Verified (review) | Exact pins in every `package.json` and `supabase/functions/deno.json`; Actions pinned by SHA; `renovate.json` (A22 supply-chain check)                                                    |
| V15.2.2     | L2    | Security Architecture and Dependencies       | Verified (test)   | `packages/api/test/security/auth-attacks.test.ts`                                                                                                                                         |
| V15.2.3     | L2    | Security Architecture and Dependencies       | Verified (review) | `legal/policies/secure-development.md`                                                                                                                                                    |
| V15.3.1     | L1    | Defensive Coding                             | Verified (test)   | `*_masked` views and column revokes (ADR 0016 item 10); `9900` masking assertion; 0363 suite; `packages/api/test/security/contract-attacks.test.ts`; `packages/api/test/contract.test.ts` |
| V15.3.2     | L2    | Defensive Coding                             | Verified (test)   | `packages/platform/src/webhooks/dispatch.ts` private-address refusal and manual redirects; `packages/platform/test/services.test.ts`                                                      |
| V15.3.3     | L2    | Defensive Coding                             | Verified (test)   | `packages/api/test/security/contract-attacks.test.ts`; `packages/api/test/contract.test.ts`                                                                                               |
| V15.3.4     | L2    | Defensive Coding                             | Inherited         | Inherited from Supabase and Vercel managed TLS; `legal/policies/encryption.md`                                                                                                            |
| V15.3.5     | L2    | Defensive Coding                             | Verified (review) | Zod schemas at every route (`packages/schemas`); `packages/api/test/contract.test.ts`                                                                                                     |
| V15.3.6     | L2    | Defensive Coding                             | Verified (review) | Zod schemas at every route (`packages/schemas`); `packages/api/test/contract.test.ts`                                                                                                     |
| V15.3.7     | L2    | Defensive Coding                             | Verified (review) | Zod schemas at every route (`packages/schemas`); `packages/api/test/contract.test.ts`                                                                                                     |

## V16 Security Logging and Error Handling

| Requirement | Level | Section                        | State             | Evidence                                                                       |
| ----------- | ----- | ------------------------------ | ----------------- | ------------------------------------------------------------------------------ |
| V16.1.1     | L2    | Security Logging Documentation | Documented        | `legal/policies/incident-response.md`                                          |
| V16.2.1     | L2    | General Logging                | Verified (test)   | `app.audit_events` append-only ledger; 0501 suite                              |
| V16.2.2     | L2    | General Logging                | Inherited         | Inherited from Supabase and Vercel managed TLS; `legal/policies/encryption.md` |
| V16.2.3     | L2    | General Logging                | Documented        | `legal/policies/incident-response.md`                                          |
| V16.2.4     | L2    | General Logging                | Verified (review) | `app.audit_events` append-only ledger; 0501 suite                              |
| V16.2.5     | L2    | General Logging                | Verified (test)   | `app.audit_events` append-only ledger; 0501 suite                              |
| V16.3.1     | L2    | Security Events                | Inherited         | Inherited from Supabase Auth (GoTrue); configured in `supabase/config.toml`    |
| V16.3.2     | L2    | Security Events                | Documented        | `legal/policies/incident-response.md`                                          |
| V16.3.3     | L2    | Security Events                | Verified (test)   | `app.audit_events` append-only ledger; 0501 suite                              |
| V16.3.4     | L2    | Security Events                | Documented        | `legal/policies/incident-response.md`                                          |
| V16.4.1     | L2    | Log Protection                 | Verified (review) | `app.audit_events` append-only ledger; 0501 suite                              |
| V16.4.2     | L2    | Log Protection                 | Verified (test)   | `app.audit_events` append-only ledger; 0501 suite                              |
| V16.4.3     | L2    | Log Protection                 | Documented        | `legal/policies/incident-response.md`                                          |
| V16.5.1     | L2    | Error Handling                 | Gap               | Gap: finding [A22-013](findings/A22-013.md)                                    |
| V16.5.2     | L2    | Error Handling                 | Verified (review) | `legal/policies/secure-development.md`                                         |
| V16.5.3     | L2    | Error Handling                 | Verified (test)   | `supabase/tests/9900_security_catalog.test.sql`                                |

## V17 WebRTC

| Requirement | Level | Section     | State          | Evidence                                                                                  |
| ----------- | ----- | ----------- | -------------- | ----------------------------------------------------------------------------------------- |
| V17.1.1     | L2    | TURN Server | Not Applicable | Not Applicable: no WebRTC in the dependency graph (A22 lockfile check); meetings link out |
| V17.2.1     | L2    | Media       | Not Applicable | Not Applicable: no WebRTC in the dependency graph (A22 lockfile check); meetings link out |
| V17.2.2     | L2    | Media       | Not Applicable | Not Applicable: no WebRTC in the dependency graph (A22 lockfile check); meetings link out |
| V17.2.3     | L2    | Media       | Not Applicable | Not Applicable: no WebRTC in the dependency graph (A22 lockfile check); meetings link out |
| V17.2.4     | L2    | Media       | Not Applicable | Not Applicable: no WebRTC in the dependency graph (A22 lockfile check); meetings link out |
| V17.3.1     | L2    | Signaling   | Not Applicable | Not Applicable: no WebRTC in the dependency graph (A22 lockfile check); meetings link out |
| V17.3.2     | L2    | Signaling   | Not Applicable | Not Applicable: no WebRTC in the dependency graph (A22 lockfile check); meetings link out |

## Supporting documents

- `legal/security/threat-model.md`
- `legal/security/findings/`
- `legal/policies/secure-development.md`
- `legal/policies/encryption.md`
- `legal/policies/access-control.md`
- `legal/policies/data-classification.md`
- `legal/policies/incident-response.md`
- `legal/policies/vendor-management.md`
- `legal/security/soc2-controls.md`
- `legal/security/iso27001-soa.md`

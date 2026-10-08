---
title: Encryption Policy
version: 1.0.0-draft
effective_date: The date this version is approved by the Owner
status: Draft for review by counsel before launch
audience: Internal
---

# Encryption Policy

> **Draft for review by counsel before launch.** This internal policy is a draft. It takes effect when the Owner approves it, and its effective date is that date of approval.

## 1. Purpose and Scope

This policy sets the cryptographic standards GHXSTSHIP Industries LLC ("GHXSTSHIP") uses to protect data in transit, at rest and on devices, and how keys are managed. It applies to the XOS 4.0 platform, its subprocessors as configured by GHXSTSHIP, company devices and backups.

## 2. Data in Transit

- All external connections use TLS 1.2 or higher. TLS 1.3 is preferred where both ends support it.
- HTTP Strict Transport Security is set with a long max-age, includeSubDomains and preload, and every platform domain is submitted to the HSTS preload list.
- Cipher suites are limited to those offering forward secrecy and authenticated encryption.
- Connections between the application and the database, and to every subprocessor API, use TLS with certificate validation.
- Custom domains receive certificates automatically through Vercel. Custom email sending domains are verified with SPF, DKIM and DMARC.
- Webhook payloads are signed with HMAC-SHA256 over the timestamp and body, and receivers are told to reject stale timestamps.

## 3. Data at Rest

- Database storage, file storage and backups are encrypted with AES-256 by the platform providers, with keys they manage.
- **Field-level encryption.** Tax identifiers, bank details, government identifiers and medical encounter notes are encrypted at the field level with pgcrypto before they are stored. Only stored procedures that check the caller's capability decrypt them, and only the last four digits of tax identifiers and bank accounts are ever displayed after entry.
- Integration credentials and other secrets are stored in Supabase Vault and referenced by ID. They never appear in tables, logs or the repository.

## 4. Devices

- Compass stores its offline database encrypted with SQLCipher. Its key is held in the iOS Keychain or Android Keystore and protected by device authentication. Remote sign-out wipes the store.
- Company laptops use full-disk encryption (FileVault, BitLocker or LUKS) with a strong login secret and automatic screen lock.

## 5. Passwords and Tokens

- Supabase Auth stores passwords as salted hashes using a modern adaptive algorithm. GHXSTSHIP never stores plaintext passwords.
- API keys and token links are stored as hashes and shown in full only once, at creation.
- Session and access tokens are short-lived JWTs signed by the platform. Signing keys are rotated at least once a year and immediately on suspected compromise.

## 6. Key Management

| Key                         | Custodian                                            | Rotation                                                              |
| --------------------------- | ---------------------------------------------------- | --------------------------------------------------------------------- |
| Field-level encryption keys | Supabase Vault, accessible to stored procedures only | Annually and on suspected compromise, with re-encryption              |
| JWT signing keys            | Supabase Auth                                        | Annually and on suspected compromise                                  |
| Webhook signing secrets     | Per endpoint, in Vault                               | On customer request and on suspected compromise                       |
| Subprocessor API keys       | Vercel encrypted environment variables and Vault     | Annually, on staff departure with access, and on suspected compromise |
| Mobile signing credentials  | Expo EAS credentials service                         | Per platform requirements                                             |
| Commit signing keys         | Each maintainer                                      | When a device is replaced or lost                                     |

- Keys are generated with cryptographically secure random sources.
- No key is committed to the repository. CI secret scanning blocks any commit containing one.
- Access to key material is limited to named people and logged.

## 7. Prohibited Practices

- Custom or home-made cryptography.
- MD5, SHA-1, DES, 3DES, RC4 or ECB mode for any security purpose.
- Sending secrets by email, chat or ticket. Use the password manager's sharing feature.

## 8. Export Considerations

GHXSTSHIP uses standard, publicly available encryption. The Security Lead confirms the export classification of the Compass app before each store submission.

## 9. Review

This policy is reviewed at least once a year, and when a cryptographic algorithm in use is deprecated by NIST or a comparable authority.

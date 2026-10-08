---
title: Records of Processing and Lawful Basis Registry
version: 1.0.0-draft
effective_date: The date this version is approved by the Owner
status: Draft for review by counsel before launch
audience: Internal; available to supervisory authorities on request
---

# Records of Processing and Lawful Basis Registry

> **Draft for review by counsel before launch.** This internal record is a draft. It takes effect when the Owner approves it, and its effective date is that date of approval.

This record meets GDPR Article 30, UK GDPR Article 30, the Swiss nFADP record duty, and the documentation duties of the other regimes in Section 14.3 of the build specification. Part A covers processing where GHXSTSHIP Industries LLC ("GHXSTSHIP") is controller. Part B covers processing as processor for Customers. The controller's postal address, privacy officer and representatives are those published on the contact page at /legal/contact.

## Part A: GHXSTSHIP as Controller

| ID   | Activity                              | Data subjects                   | Personal data                                                             | Purpose                                          | Lawful basis (GDPR)                                               | Recipients                                                  | Transfers outside EEA and UK                     | Retention                                        |
| ---- | ------------------------------------- | ------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------ | ----------------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------ |
| C-01 | Account creation and sign-in          | All users                       | Name, email, phone, sign-in method, passkey public keys, password hash    | Provide and secure accounts                      | Art. 6(1)(b) contract                                             | Supabase, Vercel                                            | United States, under the EU SCCs and UK Addendum | Life of account                                  |
| C-02 | Security logging and fraud prevention | All users                       | IP address, device, sign-in events, audit events                          | Protect the Service and users                    | Art. 6(1)(f) legitimate interests                                 | Supabase, Sentry                                            | United States, under the EU SCCs and UK Addendum | Audit 7 years, personal data redacted at 90 days |
| C-03 | Marketplace profile publication       | People with a Gateway profile   | Profile fields at the visibility the person sets                          | Let people find opportunities                    | Art. 6(1)(b) contract                                             | Public, or orgs the person shares with                      | United States, under the EU SCCs and UK Addendum | Until deleted by the person                      |
| C-04 | Opportunity ranking                   | People with a Gateway profile   | Skills, certifications, location to city level, availability              | Recommend matching opportunities                 | Art. 6(1)(b) contract                                             | None external                                               | Not applicable                                   | Derived at query time, not stored                |
| C-05 | Subscription billing and tax          | Customer billing contacts       | Name, email, company, billing address, tax ID, invoices                   | Bill and collect taxes                           | Art. 6(1)(b) contract and 6(1)(c) legal obligation                | Stripe                                                      | United States, under the EU SCCs and UK Addendum | 7 years after fiscal year                        |
| C-06 | Support                               | Users who contact support       | Ticket content, consented diagnostics                                     | Resolve requests                                 | Art. 6(1)(b) contract and 6(1)(f) legitimate interests            | Support tooling selected under the Vendor Management Policy | As listed for that tool                          | 3 years; diagnostics 90 days                     |
| C-07 | Consent and acceptance records        | All users and site visitors     | Consent choices, GPC signals, document acceptances with version, time, IP | Prove consent and acceptance                     | Art. 6(1)(c) legal obligation                                     | Supabase                                                    | United States, under the EU SCCs and UK Addendum | As in the Data Retention and Deletion Policy     |
| C-08 | Service email and SMS                 | Users                           | Email, phone, message content                                             | Security and service notices                     | Art. 6(1)(b) contract                                             | Resend, Twilio                                              | United States, under the EU SCCs and UK Addendum | Delivery logs 90 days                            |
| C-09 | Marketing to business contacts        | Prospects and Customer contacts | Name, business email, company, preferences                                | Inform about XOS                                 | Art. 6(1)(a) consent, or 6(1)(f) where the law allows soft opt-in | Resend                                                      | United States, under the EU SCCs and UK Addendum | Until unsubscribe or 2 years inactive            |
| C-10 | Website performance measurement       | Site visitors who consent       | Web Vitals timings, error reports                                         | Improve performance                              | Art. 6(1)(a) consent (ePrivacy)                                   | Sentry                                                      | United States, under the EU SCCs and UK Addendum | 90 days                                          |
| C-11 | Data subject requests                 | Requesters                      | Identity verification data, request and outcome                           | Meet rights obligations                          | Art. 6(1)(c) legal obligation                                     | Supabase                                                    | United States, under the EU SCCs and UK Addendum | 7 years after closure                            |
| C-12 | Marketplace moderation                | Reporters and reported parties  | Report content, decision, statement of reasons                            | Notice and action under the DSA and our policies | Art. 6(1)(c) legal obligation and 6(1)(f) legitimate interests    | Supabase                                                    | United States, under the EU SCCs and UK Addendum | 7 years                                          |
| C-13 | Vulnerability reports                 | Researchers                     | Name, contact, report                                                     | Fix security issues                              | Art. 6(1)(f) legitimate interests                                 | GitHub                                                      | United States, under the EU SCCs and UK Addendum | 7 years                                          |

No special category data is processed as controller. Sensitive personal information under the CCPA is limited to account login credentials, used only to provide and secure the Service.

## Part B: GHXSTSHIP as Processor

| Item                        | Record                                                                                                                                                     |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Controllers                 | Each Customer organization, as recorded in its account                                                                                                     |
| Categories of processing    | Hosting, storage, synchronization, transmission, display, search, export, deletion, notifications, document generation and optional AI-assisted processing |
| Data subjects and data      | As in Annex I of the Data Processing Agreement                                                                                                             |
| Subprocessors and transfers | As on the Subprocessor List, under the EU SCCs, UK Addendum and Swiss amendments incorporated in the Data Processing Agreement                             |
| Security measures           | Annex II of the Data Processing Agreement                                                                                                                  |
| Retention                   | Customer-configured within the Data Retention and Deletion Policy                                                                                          |

## Part C: Lawful Basis Registry in the Product

Customers record their own lawful basis per processing activity in Settings, Data and Privacy. The registry stores, for each activity: the purpose, the data categories, the lawful basis, for legitimate interests a reference to the balancing test, for consent a link to the consent records, and the retention policy. The DSAR workflow and retention purge read this registry. GHXSTSHIP ships a starter registry for common production activities, such as crew scheduling, timekeeping, payroll export, background checks, incident reporting and medical encounters, which each Customer must review and adopt.

## Part D: Transfer Documentation

| Regime                                      | Mechanism and record                                                                                                |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| GDPR                                        | 2021 EU SCCs (Modules Two and Three) with a transfer impact assessment per subprocessor kept by the Privacy Officer |
| UK GDPR                                     | UK Addendum to the EU SCCs                                                                                          |
| Swiss nFADP                                 | EU SCCs with Swiss amendments                                                                                       |
| Quebec Law 25                               | Privacy impact assessment before transfer outside Quebec, kept by the Privacy Officer                               |
| LGPD, APPI, Australia                       | Contractual safeguards in the Data Processing Agreement; transfer notices in the Privacy Policy                     |
| India, Singapore, South Africa, South Korea | Contractual safeguards, transfer notices, and consent where the regime requires it                                  |

## Review

The Privacy Officer reviews this record every release that adds processing, and at least once a year.

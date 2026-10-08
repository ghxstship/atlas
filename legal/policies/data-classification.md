---
title: Data Classification Policy
version: 1.0.0-draft
effective_date: The date this version is approved by the Owner
status: Draft for review by counsel before launch
audience: Internal
---

# Data Classification Policy

> **Draft for review by counsel before launch.** This internal policy is a draft. It takes effect when the Owner approves it, and its effective date is that date of approval.

## 1. Purpose and Scope

This policy defines how GHXSTSHIP Industries LLC ("GHXSTSHIP") classifies information and the handling each class requires. It applies to company information and to Customer Data in XOS 4.0, where the classification is built into the product as a column registry.

## 2. Classes

| Class        | Definition                                             | Examples                                                                                                                                     |
| ------------ | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Public       | Approved for anyone                                    | Published canon data, public marketplace listings, documentation, published legal documents                                                  |
| Internal     | For members of the organization; low harm if disclosed | Project schedules, run of show, internal SOPs, most records                                                                                  |
| Confidential | Harm to the organization or people if disclosed        | Budgets, contracts, bids, ratings, internal notes, personal contact details, source code security findings                                   |
| Restricted   | Serious harm if disclosed; often regulated             | Pay rates, bank details, tax identifiers, government identifiers, medical encounter notes, background check results, credentials and secrets |

When information combines classes, the highest class applies.

## 3. Classification in the Product

- Every database column carries a classification in the column registry. A migration that adds a column without one fails review.
- Restricted columns are encrypted at the field level where they hold identifiers or medical notes, and masked in views and API responses unless the caller holds the matching capability, for example `data.restricted.read.payroll`. Masking keeps the field present and marked as masked so the interface can explain why.
- Medical encounter records are restricted to the Medical capability, excluded from exports and AI features by default, and handled with safeguards aligned to the HIPAA Security Rule: access control, audit logging of every read, encryption, and minimum necessary disclosure.
- Restricted fields are never sent to AI models.

## 4. Handling Rules

| Rule                         | Public   | Internal                           | Confidential                                   | Restricted                                                           |
| ---------------------------- | -------- | ---------------------------------- | ---------------------------------------------- | -------------------------------------------------------------------- |
| Export and download          | Allowed  | Allowed for members                | Requires the export capability                 | Requires the restricted export capability and step-up authentication |
| Share links                  | Allowed  | Allowed with expiry                | Allowed with expiry and access code            | Not allowed                                                          |
| Watermark on PDFs and images | None     | None                               | Viewer email and timestamp                     | Viewer email and timestamp                                           |
| Encryption at rest           | Platform | Platform                           | Platform                                       | Platform plus field level for identifiers and medical notes          |
| External visibility          | Allowed  | Only through `external_visibility` | Only through allowlisted views                 | Only the person's own data, last four digits after entry             |
| Logs and error reports       | Allowed  | Allowed                            | Scrubbed of personal data                      | Never logged                                                         |
| Email and chat               | Allowed  | Allowed                            | Share by link to the record, not by attachment | Never                                                                |

## 5. Company Information

Company documents follow the same classes. Restricted company information, such as credentials and personnel records, is kept only in the password manager or systems approved by the Security Lead.

## 6. Labeling

Generated PDFs of Confidential and Restricted records carry the class and a watermark. Internal documents in the repository state their audience in their front matter.

## 7. Review

The Privacy Officer reviews the column registry for new columns every release, and this policy at least once a year.

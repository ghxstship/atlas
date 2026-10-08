---
title: Data Protection Impact Assessment Template
version: 1.0.0-draft
effective_date: The date this version is published at /legal
status: Draft for review by counsel before launch
audience: Customers and internal
---

# Data Protection Impact Assessment Template

> **Draft for review by counsel before launch.** This template is a draft. It takes effect when GHXSTSHIP Industries LLC publishes it at /legal, and its effective date is that date of publication.

GHXSTSHIP Industries LLC uses this template for its own high-risk processing and offers it to Customers for assessing their use of XOS 4.0. It follows GDPR Article 35 and the UK ICO's DPIA guidance, and also serves as a privacy impact assessment under Quebec Law 25. Complete each section; the guidance in italics explains what to write.

## 1. Overview

| Field             | Entry                                                                     |
| ----------------- | ------------------------------------------------------------------------- |
| Assessment title  | _Name of the processing, for example "Geofenced clock-in for event crew"_ |
| Controller        | _Organization name and its privacy contact_                               |
| Assessor and date | _Who completed the assessment and when_                                   |
| Approver and date | _Who accepted the residual risk and when_                                 |
| Next review date  | _No later than 12 months, or on a significant change_                     |

## 2. Need for a DPIA

_Explain why a DPIA is needed. Typical triggers in XOS: systematic monitoring of workers (location at clock-in, kiosk photos), large-scale processing of special category data (medical encounters at events), criminal records data (background checks), profiling (opportunity ranking), new technology (AI extraction), or transfer outside the region._

## 3. Description of the Processing

- **Nature:** _How data is collected, used, stored and deleted. Name the XOS modules and settings involved._
- **Scope:** _Data categories, special categories, volume, number of people, frequency, retention, geography._
- **Context:** _Relationship with the people, their expectations, whether any are vulnerable (for example minors over 16 or temporary workers)._
- **Purposes:** _What you want to achieve and the benefit to you and to the people._

## 4. Consultation

_Record who you consulted: workers or their representatives, your privacy officer or DPO, security staff, GHXSTSHIP as processor, and any others._

## 5. Necessity and Proportionality

- Lawful basis and, for legitimate interests, the balancing test: _entry_
- Why the processing is necessary and no less intrusive means would work: _entry_
- Data minimization settings used in XOS: _for example EXIF location stripped, city-level profile location, field masking, external access windows_
- Information given to people: _notices, Worker Terms, in-app disclosures_
- How rights are supported: _DSAR workflow, consent withdrawal, objection_
- Processor and transfer safeguards: _Data Processing Agreement, Subprocessor List, transfer mechanism_

## 6. Risks

| Risk to individuals                | Likelihood (Remote, Possible, Probable) | Severity (Minimal, Significant, Severe) | Overall (Low, Medium, High) |
| ---------------------------------- | --------------------------------------- | --------------------------------------- | --------------------------- |
| _Describe the risk and its source_ | _entry_                                 | _entry_                                 | _entry_                     |

## 7. Measures to Reduce Risk

| Risk    | Measure                                                     | Effect (Eliminated, Reduced, Accepted) | Residual risk | Approved    |
| ------- | ----------------------------------------------------------- | -------------------------------------- | ------------- | ----------- |
| _entry_ | _XOS controls or your own procedures that address the risk_ | _entry_                                | _entry_       | _Yes or No_ |

## 8. Sign-Off

| Item                               | Name and date | Notes                                                                                |
| ---------------------------------- | ------------- | ------------------------------------------------------------------------------------ |
| Measures approved by               | _entry_       | _Integrate actions into the project plan with dates and owners_                      |
| Residual risk approved by          | _entry_       | _If high residual risk remains, consult the supervisory authority before processing_ |
| DPO or privacy officer advice      | _entry_       | _Summarize the advice_                                                               |
| Advice accepted or overruled       | _entry_       | _If overruled, give reasons_                                                         |
| Consultation responses reviewed by | _entry_       | _If your decision departs from people's views, give reasons_                         |

## 9. XOS Reference Information

These facts about XOS support sections 5 and 7:

- Tenant isolation, role-based access and separation of duties are enforced in the database and tested on every build.
- Restricted fields (pay rates, bank details, tax and government identifiers, medical notes) are encrypted at the field level and masked by capability.
- Medical records are excluded from exports and AI features by default.
- Location is sampled only for clock events and incident reports; photo location metadata is stripped unless enabled.
- XOS does not perform facial recognition or create biometric templates.
- Background check reports are never stored; only result and reference.
- AI features are off by default, never receive Restricted or medical data, and never train on customer data.
- External parties' access to an engagement closes 18 months after Complete.

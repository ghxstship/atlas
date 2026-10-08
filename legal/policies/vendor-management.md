---
title: Vendor Management Policy
version: 1.0.0-draft
effective_date: The date this version is approved by the Owner
status: Draft for review by counsel before launch
audience: Internal
---

# Vendor Management Policy

> **Draft for review by counsel before launch.** This internal policy is a draft. It takes effect when the Owner approves it, and its effective date is that date of approval.

## 1. Purpose and Scope

This policy governs how GHXSTSHIP Industries LLC ("GHXSTSHIP") selects, contracts with, monitors and exits vendors that can affect the security, availability, confidentiality or privacy of XOS 4.0. It covers subprocessors (vendors that process Customer Personal Data), infrastructure and tooling vendors, open source dependencies, and integrations GHXSTSHIP builds.

## 2. Vendor Tiers

| Tier | Definition                                                                                      | Examples                                                                                                  |
| ---- | ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| 1    | Processes Customer Personal Data or hosts production                                            | Supabase, Vercel, Anthropic, Resend, Twilio, Stripe, Checkr, Sentry, Expo, Apple and Google push services |
| 2    | Has access to source code, CI, credentials or internal confidential data, but not Customer Data | Source host and CI, password manager, email and office suite                                              |
| 3    | No access to confidential data                                                                  | Design tools used with public material, documentation fonts                                               |

Customer-directed integrations (for example accounting, payroll, calendar and storage connectors) are vendors of the Customer, not of GHXSTSHIP. GHXSTSHIP reviews the security of each connector it builds, but does not onboard the provider as its own vendor.

## 3. Before Onboarding

For Tier 1 and Tier 2 vendors, the Security Lead completes a review that records:

- the business purpose, the data involved, its classification, and the data flows
- the vendor's independent assurance: a current SOC 2 Type II report, ISO/IEC 27001 certificate or equivalent, and any bridge letter
- encryption, access control, incident response and breach notification commitments
- data location and transfer mechanism, and the availability of EU processing for EU tenants
- subprocessors the vendor itself uses
- business continuity and its fit with our 1 hour recovery point and 4 hour recovery time objectives
- whether the vendor uses our data to train models or for its own purposes, which is not acceptable for Customer Data
- exit: how data is returned and deleted

The Privacy Officer confirms that the written contract includes data protection terms no less protective than our Data Processing Agreement, including the EU SCCs and UK Addendum where data leaves the region.

## 4. Subprocessor Changes

- A new Tier 1 subprocessor is added to the Subprocessor List with at least 30 days' notice to subscribers before it processes Customer Personal Data.
- Customer objections are handled under Section 7.3 of the Data Processing Agreement.
- The change and its notice date are recorded in the list's version history.

## 5. Ongoing Monitoring

- Tier 1 vendors are reviewed every year: new assurance reports, any incidents, changes to their subprocessors and terms.
- Tier 2 vendors are reviewed every two years.
- Vendor status pages and security advisories for Tier 1 vendors are monitored, and incidents are logged in the risk register.
- Open source dependencies are pinned, kept current by automated update requests, scanned for vulnerabilities and license compatibility on every change, and listed in the CycloneDX SBOM of each release.

## 6. Exit

When a vendor relationship ends, GHXSTSHIP revokes the vendor's credentials and integrations, obtains return or certified deletion of our data, updates the Subprocessor List, and records the exit in the vendor register.

## 7. Vendor Register

The Security Lead keeps a vendor register with, for each vendor: tier, owner, purpose, data, location, contract and DPA dates, assurance evidence and its expiry, last review date, and next review date.

## 8. Review

This policy is reviewed at least once a year.

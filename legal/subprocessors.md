---
title: Subprocessor List
version: 1.0.0-draft
effective_date: The date this version is published at /legal
status: Draft for review by counsel before launch
---

# Subprocessor List

> **Draft for review by counsel before launch.** This document is a draft. It is not in effect and no one may rely on it. It takes effect only when GHXSTSHIP Industries LLC publishes it at /legal, and its effective date is that date of publication.

This list names the third parties that GHXSTSHIP Industries LLC ("GHXSTSHIP") engages to process Customer Personal Data in providing XOS 4.0. It is Annex III of our Data Processing Agreement. The list is derived from the technology stack recorded in our architecture decisions, and it changes only through the notice process below.

## 1. Change Notifications

- We give at least 30 days' notice before a new subprocessor processes Customer Personal Data.
- Anyone can subscribe to change notifications with the subscription form on this page. Each Customer's Owner and Admins are subscribed by default and can unsubscribe in Settings, Notifications.
- Each notice names the subprocessor, what it will process, where, and why, and links to the version history of this page.
- A Customer may object under Section 7.3 of the Data Processing Agreement.

## 2. Infrastructure Subprocessors

These subprocessors process Customer Personal Data for every Customer.

| Subprocessor                       | Service used                                                                     | What it processes                                                                                                                           | Location                                                                                                                                                 |
| ---------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Supabase, Inc.                     | Postgres database, Auth, Storage, Realtime, Edge Functions, Vault, log drains    | All Customer Data: records, files, authentication data, realtime messages, secrets references. Hosted on Amazon Web Services infrastructure | United States (AWS US East) by default. Enterprise EU tenants: an AWS region in the European Union, named here before the first EU tenant is provisioned |
| Vercel Inc.                        | Hosting and edge network for Atlas, Gateway and the documentation site           | Requests and responses passing through the web applications, including personal data shown on screen; request logs with IP addresses        | Global edge network; server functions in the United States by default and in the European Union for EU tenants                                           |
| Sentry (Functional Software, Inc.) | Error and performance monitoring for web and mobile                              | Error reports and traces with user ID, device and browser data. Request bodies and form values are scrubbed before sending                  | United States                                                                                                                                            |
| Resend (Plus Five Five, Inc.)      | Transactional and notification email, per-tenant sending domains                 | Recipient name and email address, email content, delivery and bounce events                                                                 | United States                                                                                                                                            |
| Twilio Inc.                        | SMS notifications under 10DLC registration                                       | Recipient phone number, message content, consent and opt-out events, delivery status                                                        | United States                                                                                                                                            |
| Expo (650 Industries, Inc.)        | EAS Build, EAS Submit, EAS Update and Expo push notification service for Compass | Push tokens and notification content routed through the Expo push service; app builds and updates contain no Customer Data                  | United States                                                                                                                                            |
| Apple Inc.                         | Apple Push Notification service                                                  | Device push tokens and notification content for iOS devices                                                                                 | United States and Apple's global infrastructure                                                                                                          |
| Google LLC                         | Firebase Cloud Messaging                                                         | Device push tokens and notification content for Android devices                                                                             | United States and Google's global infrastructure                                                                                                         |

## 3. Feature Subprocessors

These subprocessors process Customer Personal Data only when the Customer uses the related feature.

| Subprocessor   | Feature                                                                                                                              | What it processes                                                                                                                                                                                                     | Location      |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| Anthropic, PBC | AI features (assistant, plain-language filters, document extraction, drafting, summaries, mapping help), when an Admin turns them on | The prompt and the minimum record context needed for the request, and the model output. Medical records and Restricted fields are never sent. Anthropic does not train models on this data under its commercial terms | United States |
| Stripe, Inc.   | Subscription billing, Stripe Tax and Customer Portal; Stripe Connect payouts to External Parties when the Customer enables them      | Billing contacts, tax identifiers and addresses for tax calculation, payout recipient identity and bank details entered on Stripe-hosted forms. Card data is entered only on Stripe-hosted pages                      | United States |
| Checkr, Inc.   | Background checks for engagements whose onboarding packet requires one                                                               | Candidate identity details needed to run the check, FCRA disclosure and authorization, adverse action notices. XOS stores only the result and reference, never the report                                             | United States |

Stripe acts as an independent controller for some data it processes to meet its own legal obligations, such as fraud prevention and financial regulation, under its own privacy policy. Checkr acts as a consumer reporting agency under the Fair Credit Reporting Act for the reports it prepares.

## 4. Services That Are Not Subprocessors

- **PowerSync (open edition).** Compass offline sync runs on PowerSync's open edition, which GHXSTSHIP self-hosts inside the infrastructure above. If GHXSTSHIP ever moves sync to a hosted PowerSync service, it will be added to this list with 30 days' notice.
- **Map tiles.** Maps use Protomaps PMTiles files served from our own Supabase Storage. No third-party map service receives location data.
- **Exchange rates.** We download European Central Bank reference rates. No personal data is sent.
- **Customer-directed integrations.** When a Customer connects an integration, such as Xero, QuickBooks Online, NetSuite, Ramp, Google Calendar, Microsoft 365, Google Drive, OneDrive and SharePoint, Dropbox, Slack, Microsoft Teams, Gusto, ADP, Rippling, Zapier, Make, Zoom, Google Meet, UPS, FedEx or DHL, data flows to that provider on the Customer's instruction and under the Customer's own agreement with it. Those providers are the Customer's vendors, not GHXSTSHIP's subprocessors.
- **Identity providers.** Google, Apple and Microsoft sign-in, and a Customer's own SAML or OIDC identity provider, authenticate users under their own terms. They receive only what the sign-in protocol requires.

## 5. Version History

Every change to this list is published here with its date, the change, and the date the notice was sent.

| Version     | Change                                     |
| ----------- | ------------------------------------------ |
| 1.0.0-draft | First list, derived from the XOS 4.0 stack |

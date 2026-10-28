# ADR 0022: Module Migration Ranges and Late Slots

- Status: Accepted (amends ADR 0004)
- Date: 2026-10-14
- Decider: Orchestrator

## Context

ADR 0004 gave all domain schema to A03 (0300 to 0499). In Wave 3 every module agent needs its own tables, lifecycles, RPCs and events. Routing all of them through one agent made it a bottleneck for the whole wave. Module migrations also run before A28's engagements (0700), so a module column that references `app.engagements` fails on a fresh reset.

## Decision

1. **Module ranges.** Each module agent owns ten migration numbers:

   | Agent | Range        |
   | ----- | ------------ |
   | A07   | 0400 to 0409 |
   | A08   | 0410 to 0419 |
   | A09   | 0420 to 0429 |
   | A10   | 0430 to 0439 |
   | A11   | 0440 to 0449 |
   | A12   | 0450 to 0459 |
   | A13   | 0460 to 0469 |
   | A14   | 0470 to 0479 |
   | A15   | 0480 to 0489 |
   | A16   | 0490 to 0499 |

   A03 keeps 0300 to 0399. In its range, a module agent may add tables, columns, lifecycles, RPCs, domain event types and triggers, realtime publication entries, and storage buckets for its module. It may `create or replace` an A03 function its module depends on, if pgTAP shows A03's tests still pass.

2. **Late slots.** References to tables created in a later range go in a late slot that runs after every range:

   | Agent | Late slot    |
   | ----- | ------------ |
   | A03   | 0940 to 0949 |
   | A07   | 0950 to 0954 |
   | A08   | 0955 to 0959 |
   | A09   | 0960 to 0964 |
   | A10   | 0965 to 0969 |
   | A11   | 0970 to 0974 |
   | A12   | 0975 to 0979 |
   | A13   | 0980 to 0984 |
   | A14   | 0985 to 0989 |
   | A15   | 0990 to 0994 |
   | A16   | 0995 to 0999 |

   The orchestrator keeps 0900 to 0939 for contract corrections and generated plan seeds (ADR 0018).

3. **Shared-stack testing.** An agent without its own stack tests migrations against the shared stack inside one transaction that rolls back. The orchestrator runs a full reset before each merge.

## Consequences

- Schema requests no longer queue behind one agent.
- A31 (views, help and support) owns 0640 to 0649, the end of A19's original 0600 to 0649 integration range; A19 keeps 0600 to 0639.
- `api_external` projections still belong to A28. Views over late-slot columns go in A28's post-late range, 1000 to 1009, which sorts after 0999 as text and as a number.

## Amendment (2026-10-16): post-late ranges

Follow-up agents that need tables from every module range take blocks after A28's 1000 to 1009:

| Agent | Range        | Scope                                                         |
| ----- | ------------ | ------------------------------------------------------------- |
| A29   | 1010 to 1014 | Workforce late slot                                           |
| A32   | 1020 to 1029 | Gateway and Compass follow-up, including `api_external` views |
| A33   | 1030 to 1039 | Platform workflow: approvals, trash, templates, state labels  |

A32 adds `api_external` views in its own range because A28 is complete; the projection rules in ADR 0019 still apply.

## Amendment (2026-10-17): orchestrator integration range

Fixes that join two agents' work after both have merged (for example A43's individual payees and A44's invoice notifications) take numbers 1190 to 1199, so they sort after every agent range in use.

## Amendment (2026-10-18): A45 and A47

A45 (Continue on another device and push approval) takes 1140 to 1144. A47 (gate audit fixes) takes 1150 to 1154.

## Amendment (2026-10-19): A49, A50 and A51

A49 (generated document templates, gate 19) takes 1160 to 1164. A50 (API contract handlers, gate 5) takes 1170 to 1179. A51 (Playbook field targets and cognitive load) takes 1180 to 1184. A48 (route JavaScript) has no range.

## Amendment (2026-10-19): A52 to A55

A52 (unbuilt spec features: legal entities, IP allow-list, access reviews, break-glass, project shares, blocks, multiple project roles) takes 1200 to 1219. A54 (invariant traceability and security fixes) takes 1220 to 1229. A53 (core-screen visual baselines) and A55 (release tooling) have no range.

## Amendment (2026-10-19): A56 to A58

A56 (canon rulings, decision 25) takes 1230 to 1239. A57 (platform decisions: ClamAV, licenses, Spanish, .xls) takes 1240 to 1249. A58 (plan pricing, decision 18) takes 1250 to 1259.

## Amendment (2026-10-20): A60 to A73

A62 takes 1260 to 1264, A63 1265 to 1269, A64 1270 to 1274, A61 1275 to 1279, A65 1280 to 1289, A66 1290 to 1294, A69 1295 to 1299, A70 1300 to 1304, A71 1305 to 1309, A72 (Google sign-in) 1310 to 1314 and A73 (machine translation) 1315 to 1319. A60, A67 and A68 have no range.

## Amendment (2026-10-20): A74 to A82 and a second orchestrator block

A76 (settings enforcement) takes 1320 to 1329, A77 (authentication and step-up) 1330 to 1339, A78 (work details) 1340 to 1349, A79 (org lifecycle) 1350 to 1359, A80 (push, SMS and notification registry) 1360 to 1369, A81 (navigation and keyboard) 1370 to 1379 and A82 (compliance flows) 1380 to 1389. A74 and A75 have no range. The orchestrator's first block (1190 to 1199) sorts before migrations it now builds on, so it takes a second block, 1390 to 1399.

## Amendment (2026-10-21): A83 to A99

A83 (integration runtime, import and warehouse delivery) takes 1400 to 1409, A84 (calendar feeds and the project inbox) 1410 to 1419, A85 (Edge Function bundles and kiosk re-keying) 1420 to 1429, A86 (settings surfaces) 1430 to 1439, A87 (global search) 1440 to 1449, A88 (collaboration and power editing) 1450 to 1459, A89 (marketplace alerts and Gateway gaps) 1460 to 1469, A90 (operator console) 1470 to 1479, A91 (automation engine) 1480 to 1489, A92 (Compass NFC, receipts and external screens) 1490 to 1499, A93 (Compass orgs, brand, widgets and passes) 1500 to 1509, A94 (supply chain and platform operations) 1510 to 1519, A95 (AI entry points) 1520 to 1529, A96 (sandbox, feedback, analytics and installable apps) 1530 to 1539, A97 (locales, canon translations and rates) 1540 to 1549, A98 (sustainability measurements) 1550 to 1559 and A99 (authentication follow-ups) 1560 to 1569.

Within the orchestrator's second block, 1390 adds the project time zone to engagements, 1391 restores the feed post defaults that 1365 dropped, and 1392 to 1399 hold the fixes from the batch-c integration audit: 1392 to 1394 for notifications, 1395 to 1397 for settings and approvals, and 1398 and 1399 for calendars.

## Amendment (2026-10-23): a third orchestrator block

The orchestrator's second block (1390 to 1399) sorts before A83 to A99's ranges, so fixes that join the batch-c integration audit fixes with their work take a third block, 1590 to 1599, which sorts after every agent range in use. 1590 recreates private.notify and app.claim_notification_deliveries from A89's 1461 with 1393's actor and bypass window put back, which 1461 dropped when it redefined both from 1367. It also recreates app.claim_sms_summaries from 1393 so that its suppression, category-drop and claim updates touch only a held text's live queue row, and A90's private.notify_moderation_decision and app.console_decide_appeal from 1473 so that their notifications name the platform as the actor rather than the operator who decided. 1591 restates the private.invariants row for invariant 8 (1220) in the words ADR 0033 decision 56 gives the spec: access codes, recovery codes and kiosk PINs are stored hashed, and second-factor secrets are held encrypted by the auth service. 1592 recreates app.open_support_ticket from 0643 so that its refusal for the Access plan names the help center alone, as the Service Level Agreement does since decision 73 deferred the community forum and in-app chat. 1593 adds the `compliance.us_forms` flag to A18's flag system (0540), off by default, behind which ADR 0033 decision 54 defers A82's OSHA forms and WH-347, with a guard on the tables of 1385 and 1386 that refuses their new rows and every issue of a certified payroll while the flag is off. 1594 restates the description 1060 gave app.partner_client_prices, which said the partner bills its clients through Stripe Connect: under decision 66 the partner invoices them itself and XOS records the price for its reference.

## Amendment (2026-10-23): blocks for the owner decisions of 2026-10-23

The work that follows the owner decisions of 2026-10-23 (ADR 0033) takes blocks after the orchestrator's third: 1600 to 1609 for record keys in record notifications, 1610 to 1619 for the canon rulings and Standard Library seeding (WP18), 1620 to 1629 for the notification and access decisions (quiet-hours bypass, delivered reports in the Inbox, expenses for the Field role, spend authority, engagement fields), 1630 to 1639 for reporting and blocking in Compass and Sign in with Apple, 1640 to 1649 for Checkout, and 1650 to 1659 for operations (the read-only backup login and inbound email). Within WP18's block, 1613 came from the release candidate's CI repair: it restates private.gl_account_for_line so that members, who have no usage on schema private, can read the accounts budget and change order lines post to.

Within those blocks, 1600 adds private.record_key, a record's display key read as app.record_display_key reads it, and recreates the emitters of notifications about a record so that their message arguments carry the key the Inbox opens the record by: private.after_comment_mention and private.notify_comment_subscribers from 0580, private.notify_record_assignment from 1394 and A91's app.send_automation_notice from 1481.

## Amendment (2026-10-24): a fourth orchestrator block

The open-work packages A100 to A150 of the release after 4.0 take 1660 to 1999 in blocks of ten, so the orchestrator's fixes for that release take a fourth block, 2000 to 2009, which sorts after every one of them and after everything 4.0 applies. A migration that ships after a release must sort after every migration the release applied, or `supabase db push` refuses it as out of order. 2000 recreates api_public.open_share_link from 1380, its latest definition, with the opened file version as one more result column, so that a watermarked copy opened from a share link links to /files/{version} instead of printing the bearer link (finding A69-013). 2001 anonymizes the client of the CSMIA26 activation throughout the canon and generalizes the Standard Library SOPs and documents written from it, and 2002 releases those rows to every org (owner decisions on Linear RRR-67, 2026-10-24).

## Amendment (2026-10-25): the open-work ranges move after 4.0

4.0 applied 2000 to 2002 on production, so every open-work range in 1660 to 1999 now sorts before a migration the release applied, and `supabase db push` would refuse it as out of order. Each open-work package's migrations therefore move up by 350 when the package merges: 1660 becomes 2010, 1700 becomes 2050 and 1999 becomes 2349. The packages keep their order and their blocks of ten, and the orchestrator's 2000 to 2009 stays below all of them. A101's 1670 and 1671 shipped in 4.0 and keep their numbers. A104 is the first to move: 1700 and 1701 are now 2050 (account security notices) and 2051 (import finished notices). A100's 1660 and 1661 are now 2010 (vendor bank account encryption) and 2011 (supplier certificate number encryption). A102's 1680 is now 2030 (collection exports). A109's 1730 is now 2080 (Compass Profile certifications and documents), and A114's 1750 is now 2100 (custom object record activity). Fixes to merged packages that review found after merge take blocks from 2350: 2350 lets a supplier diversity certification be declared with its number in one call (A100), 2360 returns an export's rows as one value so PostgREST's 1,000-row cap no longer cuts them, 2370 adds the export views that scope My Work, Activity and receipts as their pages do, and 2380 and 2381 carry a page's default filters, such as archived projects, into its export (A102). A103's 1690 and 1691 are now 2040 (uploaded PDF watermarks) and 2041 (file handover), A121's 1800 and 1801 are now 2150 (bulk edit of logistics and hospitality) and 2151 (bulk edit of guest lists), A122's 1810 and 1811 are now 2160 (Gateway bulk actions) and 2161 (Gateway live updates), and A123's 1820 is now 2170 (live lists and presence); A108 and A112 add no migration.

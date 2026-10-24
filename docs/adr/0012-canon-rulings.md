# ADR 0012: Canon Rulings

- Status: Accepted (part of the Wave 1 contract freeze)
- Date: 2026-10-09
- Decider: Owner rulings, recorded through the Claude Design session and by the orchestrator
- Source: decisions D11 to D17 and D19 in `design/xos-design-system/README.md`, and section 7 of `design/xos-design-system/HANDOFF.md`

## Context

The Bible and the Playbook disagree in places, and several Playbook lists bundle facts that Third Normal Form (Section 3.15) requires to be separate. The owner ruled on each conflict.

## Decision

1. **D11. Grades** are Base, Elevated and Premium, per the build prompt, stored as rows of a `grade` table. The Bible tab 34 labels are superseded.
2. **D12. Roles.** Role codes and job titles follow the Playbook Roles Library; rate cards reference a role code and never repeat its title.
3. **D13. GL posting is derived.** A role code or URID posts to its class's one account of the requested type. No row stores a GL account; `rate_card_resolved` resolves postings in the database.
4. **D14. Overtime** multipliers are numbers on overtime rules (OTR-001 Standard Overtime 1.5 and 2.0, OTR-002 Exempt 1.0 and 1.0) referenced by rate cards. "1.5x" is display formatting.
5. **D15. Emergency codes and protocols are global.** Protocol steps name services; the venue's jurisdiction supplies agencies through `jurisdiction_agency`, which also replaces the Regulatory Agency enumeration. The Emergency Radio Code enumeration is retired.
6. **D16. Engagement and Employment Type are retired.** Their facts become worker classification, pay basis and arrangement tables, with allowed combinations as tables and rules XOS-ENG-1 to XOS-ENG-5 enforced in the database. Retainer is always Independent Contractor (1099).
7. **D17. Volunteers** are permitted only for Nonprofit and Public Agency organizations (rule XOS-ENG-6). GHXSTSHIP Industries LLC is For-Profit.
8. **D19. Placement.** Canon tables live in the `xpms` schema in A01's range (0100 to 0199). Tables owned by other agents ship from the engagement contract (`export/canon/contract_engagement.sql`) in A02, A03 and A28's ranges. Jurisdictions hold Bible tab 11 in Third Normal Form, and `jurisdiction_resolved` returns the tab exactly.

## Consequences

- `design/xos-design-system/export/canon/` is the reference model; A01 implements it under ADR 0002 on Postgres 17, with the importer's output checked against the reference seed.
- Where a ruling changes a Bible count, the ruling wins and the importer's validation says so.
- `migration-report.txt` lists every Playbook row whose stored value the rulings change; the importer regenerates it under `canon/reports/`.

## Amendment (2026-10-23): owner decision 39

Owner decision 39 (ADR 0033, RRR-66) settles the Bible inconsistencies decision 25 left open, recorded as data in `canon/rulings/decision-39.yaml` and applied by the importer (migrations 0101, 0150 and 1610). Two of its rulings refine this ADR:

- **D12.** Bible tab 27's role codes are retired as an authority: the Roles Library alone decides which role codes exist, so 2000.50.02, 5000.50.03 and 6000.50.03 need no tab 27 row. `xpms.dim_role` keeps tab 27's rows for their staffing ratios and kit bases.
- **D13.** An item and a counterparty type may carry an explicit GL default, and a balance-sheet item needs one because no class derives it. A posting takes the item's explicit account first, then its class's account, then the counterparty type's default (`private.gl_account_for_line`, migration 1611). Roles still post by class.

The decision also ratifies the time unit dimension and declares Scope, Engage, Amplify and Close as gaps under doctrine 3.4 (`xpms.declared_gap`), which answers ADR 0014 open decision 6 and the unit dimensions of open decision 7.

## Amendment (2026-10-23): org copies of the emergency codes

WP18 (migration 1612, finding A65-027) narrows **D15**. The emergency code words and the protocols stay global, because crisis alerts and protocol steps name them, but each org now holds an editable copy of the codes in `app.emergency_codes`, as Section 7.2 asks of the whole Standard Library: the org sets each code's label, the emergency it announces and its place in the list, and cannot add a code word canon lacks. API v1's `emergencyCodes` still serves the global codes, and Compass's offline reference still caches them.

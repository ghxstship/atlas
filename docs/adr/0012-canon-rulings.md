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

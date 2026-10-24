# ADR 0041: Compliance Forms and State Overtime

- Status: Accepted
- Date: 2026-10-21
- Decider: A82 (RRR-127), finding A65-014; the owner and counsel confirm the items under Open questions
- Related: ADR 0002 (canon is importer-only), ADR 0004 (canon ownership), ADR 0031 (tagged PDF/UA-1 documents), ADR 0033

## Context

Section 14.5 asks for certified payroll in WH-347 format, OSHA Forms 300, 300A and 301, and state overtime rules including California daily overtime. None existed. The incident log (0353) records what happened, not the recordkeeping 29 CFR Part 1904 requires; payroll (0341, 0461) holds hours and rates per pay period, not per project and day; and the wage-hour rule (canon `xpms.wage_hour_rule`) holds only the federal FLSA row.

The fields in this ADR come from the official forms, read from the agencies' own files, and nothing is added to them:

- Form WH-347, Rev. January 2025, OMB No. 1235-0008, expires 01/31/2028, and its instructions: https://www.dol.gov/agencies/whd/forms/wh347
- OSHA Forms 300, 300A and 301, Rev. 04/2004, OMB No. 1218-0176, in the recordkeeping forms package with its instructions: https://www.osha.gov/sites/default/files/OSHA-RK-Forms-Package.pdf
- California Labor Code section 510(a), for daily overtime, double time and the seventh day.

## Decision

### 1. WH-347 (migration 1386, `@xos/data/certified-payroll`)

| Form field                                       | Source in XOS                                                                                                                                                                                                           |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Submission of final DBRA certified payroll form  | `certified_payroll_submissions.final_submission`, ticked when the week is issued                                                                                                                                        |
| Prime contractor or subcontractor                | `certified_payroll_projects.contractor_role`                                                                                                                                                                            |
| Project name                                     | `projects.name`                                                                                                                                                                                                         |
| Project No. or Contract No.                      | `certified_payroll_projects.contract_number`                                                                                                                                                                            |
| Certified Payroll No.                            | `certified_payroll_submissions.payroll_number`: 1 for the first week issued for the project, then in sequence; a week issued again keeps its number                                                                     |
| Business name and address                        | `certified_payroll_projects.business_name`, `business_address`                                                                                                                                                          |
| Project location                                 | `certified_payroll_projects.project_location` (full address, or at least county and state, as the instructions ask)                                                                                                     |
| Wage Determination No.                           | `certified_payroll_projects.wage_determinations`, every number and revision that applies                                                                                                                                |
| Week ending date                                 | The date chosen when issuing; the week is the seven days ending on it                                                                                                                                                   |
| (1A) Worker entry no.                            | Numbered from 1 by name; a worker in two classifications keeps one number, as the instructions ask                                                                                                                      |
| (1B to 1D) Last name, first name, middle initial | `people.family_name` and `given_name` (1340), else the last and first words of `full_name`; the middle initial only from a full name of three or more words                                                             |
| (1E) Worker identifying no.                      | The worker's own XOS number: the first eight characters of the membership id. Never a social security number, which the instructions forbid in full                                                                     |
| (2) J or RA                                      | `registered_apprentices` active in the week: RA with the progression level, else J                                                                                                                                      |
| (3) Labor classification                         | The canon role worked (`xpms.role.job_title`), from the shift, else the pay rate's role                                                                                                                                 |
| (4) ST and OT hours each day                     | Time entries on approved timesheets, split by `private.split_work_minutes` (1384) over all of the worker's projects that week (CWHSSA counts hours over 40 on and off the site); double time is shown as overtime hours |
| (5) Total hours                                  | The sum of column 4 on the project                                                                                                                                                                                      |
| (6A) Hourly wage rate, ST and OT                 | `pay_rates` in force on the week ending date in the project currency; OT is the rate times the overtime multiplier                                                                                                      |
| (7A) Gross amount earned                         | Hours on the project times their rates and multipliers                                                                                                                                                                  |
| (7B) Gross amount earned for all work            | The same over all of the worker's projects that week                                                                                                                                                                    |
| (6B), (6C), (8), (9)                             | Not held in XOS: the payroll provider computes fringe credits, payments in lieu, deductions and net pay. The CSV keeps the columns empty and the PDF says so                                                            |
| Page 2, Statement of Compliance                  | The form's wording, printed with the certifying official (the person issuing) and the date; the signature, title, phone and apprenticeship and fringe benefit plan tables are completed on signing                      |

The export is Restricted (pay rates): it needs `crew.payroll.export`, `data.restricted.read.payroll`, `data.export.restricted` and step-up authentication, and every issue is written to the audit log.

### 2. OSHA Forms 300, 300A and 301 (migration 1385, `@xos/data/osha`)

`app.osha_establishments` holds the establishment of the 300 header and the 300A "Establishment information" block (name, street, city, state, ZIP, industry description, NAICS). `app.osha_cases` holds one recordable case:

| Form                 | Field                                                                                                 | Column                                                                                                                                       |
| -------------------- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 300 (A), 301 item 10 | Case no.                                                                                              | `case_number`, numbered per establishment and year when left empty                                                                           |
| 300 (B), 301 item 1  | Employee's name                                                                                       | The person's full name, or `employee_name` for someone outside the org; "privacy case" on the 300 when `privacy_case` (1904.29(b)(6) to (9)) |
| 300 (C)              | Job title                                                                                             | `job_title`                                                                                                                                  |
| 300 (D), 301 item 11 | Date of injury or onset of illness                                                                    | `injury_date`; the log year is its year                                                                                                      |
| 300 (E)              | Where the event occurred                                                                              | `event_location`                                                                                                                             |
| 300 (F)              | Injury or illness, parts of body affected, and object or substance                                    | `description`                                                                                                                                |
| 300 (G) to (J)       | Death, days away from work, job transfer or restriction, other recordable case (most serious outcome) | `outcome`                                                                                                                                    |
| 300 (K), (L)         | Days away from work, days on job transfer or restriction                                              | `days_away`, `days_restricted`; counting stops at 180 together, as the instructions allow                                                    |
| 300 (M1) to (M6)     | Injury, skin disorder, respiratory condition, poisoning, hearing loss, all other illnesses            | `case_type`                                                                                                                                  |
| 301 items 2 to 5     | Street, city, state, ZIP; date of birth; date hired; male or female                                   | `employee_street`, `employee_locality`, `employee_region`, `employee_postal_code`, `date_of_birth`, `date_hired`, `employee_sex`             |
| 301 items 6 to 9     | Health care professional; treatment facility and address; emergency room; hospitalized overnight      | `health_care_professional`, `treatment_facility`, `facility_*`, `emergency_room`, `hospitalized_overnight`                                   |
| 301 items 12, 13     | Time employee began work; time of event, or cannot be determined                                      | `work_began_at`, `event_time`, `event_time_unknown`                                                                                          |
| 301 items 14 to 17   | Activity before; what happened; the injury or illness; object or substance (no personal information)  | `activity_before`, `what_happened`, `injury_detail`, `harmful_object`                                                                        |
| 301 item 18          | Date of death                                                                                         | `died_on`, only with the Death outcome                                                                                                       |
| 301 header           | Completed by, title, phone, date                                                                      | `completed_by`, `completed_title`, `completed_phone`, `completed_on`                                                                         |

`app.osha_annual_summaries` holds the 300A employment information (annual average number of employees, total hours worked) and the certification (company executive, title, phone, date). The 300A case totals come from `app.osha_summary` and contain no names, so anyone who reads incidents may read them. `app.osha_employment_estimate` fills the 300A worksheet from time entries and payroll runs as a starting figure the org confirms.

Cases are health information: only holders of `data.restricted.read.medical` read them, writing also needs `safety.incident.close`, and every change is in the audit trail. Every form PDF carries the Section 8.6 watermark.

### 3. Files

Each form renders through the ADR 0031 pipeline as tagged PDF/UA-1 (the Form 300 and WH-347 in landscape) and as CSV, every field through `csvField` (A69-005). `pnpm --filter @xos/data documents:verapdf` renders all four forms in both languages and they pass veraPDF. Atlas serves them at `/{org}/forms/{form}/{id}`; the WH-347 is a POST because issuing numbers the week.

### 4. State overtime (migration 1384)

The sanctioned way to add California is a canon `xpms.wage_hour_rule` row. Canon is off limits to this work: ADR 0002 says the xpms schema is populated only by the importer and read-only, ADR 0004 gives `canon/` to its owner, and the Bible's jurisdiction tab declares no US-CA. So state rules live in `private.state_wage_hour_rules`, keyed by ISO 3166-2 subdivision as `private.pay_transparency_rules` (1125) is. California: overtime at 1.5 after 8 hours in a workday and 40 in a workweek and for the first 8 hours of the seventh consecutive day of work in a workweek; double time after 12 hours in a workday and after 8 hours on that seventh day. A project's subdivision is its venue's `subdivision_code`, else the region of its canon jurisdiction. `private.split_work_minutes` applies the state's daily, double-time and seventh-day rules and then the strictest weekly rule; `app.calculate_payroll_run` and the WH-347 both use it. When canon adds a state, the app row is removed in the same release.

## Consequences

- Payroll in California venues now pays daily overtime and double time; runs elsewhere are unchanged (the federal weekly rule alone).
- A covered contractor can issue its weekly certified payroll and keep its OSHA records in XOS, but the WH-347 is complete only with the provider's deductions and net pay, and it must still be signed.
  - _Amended 2026-10-23:_ ADR 0033 decision 54 defers the WH-347 and the OSHA forms past launch. They sit behind the `compliance.us_forms` feature flag, off by default (migration 1593), until counsel answers the open questions below; while it is off, Atlas offers neither and the database refuses their writes.
- The OSHA forms are the 2004 revision. Electronic submission through OSHA's Injury Tracking Application has its own file layout, which this does not produce.

## Open questions for the owner and counsel

1. Confirm the California row (`counsel_reviewed_on` is empty). Alternative workweek schedules (section 511), collective bargaining exemptions (section 514), exempt employees and industry wage order variations are not modeled.
2. Whether the WH-347 should take deductions and net pay from the payroll provider's export when one is connected.
3. The Spanish Statement of Compliance is a translation for reading; the certification submitted to an agency uses the form's English wording.
4. Whether to produce the OSHA Injury Tracking Application CSV for establishments that must submit electronically.

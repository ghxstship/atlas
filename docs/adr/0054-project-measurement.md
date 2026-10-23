# ADR 0054: Project Measurement Against Gate 1 Objectives

- Status: Proposed
- Date: 2026-10-21
- Decider: A98 (RRR-143), for the orchestrator's review
- Addresses: finding A65-030; Section 4.10 (Sustainability, Gate 8 measurement); canon criteria G1.OBJECTIVES_STATED and G8.MEASUREMENT_REPORTED
- Migrations: 1550 and 1551 (range 1550 to 1559)

## Context

Section 4.10 asks for waste, energy, water and transport figures per project, reported against the Bible sustainability tags, with an unmeasured figure kept NULL and shown as Unmeasured. It also asks for audience, earned media and sentiment figures, entered or imported, measured against the objectives recorded at gate 1. Canon criterion G1.OBJECTIVES_STATED reads "Measurable objectives recorded. Gate 8 measures against these." The A65 trace found no store for any of it (A65-030). The finding suggested taking the metric from `xpms.dim_metric`.

`xpms.dim_metric` (Bible tab 16) holds 39 code-derived and modeled reference values, such as occupant load factors and "Waste lbs per guest per day: 2.4, MODELED". It does not list the figures a project measures, every row must carry a value, and owner decision 25 adds no row to a Bible list.

## Decision

1. **The metric list lives outside canon.** `private.measurement_metrics` defines ten figures in four families: Sustainability (waste generated, waste diverted, energy, water, transport emissions), Audience (attendance, online audience), Earned Media (coverage pieces, reach) and Sentiment (positive share). Each metric names the canon metric that benchmarks it where canon has one (`canon_domain`, `canon_item`, a foreign key to `xpms.dim_metric`): waste and water. Canon is not changed (pgTAP 1550 checks that it still has 39 metrics).
2. **Sustainability tags are a junction.** `private.measurement_metric_tags` links each sustainability metric to the Bible sustainability tags (`xpms.dim_tag`, tab 09) it is reported against, such as REUSABLE and RECYCLABLE for waste diverted. Canon has no element-to-tag rows yet. When it does, the report can count tagged elements beside each figure.
3. **Units convert exactly within a dimension.** `private.measurement_units` holds exact factors to each dimension's base unit (kg, l, kWh, kg CO2e, count, percent), such as 0.45359237 kg per pound. It also holds the unit each dimension is shown in for metric and imperial readers. The summary computes in base units with `numeric`. Pages convert to the person's `locale.units` (read through `@xos/ui/preferences`). Emissions show in kg CO2e for both systems, as greenhouse gas reporting does.
4. **Objectives follow the gate's approval flow.** `app.project_objectives` holds one live target per metric. Evidence writers (`projects.gate.evidence.write`) draft objectives while gate 1 is open. Once `app.pass_gate` passes gate 1, only a holder of `projects.gate.transition` (the gate approver) can set, change or withdraw one. Every change goes to the audit ledger (`install_audit_trail`). The Gates tab records the objectives on G1.OBJECTIVES_STATED as rank 4 evidence, with the URI `urn:xpms:project-objectives:<project id>`. No new capability is needed.
5. **Unmeasured is NULL, and corrections carry a reason.** In `app.project_measurements`, a NULL value records that a figure was not measured. Source is Manual, Import or Integration. `created_by` and `created_at` record who recorded it and when. Days default to today on the project's calendar (`private.project_today`) and are never later. A change of value, unit or day needs `correction_reason`. The guard writes the change to the append-only `app.project_measurement_corrections`, with the figure before and after, and never stores the reason on the row. Withdrawals and restores go to the same ledger.
6. **Earned media figures come from records.** `app.earned_media_items` holds each piece of coverage: outlet, medium, day, link (one live row per link), reach (NULL when unreported) and tone. The coverage count and reach metrics are computed from these rows and cannot be typed in. This follows the Item Catalog's Earned Media & Coverage Report, which asks for coverage that is sourced and dated. A media equivalency value is not stored. The catalog says it is modeled and must not be presented as revenue.
7. **The summary decides an objective only when missing figures cannot change it.** `app.project_measurement_summary` totals measured figures (Sum) or takes the latest measured one (Latest), with the unmeasured count beside it. With nothing measured, the total is NULL. The outcome is:
   - **Met:** for At Least, the measured total already reaches the target; for At Most, it stays within the target and nothing is unmeasured.
   - **Not Met:** for At Most, the measured total already passes the target; for At Least, it falls short and nothing is unmeasured.
   - **Incomplete:** in every other case with unmeasured figures.
   - **Unmeasured:** nothing was measured.
8. **Reports sit in the Reports module.** `reports.measurement` is a new sitemap page at `/{org}/reports/measurement`. With `?project=` it shows one project. Without it, it shows the org rollup: outcomes per project, and per metric the total (or the mean for sentiment) across the projects that measured it. It is listed among the project Reports tab's built-in reports. The gate 8 review is the Gates tab's gate 8 section. Export uses the reports' CSV export (`ExportCsvButton`) and needs `reports.report.export`.
9. **Reference lists are owner-rights views.** `app.measurement_metrics`, `app.measurement_units` and `app.measurement_metric_tags` read their private tables in the same way as `app.currencies`. They join the reviewed allowlist in pgTAP 9900.

## Consequences

- Eight additive API v1 resources in the Projects module serve the same data, with the correction reason write-only. No frozen operation changes.
- Ticketing attendance imports (0636) show beside the attendance figure as a reference. They are not copied into it, so one attendance figure is never counted twice.
- Adding a metric or unit is a migration that inserts rows. Reports and the API pick it up without code changes, apart from its label in the message catalogs.

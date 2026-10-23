/**
 * OWASP ZAP baseline verdict (Section 9 testing: DAST against staging).
 *
 * `zap-baseline.py` spiders a site and runs ZAP's passive rules. Its rules file
 * (`infra/security/zap/baseline-rules.tsv`, ZAP's own `-c` format) sets an action per rule id:
 *
 * - `IGNORE`: an accepted alert; the line says why. Never fails.
 * - `FAIL`: a protection the apps guarantee (security headers, cookie flags); any alert fails.
 * - `WARN` or no line: reported.
 *
 * On top of ZAP's own handling, any High risk alert fails unless its rule is ignored, so a new High rule in a
 * later ZAP release blocks without a line in the file. Alerts ZAP marks as false positives (confidence 0) are
 * dropped.
 */

export type ZapAction = "IGNORE" | "WARN" | "FAIL" | "INFO" | "OUTOFSCOPE";

export interface ZapRule {
  readonly id: string;
  readonly action: ZapAction;
  readonly name: string;
  readonly note: string;
}

const ACTIONS: readonly ZapAction[] = ["IGNORE", "WARN", "FAIL", "INFO", "OUTOFSCOPE"];

/** Parses ZAP's tab-separated rules file: `id<TAB>ACTION<TAB>(name)<TAB>note`. Lines starting with # are comments. */
export function parseZapRules(text: string): Map<string, ZapRule> {
  const rules = new Map<string, ZapRule>();
  text.split("\n").forEach((raw, index) => {
    const line = raw.replace(/\r$/, "");
    if (line.trim() === "" || line.trimStart().startsWith("#")) return;
    const [id = "", action = "", name = "", ...rest] = line.split("\t");
    if (!/^\d+$/.test(id.trim()))
      throw new Error(`line ${index + 1}: rule id "${id}" is not a number`);
    const upper = action.trim().toUpperCase() as ZapAction;
    if (!ACTIONS.includes(upper)) throw new Error(`line ${index + 1}: unknown action "${action}"`);
    const note = rest.join("\t").trim();
    if (upper === "IGNORE" && note.length < 20) {
      throw new Error(`line ${index + 1}: rule ${id} is ignored without a reason after the name`);
    }
    if (rules.has(id.trim())) throw new Error(`line ${index + 1}: rule ${id} is listed twice`);
    rules.set(id.trim(), {
      id: id.trim(),
      action: upper,
      name: name.trim().replace(/^\(|\)$/g, ""),
      note,
    });
  });
  return rules;
}

/** The parts of ZAP's traditional JSON report (`-J`) the verdict reads. */
export interface ZapReport {
  readonly site?: readonly {
    readonly "@name"?: string;
    readonly alerts?: readonly {
      readonly pluginid: string;
      readonly alert?: string;
      readonly name?: string;
      readonly riskcode: string;
      readonly confidence?: string;
      readonly count?: string;
      readonly instances?: readonly { readonly uri?: string }[];
    }[];
  }[];
}

export const RISKS = ["Informational", "Low", "Medium", "High"] as const;
export type Risk = (typeof RISKS)[number];

export interface ZapAlert {
  readonly site: string;
  readonly pluginId: string;
  readonly name: string;
  readonly risk: Risk;
  readonly count: number;
  readonly example: string;
  readonly note: string;
}

export interface ZapVerdict {
  readonly failures: readonly ZapAlert[];
  readonly warnings: readonly ZapAlert[];
  readonly ignored: readonly ZapAlert[];
}

export function evaluateZap(report: ZapReport, rules: ReadonlyMap<string, ZapRule>): ZapVerdict {
  const failures: ZapAlert[] = [];
  const warnings: ZapAlert[] = [];
  const ignored: ZapAlert[] = [];
  for (const site of report.site ?? []) {
    for (const raw of site.alerts ?? []) {
      if (raw.confidence === "0") continue;
      const risk = RISKS[Number(raw.riskcode)] ?? "High";
      const rule = rules.get(raw.pluginid);
      const alert: ZapAlert = {
        site: site["@name"] ?? "",
        pluginId: raw.pluginid,
        name: raw.name ?? raw.alert ?? rule?.name ?? raw.pluginid,
        risk,
        count: Number(raw.count ?? raw.instances?.length ?? 1),
        example: raw.instances?.[0]?.uri ?? "",
        note: rule?.note ?? "",
      };
      const action = rule?.action ?? "WARN";
      if (action === "IGNORE" || action === "OUTOFSCOPE") ignored.push(alert);
      else if (action === "FAIL" || risk === "High") failures.push(alert);
      else if (action === "WARN" || risk !== "Informational") warnings.push(alert);
    }
  }
  return { failures, warnings, ignored };
}

export function zapSummary(target: string, verdict: ZapVerdict): string {
  const rows = (alerts: readonly ZapAlert[], withNote: boolean) => [
    withNote
      ? "| Rule | Alert | Risk | Count | Why accepted |"
      : "| Rule | Alert | Risk | Count | Example |",
    "| --- | --- | --- | --- | --- |",
    ...alerts.map(
      (a) =>
        `| ${a.pluginId} | ${a.name.replaceAll("|", "\\|")} | ${a.risk} | ${a.count} | ${(withNote ? a.note : a.example).replaceAll("|", "\\|")} |`,
    ),
    "",
  ];
  return [
    `## ZAP baseline for ${target}: ${verdict.failures.length === 0 ? "passed" : "failed"}`,
    "",
    ...(verdict.failures.length > 0 ? ["### Failing", "", ...rows(verdict.failures, false)] : []),
    ...(verdict.warnings.length > 0 ? ["### Warnings", "", ...rows(verdict.warnings, false)] : []),
    ...(verdict.ignored.length > 0
      ? [
          "### Accepted in infra/security/zap/baseline-rules.tsv",
          "",
          ...rows(verdict.ignored, true),
        ]
      : []),
  ].join("\n");
}

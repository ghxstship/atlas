/**
 * Progressive delivery commands (runbook: infra/runbooks/progressive-delivery.md).
 *
 *   gate <metrics.json>                Decide promote, hold or rollback for a deployment stage.
 *                                      Exits 0 promote, 3 hold, 4 rollback.
 *   flag-stage <flag> <percent>        Print SQL that grows a flag rollout to percent.
 *   flag-rollback <flag>               Print SQL that removes the rollout overrides.
 *   flag-complete <flag>               Print SQL that turns the flag on by default.
 *   flag-kill <flag> on|off            Print SQL for the kill switch.
 *   flag-cohorts <flag>                Print SQL that counts the orgs in each stage.
 *
 * The flag commands only print SQL; an operator runs it with the service role.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  cohortSizeSql,
  completeRolloutSql,
  killSwitchSql,
  rollbackRolloutSql,
  stageRolloutSql,
} from "./flag-rollout.ts";
import { decideStage, type GateInput, type GatePolicy } from "./release-gate.ts";

const [command, a, b] = process.argv.slice(2);
const policy = JSON.parse(
  readFileSync(fileURLToPath(new URL("../rollout.json", import.meta.url)), "utf8"),
) as GatePolicy;

const usage = () => {
  console.error(
    "Usage: gate <metrics.json> | flag-stage <flag> <percent> | flag-rollback <flag> | flag-complete <flag> | flag-kill <flag> on|off | flag-cohorts <flag>",
  );
  process.exit(2);
};

switch (command) {
  case "gate": {
    if (!a) usage();
    const input = JSON.parse(readFileSync(a as string, "utf8")) as GateInput;
    const decision = decideStage(policy, input);
    console.log(JSON.stringify(decision));
    process.exit(decision.action === "promote" ? 0 : decision.action === "hold" ? 3 : 4);
    break;
  }
  case "flag-stage":
    if (!a || !b) usage();
    process.stdout.write(stageRolloutSql(a as string, Number(b)));
    break;
  case "flag-rollback":
    if (!a) usage();
    process.stdout.write(rollbackRolloutSql(a as string));
    break;
  case "flag-complete":
    if (!a) usage();
    process.stdout.write(completeRolloutSql(a as string));
    break;
  case "flag-kill":
    if (!a || (b !== "on" && b !== "off")) usage();
    process.stdout.write(killSwitchSql(a as string, b === "on"));
    break;
  case "flag-cohorts":
    if (!a) usage();
    process.stdout.write(
      cohortSizeSql(
        a as string,
        policy.stages.filter((s) => s.percent < 100).map((s) => s.percent),
      ),
    );
    break;
  default:
    usage();
}

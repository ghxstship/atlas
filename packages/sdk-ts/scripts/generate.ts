/**
 * `pnpm --filter @ghxstship/xos-sdk generate [--target ts|python|all] [--check]`
 *
 * Without `--check`, writes the generated SDK sources. With `--check`, writes nothing and
 * exits 1 when any generated file differs from a fresh generation.
 */
import { parseArgs } from "node:util";
import type { Target } from "../codegen/index.ts";
import { generate } from "../codegen/index.ts";

const { values } = parseArgs({
  options: {
    target: { type: "string", default: "all" },
    check: { type: "boolean", default: false },
  },
});

const targets: Target[] =
  values.target === "all"
    ? ["ts", "python"]
    : values.target === "ts" || values.target === "python"
      ? [values.target]
      : [];
if (targets.length === 0) {
  console.error(`Unknown --target ${values.target}; use ts, python or all.`);
  process.exit(2);
}

const results = await generate(targets, { check: values.check });
let failed = false;
for (const r of results) {
  if (values.check && r.drift.length > 0) {
    failed = true;
    console.error(`The ${r.target} SDK is out of date with packages/api/openapi/v1.json:`);
    for (const f of r.drift) console.error(`  ${f}`);
  } else {
    console.log(
      `${r.target} SDK: ${r.files.length} files ${values.check ? "up to date" : "written"}.`,
    );
  }
}
if (failed) {
  console.error("Run `pnpm --filter @ghxstship/xos-sdk generate` and commit the result.");
  process.exit(1);
}

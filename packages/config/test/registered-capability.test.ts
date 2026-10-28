import { RuleTester } from "eslint";
import tseslint from "typescript-eslint";
import { describe, it } from "vitest";
import { registeredCapability } from "../eslint/registered-capability.mjs";

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const tester = new RuleTester({
  languageOptions: {
    parser: tseslint.parser,
    parserOptions: { ecmaFeatures: { jsx: true } },
  },
});

const options = [
  { codes: ["work.record.read", "work.record.write", "org.members.manage", "projects.gate.read"] },
];
const unknown = (code: string) => ({ messageId: "unknown", data: { code } });

// S3.15-10: a capability a check names must exist in packages/schemas/capabilities.yaml.
tester.run("xos/registered-capability", registeredCapability, {
  valid: [
    { code: `ctx.capabilities.has("work.record.read");`, options },
    { code: `access.can(projectId, "work.record.write");`, options },
    {
      code: `const ok = caps.has(next === "Sent" ? "work.record.write" : "work.record.read");`,
      options,
    },
    { code: `const SUPERVISOR_CAPABILITIES = ["org.members.manage"];`, options },
    { code: `const x = { capability: "projects.gate.read" };`, options },
    { code: `const el = <RefusalPanel capability="work.record.read" />;`, options },
    {
      code: `const RESOURCE_CAPABILITIES = { records: rw("work.record.read", "work.record.write") };`,
      options,
    },
    // Catalog keys and other dotted strings outside a capability position are not codes.
    { code: `t("advancing.packets.create");`, options },
    { code: `const labels = { title: "work.record.title" };`, options },
    // An object under a capability-named property is something else: here, catalog keys.
    {
      code: `const DENIAL_KEYS = { capability: { title: "compass.denial.capability" } };`,
      options,
    },
    // Not shaped like a code.
    { code: `ctx.capabilities.has("admin");`, options },
    { code: `params.has("peek");`, options },
    // A template with a substitution cannot be checked.
    { code: "ctx.capabilities.has(`${module}.record.read`);", options },
    // A type position is not a check.
    { code: `type Feature = "scan.credential.validate";`, options },
    // Function bodies stop the search: the callback's return is not the capability argument.
    { code: `caps.has(pick(() => "work.recrd.read"));`, options },
    // Keys of a capability map are features, not codes.
    {
      code: `const INTERNAL_CAPABILITY = { "scan.credential.validate": "work.record.write" };`,
      options,
    },
  ],
  invalid: [
    {
      code: `ctx.capabilities.has("work.record.reed");`,
      options,
      errors: [unknown("work.record.reed")],
    },
    {
      code: `access.can(projectId, "wrok.record.write");`,
      options,
      errors: [unknown("wrok.record.write")],
    },
    {
      code: `crew.canAll("work.timesheet.approve");`,
      options,
      errors: [unknown("work.timesheet.approve")],
    },
    {
      code: `const ok = caps.has(next === "Sent" ? "work.record.send" : "work.record.read");`,
      options,
      errors: [unknown("work.record.send")],
    },
    {
      code: `requireCapability(ctx, "org.members.invite");`,
      options,
      errors: [unknown("org.members.invite")],
    },
    {
      code: `const SUPERVISOR_CAPABILITIES = ["org.members.manage", "crew.shift.write"];`,
      options,
      errors: [unknown("crew.shift.write")],
    },
    {
      code: `const routes = { Weather: { route: "/weather", capability: "safety.incident.write" } };`,
      options,
      errors: [unknown("safety.incident.write")],
    },
    {
      code: `const el = <RefusalPanel capability="work.record.delete" />;`,
      options,
      errors: [unknown("work.record.delete")],
    },
    {
      code: `const el = <Page refusal={"work.record.archive"} />;`,
      options,
      errors: [unknown("work.record.archive")],
    },
    {
      code: `const RESOURCE_CAPABILITIES = { records: rw("work.record.read", "work.record.write", { actions: { close: "work.record.close" } }) };`,
      options,
      errors: [unknown("work.record.close")],
    },
    {
      code: "ctx.capabilities.has(`work.record.reed`);",
      options,
      errors: [unknown("work.record.reed")],
    },
    {
      code: `this.capability = "work.record.reed";`,
      options,
      errors: [unknown("work.record.reed")],
    },
    {
      code: `class Guard { requiredCapability = "work.record.reed"; }`,
      options,
      errors: [unknown("work.record.reed")],
    },
    {
      code: `const writes = writableProjects(scope, "work.record.wirte" as const);`,
      options,
      errors: [unknown("work.record.wirte")],
    },
    {
      code: `caps.has("work.record.reed");`,
      options: [{ codes: ["work.record.read"], callees: ["has"] }],
      errors: [unknown("work.record.reed")],
    },
  ],
});

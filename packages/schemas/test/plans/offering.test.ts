import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  PLANS_YAML_PATH,
  PLAN_OFFERING,
  PLAN_OFFERING_JSON,
  PLAN_OFFERING_MODULE,
  PLAN_SEED_MIGRATION,
  PlanRegistryError,
  addonOffering,
  addonOnSale,
  extraSeatsOnSale,
  isPlanFeatureOffered,
  loadPlanRegistry,
  offeredPlanFeatures,
  openTerritoryCodes,
  parsePlanRegistry,
  planFeatureOffering,
  renderPlanOfferingJson,
  renderPlanOfferingModule,
  type OfferingBasis,
  type PlanOffering,
} from "../../src/plans/index.ts";

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const packageRoot = fileURLToPath(new URL("../../", import.meta.url));
const read = (path: string) => readFileSync(`${repoRoot}${path}`, "utf8");
const yamlText = readFileSync(PLANS_YAML_PATH, "utf8");
const registry = loadPlanRegistry();
const offering = registry.offering;

/** Every status that withholds something, with where it is stated and what it rests on. */
const withheld: [string, readonly OfferingBasis[]][] = [
  ...Object.entries(offering.features)
    .filter(([, f]) => f.status !== "offered")
    .map(([code, f]): [string, readonly OfferingBasis[]] => [`feature ${code}`, f.basis]),
  ...(offering.extraSeats.status === "on_sale"
    ? []
    : [["extra seats", offering.extraSeats.basis] as [string, readonly OfferingBasis[]]]),
  ...Object.entries(offering.addons)
    .filter(([, a]) => a.status !== "on_sale")
    .map(([code, a]): [string, readonly OfferingBasis[]] => [`add-on ${code}`, a.basis]),
];

describe("the offering section of plans.yaml", () => {
  it("states every feature, in registry order, and every add-on", () => {
    expect(Object.keys(offering.features)).toEqual([...registry.features]);
    expect(Object.keys(offering.addons)).toEqual(registry.addons.map((a) => a.code));
  });

  it("states what is offered and on sale at this release", () => {
    const byStatus = (status: string) =>
      Object.entries(offering.features)
        .filter(([, f]) => f.status === status)
        .map(([code]) => code);
    expect(byStatus("not_offered")).toEqual(["branded_compass_build", "legend_early_access"]);
    expect(byStatus("territory")).toEqual(["eu_data_residency"]);
    expect(offering.features["eu_data_residency"]?.territory).toBe("EEA");
    expect(byStatus("offered")).toHaveLength(registry.features.length - 3);
    expect(offering.extraSeats.status).toBe("not_on_sale");
    expect(offering.addons["aurora_requests_1000"]?.status).toBe("not_on_sale");
  });

  it("changes no entitlement and no price", () => {
    const enterprise = registry.plans.find((p) => p.code === "enterprise");
    expect(enterprise?.features).toEqual(registry.features);
    expect(registry.plans.filter((p) => p.extraSeat !== null).map((p) => p.code)).toEqual([
      "core",
      "pro",
      "team",
    ]);
    expect(registry.addons.map((a) => a.prices.USD)).toEqual([4900]);
  });

  it("matches the generated module, so code that reads no file reads the same statuses", () => {
    expect(PLAN_OFFERING).toEqual(offering);
    const committed = readFileSync(`${packageRoot}${PLAN_OFFERING_MODULE}`, "utf8");
    const rendered = renderPlanOfferingModule(registry);
    expect(committed.split("\n").slice(0, 3)).toEqual(rendered.split("\n").slice(0, 3));
    expect(rendered).toContain(JSON.stringify(offering, null, 2));
  });

  it("ships as JSON beside the module, readable with no loader and equal to plans.yaml (issue 125)", () => {
    const committed = readFileSync(`${packageRoot}${PLAN_OFFERING_JSON}`, "utf8");
    expect(JSON.parse(committed)).toEqual(offering);
    expect(JSON.parse(renderPlanOfferingJson(registry))).toEqual(offering);
    const manifest = JSON.parse(readFileSync(`${packageRoot}package.json`, "utf8")) as {
      exports: Record<string, string>;
    };
    expect(manifest.exports["./plans/offering.json"]).toBe(`./${PLAN_OFFERING_JSON}`);
    // Plain Node, with no TypeScript loader and no flag, reads the file through the package export.
    const printed = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        'import { createRequire } from "node:module"; const o = createRequire(import.meta.url)("@xos/schemas/plans/offering.json"); console.log(JSON.stringify([o.openTerritories, o.features.eu_data_residency.status, o.extraSeats.status]));',
      ],
      { cwd: packageRoot, encoding: "utf8" },
    );
    expect(JSON.parse(printed)).toEqual([["US"], "territory", "not_on_sale"]);
  });

  it("lists the open territories as the migrations seed them (ADR 0160, issue 125)", () => {
    const seeded = readdirSync(`${repoRoot}supabase/migrations`)
      .filter((file) => file.endsWith(".sql"))
      .sort()
      .flatMap((file) => {
        const text = read(`supabase/migrations/${file}`);
        const inserts = text.matchAll(
          /^insert into private\.territories \(code, name_en, name_es, offered, change_reason\) values\n([\s\S]*?);$/gm,
        );
        return [...inserts].flatMap((insert) =>
          [
            ...(insert[1] ?? "").matchAll(/^\s*\('([A-Z0-9]+)', '.*?', '.*?', (true|false), /gm),
          ].map((row): [string, boolean] => [row[1] ?? "", row[2] === "true"]),
        );
      });
    expect(seeded.length).toBeGreaterThan(1);
    expect(offering.openTerritories).toEqual(
      seeded.filter(([, open]) => open).map(([code]) => code),
    );
    expect(openTerritoryCodes()).toEqual(["US"]);
    // No migration opens or closes a territory outside the seed and the console functions.
    const statements = readdirSync(`${repoRoot}supabase/migrations`)
      .map((file) => read(`supabase/migrations/${file}`))
      .join("\n")
      .match(/^update private\.territories\b/gm);
    expect(statements).toBeNull();
    // Every territory a feature is offered in is one the database knows.
    const known = seeded.map(([code]) => code);
    for (const feature of Object.values(offering.features)) {
      if (feature.territory !== null) expect(known).toContain(feature.territory);
    }
    // The pgTAP file of the current plan seed holds the database to the same list.
    expect(
      read(PLAN_SEED_MIGRATION.replace("/migrations/", "/tests/").replace(/\.sql$/, ".test.sql")),
    ).toContain(`$$values ${offering.openTerritories.map((code) => `('${code}')`).join(", ")}$$`);
  });

  it("puts support session controls on the plan that first includes them, the free plan (issue 125)", () => {
    expect(registry.plans.map((p) => p.features.includes("support_session_controls"))).toEqual(
      registry.plans.map(() => true),
    );
    expect(registry.plans[0]?.free).toBe(true);
    expect(registry.plans[0]?.features).toEqual(["support_session_controls"]);
    // Each plan above lists only what it adds, so the code appears once in the plan lists of the file.
    expect(yamlText.match(/^ +(?:features: )?\[.*\bsupport_session_controls\b.*\]$/gm)).toEqual([
      "    features: [support_session_controls]",
    ]);
    expect(offering.features["support_session_controls"]?.status).toBe("offered");
  });

  it("explains each status in a comment block at the top of the section", () => {
    const comment = yamlText.slice(
      yamlText.indexOf("# What is offered and on sale today"),
      yamlText.indexOf("\noffering:\n"),
    );
    for (const status of ["offered", "not_offered", "territory", "on_sale", "not_on_sale"]) {
      expect(comment).toMatch(new RegExp(`#\\s+status: ${status}\\s`));
    }
    expect(comment).toContain("basis:");
  });

  it("promises nothing by contract that the registry rules out", () => {
    const comment = yamlText
      .slice(
        yamlText.indexOf("# What is offered and on sale today"),
        yamlText.indexOf("\noffering:\n"),
      )
      .replace(/\n#\s*/g, " ");
    // Terms of Service, 5.3: "or an Order offers them". An Order can include an item only on a plan that prices it.
    expect(comment).toContain(
      "An Order may still include it by contract, on the plans that price it.",
    );
    // A plan sold by quote has unlimited seats and is in no add-on's plans, so the comment never names it.
    const quoted = registry.plans.filter((p) => p.quote !== null);
    expect(quoted.map((p) => p.code)).toEqual(["enterprise"]);
    for (const plan of quoted) {
      expect(plan.limits["seats"]).toBeNull();
      expect(plan.extraSeat).toBeNull();
      expect(registry.addons.filter((a) => a.plans.includes(plan.code))).toEqual([]);
      expect(comment.toLowerCase()).not.toContain(plan.code);
    }
  });
});

describe("offering helpers", () => {
  it("offers a feature by its status, and a territory feature only while its territory is open", () => {
    expect(isPlanFeatureOffered("saml_sso")).toBe(true);
    expect(isPlanFeatureOffered("branded_compass_build")).toBe(false);
    expect(isPlanFeatureOffered("legend_early_access", ["US", "EEA"])).toBe(false);
    expect(isPlanFeatureOffered("eu_data_residency")).toBe(false);
    expect(isPlanFeatureOffered("eu_data_residency", [])).toBe(false);
    expect(isPlanFeatureOffered("eu_data_residency", ["US"])).toBe(false);
    expect(isPlanFeatureOffered("eu_data_residency", ["US", "EEA"])).toBe(true);
  });

  it("never offers a code the registry does not list", () => {
    expect(planFeatureOffering("teleport")).toBeUndefined();
    expect(planFeatureOffering("constructor")).toBeUndefined();
    expect(isPlanFeatureOffered("teleport", ["US", "EEA"])).toBe(false);
    expect(addonOffering("toString")).toBeUndefined();
    expect(addonOnSale("teleport")).toBe(false);
  });

  it("filters a plan's features in the order given", () => {
    const enterprise = registry.plans.find((p) => p.code === "enterprise");
    const shown = offeredPlanFeatures(enterprise?.features ?? []);
    expect(shown).toEqual(
      registry.features.filter(
        (f) => !["eu_data_residency", "branded_compass_build", "legend_early_access"].includes(f),
      ),
    );
    expect(offeredPlanFeatures(["eu_data_residency", "scim"], ["EEA"])).toEqual([
      "eu_data_residency",
      "scim",
    ]);
  });

  it("reads the sale statuses, and another offering when one is given", () => {
    expect(extraSeatsOnSale()).toBe(false);
    expect(addonOnSale("aurora_requests_1000")).toBe(false);
    const open: PlanOffering = {
      openTerritories: ["EEA"],
      features: {
        scim: { status: "territory", territory: null, basis: [] },
        eu_data_residency: { status: "territory", territory: "EEA", basis: [] },
      },
      extraSeats: { status: "on_sale", basis: [] },
      addons: { aurora_requests_1000: { status: "on_sale", basis: [] } },
    };
    expect(extraSeatsOnSale(open)).toBe(true);
    expect(addonOnSale("aurora_requests_1000", open)).toBe(true);
    expect(isPlanFeatureOffered("scim", ["EEA"], open)).toBe(false);
    // With no territories passed, the offering's own open territories decide; passed ones replace them.
    expect(openTerritoryCodes(open)).toEqual(["EEA"]);
    expect(isPlanFeatureOffered("eu_data_residency", undefined, open)).toBe(true);
    expect(offeredPlanFeatures(["eu_data_residency"], undefined, open)).toEqual([
      "eu_data_residency",
    ]);
    expect(isPlanFeatureOffered("eu_data_residency", ["US"], open)).toBe(false);
  });
});

describe("offering validation", () => {
  const broken = (from: string, to: string) => {
    expect(yamlText).toContain(from);
    return () => parsePlanRegistry(yamlText.replace(from, to));
  };
  const legendBasis =
    "      basis:\n        - file: docs/adr/0020-plan-packaging.md\n          text: No Legend surface is shipped or advertised as available.\n        - file: design/MARKETING_LOCKSTEP.md\n          text: Legend is not shipped.\n";

  it("rejects a registry with no offering section", () => {
    const from = yamlText.indexOf("\noffering:\n");
    const to = yamlText.indexOf("\nplans:\n");
    expect(() => parsePlanRegistry(yamlText.slice(0, from) + yamlText.slice(to))).toThrow(
      PlanRegistryError,
    );
  });

  it.each([
    ["a missing feature", "    scim: { status: offered }\n", "", /exactly the features, in order/],
    [
      "an unknown feature",
      "    scim: { status: offered }\n",
      "    scim: { status: offered }\n    teleport: { status: offered }\n",
      /exactly the features, in order/,
    ],
    [
      "features out of order",
      "    saml_sso: { status: offered }\n    scim: { status: offered }\n",
      "    scim: { status: offered }\n    saml_sso: { status: offered }\n",
      /exactly the features, in order/,
    ],
    ["an unknown status", "    scim: { status: offered }", "    scim: { status: soon }", /status/],
    ["no list of open territories", "  open_territories: [US]\n", "", /open_territories/],
    [
      "an open territory listed twice",
      "  open_territories: [US]\n",
      "  open_territories: [US, US]\n",
      /offering\.open_territories lists a territory twice/,
    ],
    [
      "an open territory that is not a territory code",
      "  open_territories: [US]\n",
      "  open_territories: [us]\n",
      /open_territories/,
    ],
    [
      "a feature withheld with no basis",
      "    scim: { status: offered }",
      "    scim: { status: not_offered }",
      /offering\.features\.scim must cite the text/,
    ],
    [
      "an offered feature that cites a basis",
      `      status: not_offered\n${legendBasis}`,
      `      status: offered\n${legendBasis}`,
      /offering\.features\.legend_early_access withholds nothing/,
    ],
    [
      "a territory status with no territory",
      "      status: territory\n      territory: EEA\n",
      "      status: territory\n",
      /names a territory exactly when/,
    ],
    [
      "a territory on another status",
      "      status: territory\n      territory: EEA\n",
      "      status: not_offered\n      territory: EEA\n",
      /names a territory exactly when/,
    ],
    [
      "a basis outside the repository",
      "file: docs/adr/0020-plan-packaging.md",
      "file: ../0020-plan-packaging.md",
      /offering\.features\.legend_early_access\.basis\.0\.file/,
    ],
    [
      "extra seats withheld with no basis",
      "  extra_seats:\n    status: not_on_sale\n    basis:\n      - file: docs/adr/0035-pricing-v4-seats-and-add-ons.md\n        text: extra seats, Aurora packs and Talk to sales stay as they were\n      - file: legal/terms-of-service.md\n        text: Extra seats and Aurora AI request packs can be bought only where Settings, Billing and Plan or an Order offers them.\n",
      "  extra_seats:\n    status: not_on_sale\n",
      /offering\.extra_seats must cite the text/,
    ],
    [
      "extra seats on sale that still cite a basis",
      "  extra_seats:\n    status: not_on_sale\n",
      "  extra_seats:\n    status: on_sale\n",
      /offering\.extra_seats withholds nothing/,
    ],
    [
      "an add-on the section does not state",
      "    aurora_requests_1000:\n      status: not_on_sale\n",
      "    aurora_requests_2000:\n      status: not_on_sale\n",
      /exactly the add-ons, in order/,
    ],
    [
      "an add-on on sale that still cites a basis",
      "    aurora_requests_1000:\n      status: not_on_sale\n",
      "    aurora_requests_1000:\n      status: on_sale\n",
      /offering\.addons\.aurora_requests_1000 withholds nothing/,
    ],
  ])("rejects %s", (_label, from, to, message) => {
    expect(broken(from, to)).toThrow(message);
  });
});

/**
 * The status and the text it rests on change together. Each direction has its own test: a withheld status whose
 * quote left its file fails the first, and a file that still says a thing is withheld while plans.yaml offers it
 * fails the second.
 */
describe("the offering and the legal and ADR text", () => {
  it.each(withheld)("%s rests on text its files still hold", (_label, basis) => {
    expect(basis.length).toBeGreaterThan(0);
    for (const { file, text } of basis) {
      expect(existsSync(`${repoRoot}${file}`), `${file} exists`).toBe(true);
      expect(read(file), `${file} holds the quoted sentence`).toContain(text);
    }
  });

  /** Sentences that withhold something, and the status each one requires while it stands. */
  const statements: {
    file: string;
    text: string;
    holds: () => boolean;
    requires: string;
  }[] = [
    {
      file: "legal/terms-of-service.md",
      text: "A dedicated branded Compass build is not offered at launch",
      holds: () => offering.features["branded_compass_build"]?.status === "not_offered",
      requires: "branded_compass_build not_offered",
    },
    {
      file: "docs/adr/0020-plan-packaging.md",
      text: "No Legend surface is shipped or advertised as available.",
      holds: () => offering.features["legend_early_access"]?.status === "not_offered",
      requires: "legend_early_access not_offered",
    },
    {
      file: "design/MARKETING_LOCKSTEP.md",
      text: "Legend is not shipped.",
      holds: () => offering.features["legend_early_access"]?.status === "not_offered",
      requires: "legend_early_access not_offered",
    },
    {
      file: "legal/terms-of-service.md",
      text: "An EU region is not offered.",
      holds: () => offering.features["eu_data_residency"]?.status !== "offered",
      requires: "eu_data_residency territory or not_offered",
    },
    {
      file: "docs/adr/0160-offered-territories-united-states-launch.md",
      text: '"EU data residency" leaves the plan list',
      holds: () =>
        offering.features["eu_data_residency"]?.status === "territory" &&
        offering.features["eu_data_residency"].territory === "EEA",
      requires: "eu_data_residency territory EEA",
    },
    {
      file: "docs/adr/0035-pricing-v4-seats-and-add-ons.md",
      text: "extra seats, Aurora packs and Talk to sales stay as they were",
      holds: () =>
        offering.extraSeats.status === "not_on_sale" &&
        offering.addons["aurora_requests_1000"]?.status === "not_on_sale",
      requires: "extra seats and aurora_requests_1000 not_on_sale",
    },
  ];

  it.each(statements)("while $file says so, plans.yaml states $requires", (statement) => {
    if (read(statement.file).includes(statement.text)) {
      expect(statement.holds(), statement.requires).toBe(true);
    }
  });

  it("names every sentence the withheld statuses cite, so none is tied in one direction only", () => {
    const tied = new Set(statements.map((s) => `${s.file}\n${s.text}`));
    const cited = withheld.flatMap(([, basis]) => basis.map((b) => `${b.file}\n${b.text}`));
    const general =
      "legal/terms-of-service.md\nExtra seats and Aurora AI request packs can be bought only where Settings, Billing and Plan or an Order offers them.";
    expect(cited.filter((c) => !tied.has(c) && c !== general)).toEqual([]);
  });

  it("keeps the Terms' Enterprise summary to features that are offered", () => {
    const row = read("legal/terms-of-service.md")
      .split("\n")
      .find((line) => line.startsWith("| Enterprise"));
    expect(row).toBeDefined();
    expect(row).toContain("SAML single sign-on, SCIM, Service Level Agreement credits");
    expect(row).not.toMatch(/Legend|EU data residency|EU region/);
  });
});

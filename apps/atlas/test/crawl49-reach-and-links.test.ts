import { getMessages } from "@xos/i18n";
import { describe, expect, it } from "vitest";
import { controlCapabilities } from "@/components/places/kit/access";
import { chosenProject } from "@/components/workforce/shared";
import { assetCapabilities, withProjectReach } from "@/lib/assets/context";
import { termsLabel, termsOptionsByRole, termsValue } from "@/lib/people/requisition-terms";
import { initialProjectId, projectChoiceOptions } from "@/lib/projects/project-choice";
import type { OrgContext } from "@/lib/shell/context";
import { pageEmptyState, visibleNodeHref } from "@/lib/shell/sitemap";

/** A catalog lookup over one locale's messages, as next-intl reads them, with ICU arguments filled plainly. */
function translator(locale: "en-US" | "es-US") {
  const messages = getMessages(locale) as unknown as Record<string, unknown>;
  return (key: string, values: Record<string, string | number> = {}) => {
    const found = key
      .split(".")
      .reduce<unknown>(
        (node, part) => (node as Record<string, unknown> | undefined)?.[part],
        messages,
      );
    if (typeof found !== "string") return key;
    return found.replace(/\{(\w+)\}/g, (_, name: string) => String(values[name] ?? `{${name}}`));
  };
}

const nav = (role: "owner" | "admin" | "manager" | "member" | "field") => ({
  role,
  conditions: [],
  disabledModules: [],
});

describe("project pickers start on no project of several (crawl 4.9)", () => {
  const projects = [
    { id: "p1", key: "CPSYP", name: "Crawl Links" },
    { id: "p2", key: "NWS", name: "Northwind Summer" },
  ];

  it("asks the person to choose instead of preselecting the first project", () => {
    expect(initialProjectId(projects)).toBe("");
    expect(initialProjectId(projects, "p2")).toBe("p2");
    expect(initialProjectId(projects, "gone")).toBe("");
    expect(initialProjectId(projects.slice(0, 1))).toBe("p1");
    const options = projectChoiceOptions(
      projects.map((p) => ({ value: p.id, label: p.key })),
      "Choose a project",
    );
    expect(options[0]).toEqual({ value: "", label: "Choose a project" });
    expect(projectChoiceOptions([{ value: "p1", label: "CPSYP" }], "Choose a project")).toEqual([
      { value: "p1", label: "CPSYP" },
    ]);
  });

  it("chooses a site operations project by id or key, and none of several by default", () => {
    const summaries = projects.map((p) => ({ ...p })) as never[];
    expect(chosenProject(summaries, {})).toBeNull();
    expect(chosenProject(summaries, { project: "p2" })).toMatchObject({ key: "NWS" });
    expect(chosenProject(summaries, { project: "NWS" })).toMatchObject({ id: "p2" });
    expect(chosenProject(summaries, { project: "nope" })).toBeNull();
    expect(chosenProject(summaries.slice(0, 1), {})).toMatchObject({ key: "CPSYP" });
  });

  it("has the choose copy in both locales", () => {
    for (const locale of ["en-US", "es-US"] as const) {
      const t = translator(locale);
      for (const key of [
        "shell.create.chooseProject",
        "workforce.site.chooseProject",
        "workforce.site.choosePrompt",
      ]) {
        expect(t(key), `${locale} ${key}`).not.toBe(key);
      }
    }
  });
});

describe("asset custody and damage follow the unit's project (crawl 4.9)", () => {
  const ctx = (codes: string[]) => ({ capabilities: new Set(codes) }) as unknown as OrgContext;

  it("adds the custody and damage writes held on the project to the org-wide flags", () => {
    const field = assetCapabilities(ctx([]));
    expect(field).toMatchObject({ custody: false, damage: false });
    const onProject = withProjectReach(
      field,
      new Set(["assets.custody.write", "assets.damage.write"]),
    );
    expect(onProject).toEqual({
      write: false,
      custody: true,
      damage: true,
      maintenance: false,
      writeOff: false,
    });
    expect(withProjectReach(field, new Set())).toEqual(field);
    const producer = assetCapabilities(ctx(["assets.custody.write", "assets.damage.write"]));
    expect(withProjectReach(producer, new Set())).toMatchObject({ custody: true, damage: true });
  });
});

describe("links lead only to pages the viewer may open (crawl 4.9)", () => {
  const params = { org: "demo-productions", projectKey: "NWS" };

  it("drops Open project settings for roles that cannot open project settings", () => {
    expect(visibleNodeHref("project.settings", params, nav("field"))).toBeUndefined();
    expect(visibleNodeHref("project.settings", params, nav("manager"))).toBe(
      "/demo-productions/p/NWS/settings",
    );
  });

  it("drops Invite people for roles that cannot open Members settings", () => {
    expect(visibleNodeHref("settings.members", params, nav("member"))).toBeUndefined();
    expect(visibleNodeHref("settings.members", params, nav("manager"))).toBeUndefined();
    expect(visibleNodeHref("settings.members", params, nav("admin"))).toBe(
      "/demo-productions/settings/members",
    );
  });
});

describe("a section page whose pages are all hidden says so in words (crawl 4.9)", () => {
  it("gives /settings under the Field lens translated copy and a way Home", () => {
    const empty = pageEmptyState("settings", { org: "demo" }, nav("field"), "Settings");
    expect(empty.copy).toBe("shell.page.noneOpen");
    expect(empty.href).toBe("/demo/home");
    for (const locale of ["en-US", "es-US"] as const) {
      const t = translator(locale);
      const sentence = t(`${empty.copy}.empty`, empty.values);
      expect(sentence).not.toContain("shell.");
      expect(sentence).toContain("Settings");
      expect(t(`${empty.copy}.action`)).not.toContain("shell.");
    }
  });

  it("keeps a leaf page's own copy", () => {
    const empty = pageEmptyState("settings.teams", { org: "demo" }, nav("admin"), "Teams");
    expect(empty.copy).toBe("shell.pages.settings.teams");
  });
});

describe("venue, space and zone writes count only org-wide (crawl 4.9)", () => {
  it("drops the places writes a Field lead holds at assigned reach", () => {
    const held = [
      "places.venue.write",
      "places.space.write",
      "places.venue.read",
      "safety.permit.write",
    ];
    const field = controlCapabilities(held, new Set(["places.venue.read"]));
    expect([...field].sort()).toEqual(["places.venue.read", "safety.permit.write"]);
    const admin = controlCapabilities(held, new Set(held));
    expect([...admin].sort()).toEqual([...held].sort());
  });
});

describe("requisition terms read in words and follow the role (crawl 4.9)", () => {
  const rows = [
    {
      roleCode: "5000.50.02",
      classification: "EMPLOYEE",
      payBasis: "Day Rate",
      arrangement: "Per Engagement",
    },
    {
      roleCode: "5000.50.02",
      classification: "EMPLOYEE",
      payBasis: "Day Rate",
      arrangement: "Per Engagement",
    },
    {
      roleCode: "5000.50.02",
      classification: "INDEPENDENT_CONTRACTOR",
      payBasis: "Flat Fee",
      arrangement: "Retainer",
    },
    {
      roleCode: "5000.51.01",
      classification: "EMPLOYEE",
      payBasis: "Hourly",
      arrangement: "Per Engagement",
    },
  ];

  it("offers each role only its own combinations, once each, in words", () => {
    const t = translator("en-US");
    const byRole = termsOptionsByRole(t, rows);
    expect(byRole["5000.50.02"]).toEqual([
      { value: "EMPLOYEE|Day Rate|Per Engagement", label: "Employee · Day Rate · Per Engagement" },
      {
        value: "INDEPENDENT_CONTRACTOR|Flat Fee|Retainer",
        label: "Independent Contractor · Flat Fee · Retainer",
      },
    ]);
    expect(byRole["5000.51.01"]).toHaveLength(1);
  });

  it("names the held terms in Spanish too, and keeps an unknown canon value as spelled", () => {
    const es = translator("es-US");
    expect(
      termsLabel(es, {
        classification: "INDEPENDENT_CONTRACTOR",
        payBasis: "Hourly",
        arrangement: "Retainer",
      }),
    ).toBe("Contratista independiente · Por hora · Iguala");
    expect(
      termsLabel(translator("en-US"), {
        classification: "EMPLOYEE",
        payBasis: "Weekly",
        arrangement: null,
      }),
    ).toBe("Employee · Weekly · ");
    expect(
      termsValue({ classification: "EMPLOYEE", payBasis: "Hourly", arrangement: "Retainer" }),
    ).toBe("EMPLOYEE|Hourly|Retainer");
  });
});

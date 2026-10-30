import { describe, expect, it, vi } from "vitest";
import { localHashEmbeddings, type EmbeddingProvider } from "@xos/ai/embeddings";
import { SETTINGS } from "@xos/schemas/settings";
import enSettings from "../../../packages/i18n/messages/en-US/settings.json" with { type: "json" };
import enWork from "../../../packages/i18n/messages/en-US/work.json" with { type: "json" };
import esWork from "../../../packages/i18n/messages/es-US/work.json" with { type: "json" };
import enIncidents from "../../../packages/i18n/messages/en-US/incidents.json" with { type: "json" };
import enNav from "../../../packages/i18n/messages/en-US/nav.json" with { type: "json" };
import { parseSearchQuery, searchRequest } from "@xos/data/search-query";
import { isNodeVisible, type NavContext } from "@xos/ia";
import { sitemap } from "../ia/sitemap.generated";
import {
  hiddenInventoryTypes,
  inventoryEntry,
  matchesWords,
  queryVector,
  resolveKinds,
  resolveStatuses,
  settingEntries,
  withHiddenInventory,
} from "../lib/shell/search-index";

/** A87 (RRR-132, finding A65-005): the command menu's server-side index. */

type Tree = { readonly [key: string]: Tree | string };

/** A translator over real catalogs: `work.kinds.Task` reads work.json's kinds.Task. */
function translator(catalogs: Readonly<Record<string, Tree>>) {
  return (key: string) => {
    const [ns = "", ...path] = key.split(".");
    let node: Tree | string | undefined = catalogs[ns];
    for (const part of path) node = typeof node === "object" ? node[part] : undefined;
    return typeof node === "string" ? node : key;
  };
}

const en = translator({
  work: enWork as Tree,
  incidents: enIncidents as Tree,
  settings: enSettings as Tree,
  nav: enNav as Tree,
});
const es = translator({ work: esWork as Tree, incidents: enIncidents as Tree });

describe("matchesWords", () => {
  it("needs every word, ignoring case and accents", () => {
    expect(matchesWords("Zona horaria · Localización", ["zona", "localizacion"])).toBe(true);
    expect(matchesWords("Time zone", ["time", "date"])).toBe(false);
  });
});

describe("resolveKinds and resolveStatuses", () => {
  it("names canon kinds from the canon name, the label in the person's language or its start", () => {
    expect(resolveKinds(["task", "Permit", "insp"], en)).toEqual(["Task", "Permit", "Inspection"]);
    expect(resolveKinds(["tarea"], es)).toEqual(["Task"]);
    expect(resolveKinds(["zz", "spaceship"], en)).toEqual(["zz", "spaceship"]);
  });

  it("names canon states, keeps open and closed, and passes unknown ones through", () => {
    expect(resolveStatuses(["inreview", "open", "closed", "contained"], en)).toEqual([
      "inreview",
      "open",
      "closed",
      "contained",
    ]);
    expect(resolveStatuses(["bloqueado", "nothing"], es)).toEqual(["blocked", "nothing"]);
  });
});

describe("settingEntries (Section 11.11: any setting reached in 1 search)", () => {
  const params = { org: "acme" };

  it("finds the time zone on the org's Localization page and in the person's preferences", () => {
    const found = settingEntries({
      settings: SETTINGS,
      words: ["time", "zone"],
      sitemap,
      nav: { role: "owner", conditions: ["desktop"] },
      params,
      t: en,
    });
    const timeZone = found.filter((e) => e.key === "locale.time_zone");
    expect(timeZone.map((e) => e.href)).toEqual([
      "/acme/settings/localization?setting=locale.time_zone",
      "/acme/me/preferences?setting=locale.time_zone",
    ]);
    expect(timeZone[0]?.label).toBe(
      `${en("settings.fields.timeZone.label")} · ${en("nav.settings.org.localization")}`,
    );
    expect(timeZone.map((e) => e.icon)).toEqual(["Settings", "UserRound"]);
  });

  it("matches the setting key, offers only pages the viewer can open and never a hidden setting", () => {
    const viewer = settingEntries({
      settings: SETTINGS,
      words: ["locale", "time"],
      sitemap,
      nav: { role: "viewer", conditions: ["desktop"] },
      params,
      t: en,
    });
    expect(viewer.map((e) => e.href)).toEqual(["/acme/me/preferences?setting=locale.time_zone"]);
    const hidden = SETTINGS.find((s) => s.hidden);
    expect(
      settingEntries({
        settings: SETTINGS,
        words: [hidden?.key ?? "numbering"],
        sitemap,
        nav: { role: "owner", conditions: ["desktop"] },
        params,
        t: en,
      }).some((e) => e.key === hidden?.key),
    ).toBe(false);
    expect(
      settingEntries({
        settings: SETTINGS,
        words: [],
        sitemap,
        nav: { role: "owner" },
        params,
        t: en,
      }),
    ).toEqual([]);
  });

  it("finds semantic search on AI features and puts labels that start with the word first", () => {
    const found = settingEntries({
      settings: SETTINGS,
      words: ["semantic"],
      sitemap,
      nav: { role: "owner", conditions: ["desktop"] },
      params,
      t: en,
      limit: 3,
    });
    expect(found[0]).toMatchObject({
      key: "search.semantic_enabled",
      href: "/acme/settings/ai-features?setting=search.semantic_enabled",
    });
  });
});

describe("inventory hits (P7)", () => {
  const visibleFor = (nav: NavContext) => (node: string) => isNodeVisible(sitemap, node, nav);
  const owner = visibleFor({ role: "owner", conditions: ["desktop"] });
  const unit = { type: "asset" as const, id: "u1", key: "MH-002", title: "Spot Fixture" };
  const assetClass = {
    type: "asset_class" as const,
    id: "01920000-0000-7000-8000-000000112102",
    key: null,
    title: "Digital Two-Way Radio",
  };

  it("opens a unit in the units peek by its encoded tag, with the tag as its code", () => {
    expect(inventoryEntry(unit, { org: "acme", visible: owner, noun: "Asset" })).toEqual({
      label: "Spot Fixture · Asset",
      code: "MH-002",
      href: "/acme/assets/units?peek=MH-002",
    });
    expect(
      inventoryEntry(
        { ...unit, key: "RAD 1/A", title: "Radio" },
        { org: "acme", visible: owner, noun: "Asset" },
      )?.href,
    ).toBe("/acme/assets/units?peek=RAD%201%2FA");
  });

  it("opens a class in the asset classes peek by its id", () => {
    expect(
      inventoryEntry(assetClass, { org: "acme", visible: owner, noun: "Asset class" }),
    ).toEqual({
      label: "Digital Two-Way Radio · Asset class",
      href: "/acme/assets/asset-classes?peek=01920000-0000-7000-8000-000000112102",
    });
  });

  it("titles a unit whose class the person cannot read by its tag, without the tag again as a code", () => {
    expect(
      inventoryEntry({ ...unit, title: "MH-002" }, { org: "acme", visible: owner, noun: "Asset" }),
    ).toEqual({ label: "MH-002 · Asset", href: "/acme/assets/units?peek=MH-002" });
  });

  it("returns null when the node is not visible, and leaves that type out of the search", () => {
    const noUnits = (node: string) => node !== "assets.units";
    const noClasses = (node: string) => node !== "assets.asset-classes";
    expect(inventoryEntry(unit, { org: "acme", visible: noUnits, noun: "Asset" })).toBeNull();
    expect(
      inventoryEntry(assetClass, { org: "acme", visible: noClasses, noun: "Asset class" }),
    ).toBeNull();
    expect(inventoryEntry({ ...unit, key: null }, { org: "acme", visible: owner, noun: "Asset" }))
      .toBeNull();
    expect(hiddenInventoryTypes(owner)).toEqual([]);
    expect(hiddenInventoryTypes(noUnits)).toEqual(["asset"]);
    expect(hiddenInventoryTypes(noClasses)).toEqual(["asset_class"]);
    const assetsOff = visibleFor({
      role: "owner",
      conditions: ["desktop"],
      disabledModules: ["assets"],
    });
    expect(hiddenInventoryTypes(assetsOff)).toEqual(["asset", "asset_class"]);
  });

  it("omits hidden types without excluding them, so a query with nothing to look for stays empty", () => {
    const assetsOff = visibleFor({
      role: "owner",
      conditions: ["desktop"],
      disabledModules: ["assets"],
    });
    // A minus word alone, and a word with nothing the search can read: global_search returns nothing for
    // both while every criterion is empty, and exclude_types is one.
    for (const query of ["-radio", "##"]) {
      const request = withHiddenInventory(searchRequest(parseSearchQuery(query)), assetsOff);
      expect(request.exclude_types).toEqual([]);
      expect(request.omit_types).toEqual(["asset", "asset_class"]);
    }
    const typed = withHiddenInventory(
      searchRequest(parseSearchQuery("radio -type:asset")),
      (node) => node !== "assets.asset-classes",
    );
    expect(typed.exclude_types).toEqual(["asset"]);
    expect(typed.omit_types).toEqual(["asset_class"]);
    const shown = searchRequest(parseSearchQuery("radio"));
    expect(withHiddenInventory(shown, owner)).toBe(shown);
  });
});

describe("queryVector and search.semantic_enabled", () => {
  it("sends nothing without a provider and never asks for the org's switch", async () => {
    const semanticEnabled = vi.fn(() => Promise.resolve(true));
    expect(await queryVector({ provider: null, text: "harness", semanticEnabled })).toBeNull();
    expect(semanticEnabled).not.toHaveBeenCalled();
  });

  it("sends nothing while the org has search.semantic_enabled off", async () => {
    const embed = vi.fn(() => Promise.resolve([[1]]));
    const provider: EmbeddingProvider = { ...localHashEmbeddings(), embed };
    expect(
      await queryVector({
        provider,
        text: "harness",
        semanticEnabled: () => Promise.resolve(false),
      }),
    ).toBeNull();
    expect(embed).not.toHaveBeenCalled();
    expect(
      await queryVector({ provider, text: "ab", semanticEnabled: () => Promise.resolve(true) }),
    ).toBeNull();
  });

  it("embeds the words once the org turns search.semantic_enabled on", async () => {
    const found = await queryVector({
      provider: localHashEmbeddings(),
      text: "harness climbing",
      semanticEnabled: () => Promise.resolve(true),
    });
    expect(found?.model).toBe("local-hash-384");
    expect(found?.minSimilarity).toBe(0.25);
    expect(found?.literal.startsWith("[")).toBe(true);
    expect(found?.literal.split(",")).toHaveLength(384);
  });

  it("falls back to words only when the provider fails or is slower than the limit", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const failing: EmbeddingProvider = {
      ...localHashEmbeddings(),
      embed: () => Promise.reject(new Error("down")),
    };
    expect(
      await queryVector({
        provider: failing,
        text: "harness",
        semanticEnabled: () => Promise.resolve(true),
      }),
    ).toBeNull();
    expect(error).toHaveBeenCalled();
    error.mockRestore();
    const slow: EmbeddingProvider = {
      ...localHashEmbeddings(),
      embed: () => new Promise(() => undefined),
    };
    expect(
      await queryVector({
        provider: slow,
        text: "harness",
        semanticEnabled: () => Promise.resolve(true),
        timeoutMs: 10,
      }),
    ).toBeNull();
  });
});

import { readdirSync, readFileSync } from "node:fs";
import { PLAN_OFFERING, extraSeatsOnSale } from "@xos/schemas/plans/offering";
import { describe, expect, it } from "vitest";
import { SEAT_OFFER_KEYS, seatCopyKey } from "../src/offering.ts";
import { flatten, icuArguments, type Catalog } from "./icu.ts";

/**
 * Copy that offers extra seats follows offering.extra_seats in packages/schemas/plans.yaml (ADR 0035, 2026-11-15
 * amendment). Every message that offers them sits at a key SEAT_OFFER_KEYS names, beside a stand-in that offers
 * nothing, and seatCopyKey chooses between the two by the status. This suite reads every folder of messages/, the
 * launch locales, the pseudo-locales and any Beta locale the pipeline has written, and the latest definition of every
 * database function in supabase/migrations. It fails when a message a person can read offers extra seats while they
 * are not on sale, and when they are on sale and the copy that should offer them does not.
 */

const messagesRoot = new URL("../messages/", import.meta.url);
const migrationsRoot = new URL("../../../supabase/migrations/", import.meta.url);

/**
 * How a message offers extra seats, in the languages whose wording the repository writes by hand. English: buy,
 * purchase or order and then seats, with or without "extra", "more" or "additional"; or add or get and then seats
 * marked by one of those words, because "upgrade the plan to add seats" and "add a seat" to a crew roster offer no
 * purchase. Spanish: comprar, adquirir, agregar or añadir and then asientos, puestos, plazas or licencias, marked by
 * "más" before the noun or "adicionales" or "extra" after it; puestos and plazas are also jobs and places.
 */
const EN_MARK = "(extra|more|additional)\\s+";
const EN_BUY = "buy|buys|buying|bought|purchase[sd]?|purchasing|order|orders|ordering|ordered";
const EN_ADD = "add|adds|adding|added|get|gets|getting";
const ES_VERB =
  "(compr|adquir|adquier|agreg|agregu|añad)(a|e|o|ar|ir|an|en|as|es|amos|imos|emos|ando|iendo)";
const ES_NOUN = "(asientos?|puestos?|plazas?|licencias?)";
const OFFERS: Readonly<Record<string, RegExp>> = {
  en: new RegExp(
    `\\b((${EN_BUY})\\s+((an?|the|some)\\s+)?(${EN_MARK})?|(${EN_ADD})\\s+((an?|the|some)\\s+)?${EN_MARK})seats?\\b`,
    "i",
  ),
  es: new RegExp(
    `(?<!\\p{L})${ES_VERB}\\s+((un|una|unos|unas|los|las)\\s+)?(más\\s+${ES_NOUN}|${ES_NOUN}\\s+(adicional(es)?|extras?))(?!\\p{L})`,
    "iu",
  ),
};

const offersSeats = (folder: string, message: string): boolean | undefined =>
  OFFERS[folder.slice(0, 2)]?.test(message);

const folders = readdirSync(messagesRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

/** Every message of a folder, keyed `<file>.<dotted key>`. */
function messagesOf(folder: string): Map<string, string> {
  const out = new Map<string, string>();
  const dir = new URL(`${folder}/`, messagesRoot);
  for (const file of readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()) {
    const catalog = JSON.parse(readFileSync(new URL(file, dir), "utf8")) as Catalog;
    for (const [key, message] of flatten(catalog)) {
      out.set(`${file.slice(0, -".json".length)}.${key}`, message);
    }
  }
  return out;
}

const leafOf = (path: string): string => path.slice(path.lastIndexOf(".") + 1);
const isOfferKey = (path: string): boolean => Object.hasOwn(SEAT_OFFER_KEYS, leafOf(path));
const standIns = new Set(Object.values(SEAT_OFFER_KEYS).filter((v): v is string => v !== null));
const isStandIn = (path: string): boolean => standIns.has(leafOf(path));

/** The messages a person can read in one state: seatCopyKey never leads to the other state's side of a pair. */
function shown(all: ReadonlyMap<string, string>, onSale: boolean): Map<string, string> {
  return new Map([...all].filter(([path]) => (onSale ? !isStandIn(path) : !isOfferKey(path))));
}

describe("copy that offers extra seats follows plans.yaml", () => {
  it("reads the launch locales, the pseudo-locales and every other folder of messages/", () => {
    expect(folders).toEqual(expect.arrayContaining(["en-US", "es-US", "pseudo"]));
    for (const folder of folders) expect(messagesOf(folder).size, folder).toBeGreaterThan(0);
  });

  it("chooses the stand-in only while extra seats are not on sale", () => {
    expect(extraSeatsOnSale()).toBe(PLAN_OFFERING.extraSeats.status === "on_sale");
    expect(seatCopyKey("seat_limit_reached", true)).toBe("seat_limit_reached");
    expect(seatCopyKey("seat_limit_reached", false)).toBe("seat_limit_reached_not_on_sale");
    expect(seatCopyKey("refusals.seat_limit_reached", false)).toBe(
      "refusals.seat_limit_reached_not_on_sale",
    );
    expect(seatCopyKey("panel.noRoom", false)).toBe("panel.noRoomNotOnSale");
    expect(seatCopyKey("panel.noRoom", true)).toBe("panel.noRoom");
    // A plan that prices no extra seats has its own rule and copy, which no status changes.
    expect(seatCopyKey("seat_limit_upgrade", false)).toBe("seat_limit_upgrade");
    expect(seatCopyKey("buySeats", false)).toBe("buySeats");
    expect(seatCopyKey("role_band", false)).toBe("role_band");
    expect(seatCopyKey("seat_limit_reached")).toBe(
      extraSeatsOnSale() ? "seat_limit_reached" : "seat_limit_reached_not_on_sale",
    );
  });

  it("recognizes an offer however it is worded, and nothing that offers no purchase", () => {
    for (const offer of [
      "Buy extra seats in Billing and Plan, or upgrade the plan.",
      "Buy seats in Billing and Plan.",
      "Purchase an additional seat.",
      "Order more seats",
      "Add extra seats in Billing and Plan, or upgrade the plan.",
      "Get more seats in Billing and Plan.",
    ]) {
      expect(offersSeats("en-US", offer), offer).toBe(true);
    }
    for (const plain of [
      "Upgrade the plan in Billing and Plan, or remove a member to free a seat.",
      "All seats are in use. Upgrade the plan to add seats.",
      "No positions yet. Add a seat, then plan shifts and records against it.",
      "Your seat is read-only.",
    ]) {
      expect(offersSeats("en-US", plain), plain).toBe(false);
    }
    for (const offer of [
      "Compra asientos adicionales en Facturación y plan.",
      "Compra plazas adicionales en Facturación y plan.",
      "Compra más asientos en Facturación y plan.",
      "Compre un asiento extra.",
      "Adquiere asientos adicionales.",
      "Agrega asientos adicionales en Facturación y plan.",
      "Añade más plazas.",
      "Compra licencias adicionales.",
    ]) {
      expect(offersSeats("es-US", offer), offer).toBe(true);
    }
    for (const plain of [
      "Tu plan no tiene plazas para ese rol",
      "Todos los puestos están en uso. Mejore el plan para agregar puestos.",
      "Todos los asientos de tu plan están en uso y el plan no vende asientos adicionales.",
      "Mejora el plan o quita a un miembro.",
    ]) {
      expect(offersSeats("es-US", plain), plain).toBe(false);
    }
    // A language the repository does not write by hand has no pattern, and the suite says so rather than passing it.
    expect(offersSeats("fr-FR", "Achetez des sièges supplémentaires.")).toBeUndefined();
  });

  it.each(folders)("%s: no message outside the listed keys offers extra seats", (folder) => {
    const stray = [...messagesOf(folder)]
      .filter(([path, message]) => offersSeats(folder, message) && !isOfferKey(path))
      .map(([path]) => path);
    expect(stray).toEqual([]);
  });

  it.each(folders)(
    "%s: every offer has its stand-in beside it, with the same arguments",
    (folder) => {
      const all = messagesOf(folder);
      const launch = folder === "en-US" || folder === "es-US";
      for (const [path, message] of all) {
        const standIn = SEAT_OFFER_KEYS[leafOf(path)];
        if (!isOfferKey(path) || !standIn) continue;
        const beside = all.get(path.slice(0, path.length - leafOf(path).length) + standIn);
        // A Beta locale may lack a key, which then reads en-US; a launch locale holds every pair whole.
        if (launch) expect(beside, `${folder} ${path}`).toBeTypeOf("string");
        if (beside === undefined) continue;
        expect(beside, `${folder} ${path}`).not.toBe(message);
        expect(icuArguments(beside), `${folder} ${path}`).toEqual(icuArguments(message));
      }
    },
  );

  it.each(folders)(
    "%s: while extra seats are not on sale, nothing a person reads offers them",
    (folder) => {
      const offered = [...shown(messagesOf(folder), false)]
        .filter(([, message]) => offersSeats(folder, message))
        .map(([path]) => path);
      expect(offered).toEqual([]);
    },
  );

  it.each(folders)(
    "%s: once they are on sale, every listed key with a stand-in offers them",
    (folder) => {
      const all = messagesOf(folder);
      const visible = shown(all, true);
      for (const [path, message] of all) {
        if (isStandIn(path)) expect(visible.has(path), `${folder} ${path}`).toBe(false);
        if (!isOfferKey(path) || !SEAT_OFFER_KEYS[leafOf(path)]) continue;
        expect(visible.get(path), `${folder} ${path}`).toBe(message);
        const offers = offersSeats(folder, message);
        if (offers !== undefined) expect(offers, `${folder} ${path}`).toBe(true);
      }
    },
  );

  it("holds the copy in force today to the status plans.yaml states", () => {
    const onSale = extraSeatsOnSale();
    for (const folder of ["en-US", "es-US"]) {
      const all = messagesOf(folder);
      const refusals = [...all.keys()].filter((path) => leafOf(path) === "seat_limit_reached");
      // Members settings, the invitation, profiles, platform forms and the ownership offer each hold the refusal.
      expect(refusals.length, folder).toBe(5);
      for (const path of [
        ...refusals,
        "planLimits.panel.noRoom",
        "shell.settings.billing.seatsFull",
      ]) {
        const inForce = all.get(seatCopyKey(path)) ?? "";
        expect(inForce, `${folder} ${path}`).not.toBe("");
        expect(offersSeats(folder, inForce), `${folder} ${path}`).toBe(onSale);
      }
    }
  });
});

/**
 * The latest definition of every function the migrations create, by name and argument list. Two migrations that
 * define one function replace each other whole, so only the last one in apply order is what the database runs.
 */
function latestFunctions(): Map<string, { readonly file: string; readonly body: string }> {
  const out = new Map<string, { file: string; body: string }>();
  const header = /create (?:or replace )?function\s+([a-z_][a-z0-9_.]*\s*\([^$]*?\))\s*returns\b/gi;
  for (const file of readdirSync(migrationsRoot)
    .filter((f) => f.endsWith(".sql"))
    .sort()) {
    const sql = readFileSync(new URL(file, migrationsRoot), "utf8");
    for (const match of sql.matchAll(header)) {
      const start = match.index;
      const open = sql.indexOf("$", start + match[0].length);
      const tag = open < 0 ? null : /^\$[a-z_]*\$/i.exec(sql.slice(open))?.[0];
      if (!tag) continue;
      const close = sql.indexOf(tag, open + tag.length);
      if (close < 0) continue;
      const signature = (match[1] ?? "").replace(/\s+/g, " ").toLowerCase();
      out.set(signature, { file, body: sql.slice(open + tag.length, close) });
    }
  }
  return out;
}

describe("database messages about extra seats follow plans.yaml", () => {
  const functions = latestFunctions();
  const find = (name: string) =>
    [...functions].filter(([signature]) => signature.startsWith(`${name}(`)).map(([, f]) => f);

  it("finds the functions the migrations define, each at its latest definition", () => {
    expect(functions.size).toBeGreaterThan(1000);
    expect(find("private.assert_within_plan_limit")).toHaveLength(1);
    expect(find("private.over_limit_refusal")).toHaveLength(1);
    expect(find("private.refuse")).toHaveLength(1);
  });

  it("offers extra seats in no function while they are not on sale", () => {
    const offering = [...functions]
      .filter(([, f]) => OFFERS["en"]?.test(f.body) || OFFERS["es"]?.test(f.body))
      .map(([signature, f]) => `${f.file}: ${signature}`);
    if (!extraSeatsOnSale()) expect(offering).toEqual([]);
  });

  it("keeps the seat refusal's rule and codes, and words it by the status", () => {
    const refusal = find("private.assert_within_plan_limit")[0]?.body ?? "";
    // The rule: a plan that prices extra seats refuses as seat_limit_reached, any other as seat_limit_upgrade.
    expect(refusal).toContain("private.plan_extra_seat_prices");
    expect(refusal).toContain("private.refuse('seat_limit_reached'");
    expect(refusal).toContain("private.refuse('seat_limit_upgrade'");
    expect(refusal).toContain("private.refuse('plan_limit_exceeded'");
    expect(OFFERS["en"]?.test(refusal)).toBe(extraSeatsOnSale());
    const readOnly = find("private.over_limit_refusal")[0]?.body ?? "";
    expect(readOnly).toContain("Your seat is read-only");
    expect(OFFERS["en"]?.test(readOnly)).toBe(extraSeatsOnSale());
  });
});

/**
 * Offer handlers (A04P, People module; ADR 0023 offer-versioned-terms). An offer is a row of
 * app.offers whose terms live in app.offer_versions (migration 0764): the read shape carries the
 * terms in force from the latest version, the applicant from the application, and `responded_at`
 * from the latest party response in the offer's state ledger. Every change goes through A28's
 * offer RPCs, which apply the lifecycle and the capability, so refusals come back as 422.
 * This file is the offers block of people.ts, kept apart so A13's People handlers merge cleanly.
 */
import type { XosClient } from "@xos/data";
import { declineOffer, counterOffer } from "@xos/data/gateway-operations";
import type { OfferTerms } from "@xos/data/opportunities";
import { acceptOffer, reviseOffer, sendOffer, withdrawOffer } from "@xos/data/opportunities";
import type { Components } from "../../contract/operations.generated.ts";
import { assertIfMatch } from "../../runtime/etag.ts";
import type { HandlerSet } from "../../runtime/handler.ts";
import { created, ok } from "../../runtime/handler.ts";
import { from, handlersFor, run, tableResource, unwrap } from "../support/table.ts";
import type { Row } from "../support/table.ts";

type Offer = Components["Offer"];

const TERMS = [
  "rate_type",
  "amount_minor",
  "currency_code",
  "starts_on",
  "ends_on",
  "message",
  "expires_at",
] as const;

/** The party's responses: a counter, an acceptance or a declination. */
const RESPONSES = ["Countered", "Accepted", "Declined"];

async function offerContract(row: Row, db: XosClient): Promise<Row> {
  const [version] = await run<Row[]>(
    from(db, "offer_versions")
      .select(`version_number, proposed_side, ${TERMS.join(", ")}`)
      .eq("offer_id", row["id"])
      .is("deleted_at", null)
      .order("version_number", { ascending: false })
      .limit(1),
  );
  const application = await run<Row | null>(
    from(db, "applications")
      .select("applicant_person_id, applicant_organization_id")
      .eq("id", row["application_id"])
      .maybeSingle(),
  );
  const [response] = await run<{ created_at: string }[]>(
    from(db, "offer_state_transitions")
      .select("created_at")
      .eq("offer_id", row["id"])
      .in("to_state", RESPONSES)
      .order("created_at", { ascending: false })
      .limit(1),
  );
  const currency = version?.["currency_code"];
  return {
    ...row,
    ...Object.fromEntries(TERMS.map((t) => [t, version?.[t] ?? null])),
    currency_code: typeof currency === "string" ? currency.trim() : null,
    version_number: version?.["version_number"] ?? 0,
    proposed_side: version?.["proposed_side"] ?? "Organization",
    person_id: application?.["applicant_person_id"] ?? null,
    organization_id: application?.["applicant_organization_id"] ?? null,
    responded_at: response?.created_at ?? null,
  };
}

const offers = tableResource("offers", {
  verbs: ["list", "get"],
  derived: [
    ...TERMS,
    "version_number",
    "proposed_side",
    "person_id",
    "organization_id",
    "responded_at",
  ],
  extraColumns: ["application_id"],
  toContract: (row, context) => offerContract(row, context.db),
});

type Terms = Partial<Record<(typeof TERMS)[number], unknown>>;

/** The terms in force with the caller's changes applied; an omitted member keeps its value. */
function mergeTerms(current: Row, change: Terms): OfferTerms {
  const pick = <K extends (typeof TERMS)[number]>(k: K) =>
    (change[k] === undefined ? current[k] : change[k]) as never;
  return {
    rateType: pick("rate_type"),
    amountMinor: pick("amount_minor"),
    currencyCode: pick("currency_code"),
    startsOn: pick("starts_on"),
    endsOn: pick("ends_on"),
    message: pick("message"),
    expiresAt: pick("expires_at"),
  };
}

const read = (context: Parameters<typeof offers.read>[0], id: string) =>
  offers.read(context, id) as Promise<Offer>;

export const offerHandlers = {
  ...handlersFor("People", offers),

  /** Sends the offer with its first terms (app.send_offer). */
  "offers.create": async ({ body }, context) => {
    const id = unwrap(
      await sendOffer(context.db, body.application_id, {
        rateType: body.rate_type ?? null,
        amountMinor: body.amount_minor ?? null,
        currencyCode: body.currency_code ?? null,
        startsOn: body.starts_on ?? null,
        endsOn: body.ends_on ?? null,
        message: body.message ?? null,
        expiresAt: body.expires_at ?? null,
      }),
    );
    return created(await read(context, id));
  },

  /** Revises the terms (app.revise_offer), answering a counter. */
  "offers.update": async ({ params, body, ifMatch }, context) => {
    const current = await read(context, params.id);
    assertIfMatch(ifMatch ?? "*", current);
    unwrap(await reviseOffer(context.db, params.id, mergeTerms(current, body)));
    return ok(await read(context, params.id));
  },

  "offers.accept": async ({ params }, context) => {
    await read(context, params.id);
    unwrap(await acceptOffer(context.db, params.id));
    return ok(await read(context, params.id));
  },

  "offers.decline": async ({ params, body }, context) => {
    await read(context, params.id);
    unwrap(await declineOffer(context.db, { offerId: params.id, reason: body.reason }));
    return ok(await read(context, params.id));
  },

  /** Counters with the party's terms (app.counter_offer); a counter carries no expiry. */
  "offers.counter": async ({ params, body }, context) => {
    const current = await read(context, params.id);
    const terms = mergeTerms(current, body);
    unwrap(
      await counterOffer(context.db, {
        offerId: params.id,
        amountMinor: terms.amountMinor as number,
        currency: terms.currencyCode as string,
        rateType: terms.rateType as never,
        startsOn: terms.startsOn as string,
        endsOn: terms.endsOn as string,
        message: terms.message as string,
      }),
    );
    return ok(await read(context, params.id));
  },

  "offers.withdraw": async ({ params, body }, context) => {
    await read(context, params.id);
    unwrap(await withdrawOffer(context.db, params.id, body.reason));
    return ok(await read(context, params.id));
  },
} satisfies HandlerSet<"People">;

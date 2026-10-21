/**
 * Work Details handlers (A78, migration 1340): the caller's own work details, emergency contacts
 * and loyalty programs, per-engagement shares, what an engaging org reads, and the access log.
 * Every call runs as the caller, so the owner-only policies, the share RPCs and the capability
 * checks of app.shared_work_details decide. The Restricted passport number is written through its
 * encrypting RPC, always read masked, and shown only by the logged reveal actions.
 */
import type { Components } from "../../contract/operations.generated.ts";
import { notFound, refused } from "../../problem.ts";
import { requirePerson } from "../../runtime/context.ts";
import type { RequestContext } from "../../runtime/context.ts";
import { assertIfMatch } from "../../runtime/etag.ts";
import type { HandlerSet } from "../../runtime/handler.ts";
import { created, ok } from "../../runtime/handler.ts";
import { masked } from "../../runtime/masking.ts";
import { from, handlersFor, rpc, run, tableResource } from "../support/table.ts";
import type { Row } from "../support/table.ts";

const PASSPORT_REASON =
  "The passport number is Restricted: read it through workDetails.revealPassport, which is logged.";

const ownRow = (_body: Row, context: RequestContext): Row => ({
  person_id: requirePerson(context),
});

// Work details ----------------------------------------------------------------------------------------

const workDetails = tableResource("workDetails", {
  verbs: ["list", "get", "delete"],
  derived: ["passport_number"],
  toContract: (row) => ({ ...row, passport_number: masked(PASSPORT_REASON) }),
});

const DETAIL_FIELDS = [
  "shirt_size",
  "jacket_size",
  "pants_size",
  "shoe_size",
  "glove_size",
  "hat_size",
  "uniform_notes",
  "dietary_needs",
  "allergies",
  "dietary_notes",
  "accessibility_needs",
  "accessibility_notes",
  "seat_preference",
  "meal_preference",
  "home_airport",
  "passport_issuing_country",
  "passport_expires_on",
  "passport_name",
] as const;

function detailColumns(body: Row): Row {
  const out: Row = {};
  for (const field of DETAIL_FIELDS) if (body[field] !== undefined) out[field] = body[field];
  return out;
}

async function setPassportNumber(context: RequestContext, value: unknown): Promise<void> {
  await run(rpc(context.db, "set_my_passport_number", { p_passport_number: value ?? null }));
}

type WorkDetails = Components["WorkDetails"];

// Shares ------------------------------------------------------------------------------------------------

const shares = tableResource("workDetailShares", { orgColumn: false });

async function liveShare(context: RequestContext, id: string): Promise<Row> {
  const share = await shares.read(context, id);
  if (share["revoked_at"] !== null) {
    throw refused(
      "REFUSE",
      "This share was revoked. Share your work details with the engagement again.",
      "work_detail_share_revoked",
    );
  }
  return share;
}

type WorkDetailShare = Components["WorkDetailShare"];

// Handlers ------------------------------------------------------------------------------------------------

export const workDetailHandlers = {
  ...handlersFor("Identity", workDetails),
  "workDetails.create": async ({ body }, context) => {
    requirePerson(context);
    const id = await run<string>(rpc(context.db, "ensure_my_work_details"));
    const patch = detailColumns(body as Row);
    if (Object.keys(patch).length > 0) {
      await run(from(context.db, "person_work_details").update(patch).eq("id", id).select("id"));
    }
    if ((body as Row)["passport_number"] !== undefined) {
      await setPassportNumber(context, (body as Row)["passport_number"]);
    }
    return created((await workDetails.read(context, id)) as WorkDetails);
  },
  "workDetails.update": async ({ params, body, ifMatch }, context) => {
    const current = await workDetails.read(context, params.id);
    assertIfMatch(ifMatch ?? "*", current);
    const patch = detailColumns(body as Row);
    if (Object.keys(patch).length > 0) {
      const rows = await run<Row[]>(
        from(context.db, "person_work_details")
          .update(patch)
          .eq("id", params.id)
          .is("deleted_at", null)
          .select("id"),
      );
      if (rows.length === 0) throw notFound("No work details with this identifier are yours.");
    }
    if ((body as Row)["passport_number"] !== undefined) {
      await setPassportNumber(context, (body as Row)["passport_number"]);
    }
    return ok((await workDetails.read(context, params.id)) as WorkDetails);
  },
  "workDetails.revealPassport": async ({ params }, context) => {
    await workDetails.read(context, params.id, ["id"]);
    const value = await run<string>(rpc(context.db, "reveal_my_passport_number"));
    return ok({ passport_number: value });
  },

  ...handlersFor(
    "Identity",
    tableResource("emergencyContacts", { orgColumn: false, beforeCreate: ownRow }),
  ),
  ...handlersFor(
    "Identity",
    tableResource("loyaltyPrograms", { orgColumn: false, beforeCreate: ownRow }),
  ),

  ...handlersFor("Identity", shares),
  "workDetailShares.create": async ({ body }, context) => {
    requirePerson(context);
    const id = await run<string>(
      rpc(context.db, "share_work_details", {
        p_engagement_id: body.engagement_id,
        p_categories: body.categories,
      }),
    );
    return created((await shares.read(context, id)) as WorkDetailShare);
  },
  "workDetailShares.update": async ({ params, body, ifMatch }, context) => {
    const current = await liveShare(context, params.id);
    assertIfMatch(ifMatch ?? "*", current);
    if (body.categories !== undefined) {
      await run(
        rpc(context.db, "share_work_details", {
          p_engagement_id: current["engagement_id"],
          p_categories: body.categories,
        }),
      );
    }
    return ok((await shares.read(context, params.id)) as WorkDetailShare);
  },
  "workDetailShares.revoke": async ({ params }, context) => {
    await liveShare(context, params.id);
    await run(rpc(context.db, "revoke_work_detail_share", { p_work_detail_share_id: params.id }));
    return ok((await shares.read(context, params.id)) as WorkDetailShare);
  },
  "workDetailShares.details": async ({ params }, context) => {
    const share = await shares.read(context, params.id, ["id", "engagement_id"]);
    const details = await run<Components["SharedWorkDetails"]>(
      rpc(context.db, "shared_work_details", { p_engagement_id: share["engagement_id"] }),
    );
    return ok(details);
  },
  "workDetailShares.revealPassport": async ({ params, body }, context) => {
    const share = await shares.read(context, params.id, ["id", "engagement_id"]);
    const value = await run<string>(
      rpc(context.db, "reveal_shared_passport_number", {
        p_engagement_id: share["engagement_id"],
        p_reason: body.reason,
      }),
    );
    return ok({ passport_number: value });
  },

  ...handlersFor("Identity", tableResource("workDetailEvents", { softDelete: false, key: "id" })),
} satisfies HandlerSet<"Identity">;

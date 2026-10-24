/**
 * A79 handlers (migrations 1350 to 1355): ownership transfers, deletion requests and their recovery,
 * deletion certificates, standing partner grants, leaving a partner and checking a custom domain again.
 * handlers/platform.ts and handlers/identity.ts spread them. Every call runs as the caller: row level
 * security and the RPCs decide, refusals answer 422 with the rule (step_up_required among them).
 * Shapes follow catalog/modules/parts/a79.ts.
 */
import { requireOrg } from "../../runtime/context.ts";
import type { ErasedHandler } from "../../runtime/handler.ts";
import { created, ok } from "../../runtime/handler.ts";
import { rpc, run, tableResource, type Row } from "../support/table.ts";

const ownershipTransfers = tableResource("ownershipTransfers", { verbs: ["list", "get"] });
const orgDeletionRequests = tableResource("orgDeletionRequests", { verbs: ["list", "get"] });
const deletionCertificates = tableResource("deletionCertificates", { verbs: ["list", "get"] });
const partnerStandingGrants = tableResource("partnerStandingGrants", { verbs: ["list", "get"] });

export const a79PlatformHandlers: Readonly<Record<string, ErasedHandler>> = {
  ...ownershipTransfers.handlers,
  "ownershipTransfers.offer": async (request, context) => {
    const body = (request.body ?? {}) as Row;
    const id = await run<string>(
      rpc(context.db, "offer_ownership_transfer", {
        p_org_id: requireOrg(context).id,
        p_to_person_id: body["to_person_id"],
        p_previous_owner_outcome: body["previous_owner_outcome"],
      }),
    );
    return created(await ownershipTransfers.read(context, id));
  },
  "ownershipTransfers.accept": async (request, context) => {
    const id = String(request.params["id"]);
    await ownershipTransfers.read(context, id, ["id"]);
    await run(rpc(context.db, "accept_ownership_transfer", { p_transfer_id: id }));
    return ok(await ownershipTransfers.read(context, id));
  },
  "ownershipTransfers.decline": async (request, context) => {
    const id = String(request.params["id"]);
    await ownershipTransfers.read(context, id, ["id"]);
    await run(rpc(context.db, "decline_ownership_transfer", { p_transfer_id: id }));
    return ok(await ownershipTransfers.read(context, id));
  },
  "ownershipTransfers.cancel": async (request, context) => {
    const id = String(request.params["id"]);
    await ownershipTransfers.read(context, id, ["id"]);
    await run(rpc(context.db, "cancel_ownership_transfer", { p_transfer_id: id }));
    return ok(await ownershipTransfers.read(context, id));
  },

  ...orgDeletionRequests.handlers,
  "orgDeletionRequests.request": async (request, context) => {
    const body = (request.body ?? {}) as Row;
    const id = await run<string>(
      rpc(context.db, "request_org_deletion", {
        p_org_id: requireOrg(context).id,
        p_confirm_name: body["confirm_name"],
        p_reason: body["reason"],
      }),
    );
    return created(await orgDeletionRequests.read(context, id));
  },
  "orgDeletionRequests.recover": async (request, context) => {
    const id = String(request.params["id"]);
    await orgDeletionRequests.read(context, id, ["id"]);
    await run(rpc(context.db, "recover_org_deletion", { p_org_id: requireOrg(context).id }));
    return ok(await orgDeletionRequests.read(context, id));
  },

  ...deletionCertificates.handlers,

  ...partnerStandingGrants.handlers,
  "partnerStandingGrants.record": async (request, context) => {
    const body = (request.body ?? {}) as Row;
    const id = await run<string>(
      rpc(context.db, "record_standing_grant", {
        p_org_id: requireOrg(context).id,
        p_capability_code: body["capability_code"],
        p_valid_to: body["valid_to"],
        p_agreement_reference: body["agreement_reference"],
      }),
    );
    return created(await partnerStandingGrants.read(context, id));
  },
  "partnerStandingGrants.end": async (request, context) => {
    const id = String(request.params["id"]);
    await partnerStandingGrants.read(context, id, ["id"]);
    await run(rpc(context.db, "end_standing_grant", { p_standing_grant_id: id }));
    return ok(await partnerStandingGrants.read(context, id));
  },
};

const organizations = tableResource("organizations");
const verifiedDomains = tableResource("verifiedDomains");

export const a79IdentityHandlers: Readonly<Record<string, ErasedHandler>> = {
  "organizations.leavePartner": async (request, context) => {
    const body = (request.body ?? {}) as Row;
    const org = requireOrg(context).id;
    await run(
      rpc(context.db, "leave_partner", { p_org_id: org, p_confirm_name: body["confirm_name"] }),
    );
    return ok(await organizations.read(context, org));
  },
  "verifiedDomains.check": async (request, context) => {
    const id = String(request.params["id"]);
    await verifiedDomains.read(context, id, ["id"]);
    await run(rpc(context.db, "request_domain_check", { p_org_domain_id: id }));
    return ok(await verifiedDomains.read(context, id));
  },
};

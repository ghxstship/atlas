/**
 * People handlers (A13). Every People operation in the frozen v1 contract differs from the People
 * schema of migration 0361: role assignments carry headcount and ratio_basis instead of
 * staffing_basis and dates, requisitions carry positions, budget_minor, title and urid instead of
 * headcount, units, rate and the canon rate card combination, and agreements carry document_id and
 * engagement_id instead of their kind, text and signer. They stay document-only until A04C's contract
 * corrections land (ADR 0007), and the Atlas pages serve them through @xos/data/people meanwhile.
 * Offers belong to the Opportunities handlers (A28).
 */
import { defineHandlers } from "../runtime/handler.ts";

export const handlers = defineHandlers("People", {});

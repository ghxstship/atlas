import { describe, expect, it } from "vitest";
import enFinance from "../../../packages/i18n/messages/en-US/finance.json";
import esFinance from "../../../packages/i18n/messages/es-US/finance.json";
import enProcurement from "../../../packages/i18n/messages/en-US/procurement.json";
import esProcurement from "../../../packages/i18n/messages/es-US/procurement.json";
import enShell from "../../../packages/i18n/messages/en-US/shell.json";
import esShell from "../../../packages/i18n/messages/es-US/shell.json";
import { refusalCopy, refusalFamily } from "@/lib/collection-kit/refusal-copy";

/**
 * Crawl 4.9 refusal copy: a named refusal never prints its rule code under the sentence, the PO
 * approval-policy refusal says to submit the order, spend authority refusals say who sets limits and
 * where, and the finance callout no longer reads "Refused" twice.
 */
describe("refusal copy in the kit feedback", () => {
  const procurementHas = (key: string) => key in enProcurement.refusals;

  it("uses the module sentence without the code when the catalog names the rule", () => {
    expect(refusalCopy("sod_po_creator", procurementHas)).toEqual({
      from: "module",
      key: "sod_po_creator",
      showRule: false,
    });
    expect(refusalCopy("approval_policy_pending", procurementHas)).toEqual({
      from: "module",
      key: "approval_policy_pending",
      showRule: false,
    });
  });

  it("uses a family sentence without the code, and shows the code only for the generic refusal", () => {
    const none = () => false;
    expect(refusalFamily("approval_policy_pending")).toBe("approval");
    expect(refusalCopy("sod_other", none)).toEqual({
      from: "kit",
      key: "refusalFamily.separation",
      showRule: false,
    });
    expect(refusalCopy("approval_policy_pending", none).showRule).toBe(false);
    expect(refusalCopy("mystery_rule", none)).toEqual({
      from: "kit",
      key: "refusalFamily.other",
      showRule: true,
    });
  });

  it("has every kit family sentence in both languages, none pointing at a code it hides", () => {
    for (const catalog of [enProcurement, esProcurement]) {
      for (const family of ["transition", "conflict", "separation", "spend", "approval", "other"]) {
        expect(
          catalog.kit.refusalFamily[family as keyof typeof catalog.kit.refusalFamily],
        ).toBeTruthy();
      }
      expect(catalog.kit.refusalRule).toContain("{rule}");
      expect(catalog.refusals.approval_policy_pending).toBeTruthy();
    }
    expect(enProcurement.kit.refusalFamily.other).not.toMatch(/code below explains/);
    expect(esProcurement.kit.refusalFamily.other).not.toMatch(/código de la regla abajo explica/);
  });
});

describe("spend authority refusals", () => {
  it("say who sets limits and where, and never send the approver to a policy route that does not exist", () => {
    const cases = [
      [enFinance.refusals, /Settings, Spend authority/],
      [enProcurement.refusals, /Settings, Spend authority/],
      [esFinance.refusals, /Configuración, Autoridad de gasto/],
      [esProcurement.refusals, /Configuración, Autoridad de gasto/],
    ] as const;
    for (const [refusals, where] of cases) {
      expect(refusals.spend_authority_exceeded).toMatch(where);
      expect(refusals.spend_authority_missing).toMatch(where);
      expect(refusals.spend_authority_exceeded).not.toMatch(/next approver in the policy/);
      expect(refusals.spend_authority_exceeded).not.toMatch(/siguiente persona aprobadora/);
    }
  });

  it("titles the finance refusal callout differently from its Refused badge", () => {
    expect(enFinance.common.refusedTitle).not.toBe(enShell.refusalOutcome.REFUSE);
    expect(esFinance.common.refusedTitle).not.toBe(esShell.refusalOutcome.REFUSE);
  });
});

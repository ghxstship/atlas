import { createTranslator } from "next-intl";
import { describe, expect, it } from "vitest";
import enUS from "../../../packages/i18n/messages/en-US/gateway.json";
import esUS from "../../../packages/i18n/messages/es-US/gateway.json";
import { signedOutApprovalProblem } from "@/components/tokens/signed-out-approval-problem";
import type { SignedOutApprovalResult } from "@/lib/actions/one-tap";

type Translate = (key: string, values?: Record<string, string | number>) => string;

/** The page's two translators over a catalog, collecting every lookup next-intl reports as an error. */
function translators(locale: string, messages: unknown) {
  const errors: string[] = [];
  const onError = (error: { code: string; message: string }) =>
    errors.push(`${error.code}: ${error.message}`);
  const all = { gateway: messages } as Record<string, unknown>;
  const make = (namespace: string) =>
    createTranslator({
      locale,
      messages: all,
      namespace,
      onError,
    } as never) as unknown as Translate;
  return {
    t: make("gateway.auth.actionLink.signedOut"),
    to: make("gateway.outcomes"),
    errors,
  };
}

const outcomes: SignedOutApprovalResult["outcome"][] = [
  "approval_link_ended",
  "approval_link_code_wrong",
  "approval_link_locked",
  "notification_action_used",
  "notification_action_expired",
  "notification_action_invalid",
  "notification_action_reason",
];

describe.each([
  ["en-US", enUS],
  ["es-US", esUS],
])("signedOutApprovalProblem (%s)", (locale, messages) => {
  it("looks up no message for a decided request, so next-intl reports nothing", () => {
    const { t, to, errors } = translators(locale, messages);
    expect(signedOutApprovalProblem({ outcome: "decided" }, t, to)).toBeNull();
    expect(errors).toEqual([]);
  });

  it("has no problem before a result, for a sent code or for a shown request", () => {
    const { t, to, errors } = translators(locale, messages);
    expect(signedOutApprovalProblem(null, t, to)).toBeNull();
    expect(signedOutApprovalProblem({ outcome: "code_sent" }, t, to)).toBeNull();
    expect(signedOutApprovalProblem({ outcome: "ok" }, t, to)).toBeNull();
    expect(errors).toEqual([]);
  });

  it("reads every other outcome from the catalog", () => {
    const { t, to, errors } = translators(locale, messages);
    for (const outcome of outcomes) {
      const problem = signedOutApprovalProblem({ outcome, attemptsLeft: 3 }, t, to);
      expect(problem, outcome).toBeTruthy();
      expect(problem, outcome).not.toContain("outcome.");
    }
    expect(signedOutApprovalProblem({ outcome: "refused" }, t, to)).toBeTruthy();
    expect(errors).toEqual([]);
  });
});

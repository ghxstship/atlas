/**
 * What Compass asks before anything else (legal issue 4, ADR 0156): the age, the Mobile EULA and, where they apply, the
 * Worker Terms, recorded with version, time and person in the same log web sign-up writes (app.legal_acceptances).
 * Google, Apple and email sign-ins all land here, since the question follows the session, not the way it started.
 *
 * The step needs the server: an answer only counts once the database has it. So a person who has never passed it is told
 * to connect. A person the server cleared before keeps working offline, and so does an install that already holds a
 * cached identity from before this step existed: stopping a worker's time clock on a site with no signal would do them
 * real harm, and the question comes as soon as the server answers.
 */
import type { LegalStanding } from "@xos/data/consent";
import type { LegalReacceptance } from "@xos/data/legal-reacceptance";

export interface GateDocument {
  readonly slug: string;
  readonly version: string;
}

/**
 * The documents the gate asks for. legal/index.yaml marks the Mobile EULA compass_user_at_first_sign_in and the Worker
 * Terms external_party_at_account_creation; test/legal-gate.test.ts fails when these versions drift from it.
 */
export const MOBILE_EULA: GateDocument = { slug: "mobile-eula", version: "1.0.0-draft" };
export const WORKER_TERMS: GateDocument = { slug: "worker-terms", version: "1.0.0-draft" };

/** What this person still owes. */
export interface LegalNeeds {
  readonly age: boolean;
  /** Documents never accepted, at the version in this build. */
  readonly documents: readonly GateDocument[];
  /** Announced new versions past their effective date: these hold the app. */
  readonly changes: readonly LegalReacceptance[];
}

/**
 * The announced changes Compass asks about: its own documents, which it can name and link. Anything else a person accepted
 * elsewhere is for that app to ask.
 */
export function askedInCompass(announced: readonly LegalReacceptance[]): LegalReacceptance[] {
  return announced.filter(
    (c) => c.documentSlug === MOBILE_EULA.slug || c.documentSlug === WORKER_TERMS.slug,
  );
}

export function legalNeeds(
  standing: LegalStanding,
  announced: readonly LegalReacceptance[],
): LegalNeeds {
  const accepted = new Set(standing.acceptedDocuments);
  const wanted = standing.workerTermsApply ? [MOBILE_EULA, WORKER_TERMS] : [MOBILE_EULA];
  return {
    age: !standing.ageConfirmed,
    documents: wanted.filter((d) => !accepted.has(d.slug)),
    changes: askedInCompass(announced).filter((c) => c.required),
  };
}

export function owesNothing(needs: LegalNeeds): boolean {
  return !needs.age && needs.documents.length === 0 && needs.changes.length === 0;
}

/** The versions an acceptance records: first acceptances, then the announced new versions. */
export function acceptancesOf(needs: LegalNeeds): GateDocument[] {
  return [
    ...needs.documents,
    ...needs.changes.map((c) => ({ slug: c.documentSlug, version: c.documentVersion })),
  ];
}

export type GateDecision =
  /** Nothing owed: open Compass. */
  | { readonly kind: "clear" }
  /** The server could not be asked, but this person may carry on; ask again when it answers. */
  | { readonly kind: "carry-on" }
  | { readonly kind: "ask"; readonly needs: LegalNeeds }
  /** The server could not be asked and nothing shows this person ever passed. */
  | { readonly kind: "needs-connection" };

export function decideGate(input: {
  /** What the server said, or null when it could not be asked. */
  readonly needs: LegalNeeds | null;
  /** The server cleared this person on this device before. */
  readonly clearedBefore: boolean;
  /** This device holds an identity resolved before, so Compass has opened for this person. */
  readonly cachedIdentity: boolean;
}): GateDecision {
  if (input.needs === null) {
    return input.clearedBefore || input.cachedIdentity
      ? { kind: "carry-on" }
      : { kind: "needs-connection" };
  }
  return owesNothing(input.needs) ? { kind: "clear" } : { kind: "ask", needs: input.needs };
}

/** How the gate shows an account the database could not close (app.refuse_minimum_age). */
export type HeldReason = "legalHold" | "onShift" | "soleOwner" | "other";

export function heldReason(code: string): HeldReason {
  if (code === "account_delete_legal_hold") return "legalHold";
  if (code === "account_delete_on_shift") return "onShift";
  if (code === "account_delete_sole_owner") return "soleOwner";
  return "other";
}

// The AI choice ---------------------------------------------------------------------------------------------------------

/**
 * The version of the words the first-use AI disclosure shows (compass.aiDisclosure.*). Change it when what is sent or who
 * receives it changes: everyone who allowed is then asked again. A decline stands until the person changes it.
 */
export const AI_DISCLOSURE_VERSION = "2026-11-06";

/** What Compass acts on: Unknown means ask first and send nothing. */
export type AiChoiceState = "unknown" | "Allowed" | "Declined";

export function aiChoiceState(
  choice: "Allowed" | "Declined" | null,
  version: string | null,
  current: string = AI_DISCLOSURE_VERSION,
): AiChoiceState {
  if (choice === "Declined") return "Declined";
  return choice === "Allowed" && version === current ? "Allowed" : "unknown";
}

import { readFileSync } from "node:fs";
import type { LegalStanding } from "@xos/data/consent";
import type { LegalReacceptance } from "@xos/data/legal-reacceptance";
import { getMessages } from "@xos/i18n";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import {
  acceptancesOf,
  AI_DISCLOSURE_VERSION,
  aiChoiceState,
  decideGate,
  heldReason,
  legalNeeds,
  MOBILE_EULA,
  owesNothing,
  WORKER_TERMS,
} from "../src/domain/legalGate";

const stored = new Map<string, string>();
vi.mock("expo-secure-store", () => ({
  getItemAsync: (key: string) => Promise.resolve(stored.get(key) ?? null),
  setItemAsync: (key: string, value: string) => {
    stored.set(key, value);
    return Promise.resolve();
  },
  deleteItemAsync: (key: string) => {
    stored.delete(key);
    return Promise.resolve();
  },
}));

const { forgetGate, readGate, rememberAiChoice } = await import("../src/runtime/legalGate");

const standing = (over: Partial<LegalStanding> = {}): LegalStanding => ({
  ageConfirmed: true,
  acceptedDocuments: ["mobile-eula"],
  workerTermsApply: false,
  aiChoice: null,
  aiDisclosureVersion: null,
  ...over,
});

const change = (over: Partial<LegalReacceptance> = {}): LegalReacceptance => ({
  documentSlug: "mobile-eula",
  documentVersion: "2.0.0",
  summary: "The venue clause changes.",
  noticedAt: "2026-11-01T00:00:00Z",
  effectiveOn: "2026-12-01",
  required: false,
  ...over,
});

describe("what a sign-in owes", () => {
  it("asks a new person the age, the Mobile EULA and the Worker Terms", () => {
    const needs = legalNeeds(
      standing({ ageConfirmed: false, acceptedDocuments: [], workerTermsApply: true }),
      [],
    );
    expect(needs).toEqual({ age: true, documents: [MOBILE_EULA, WORKER_TERMS], changes: [] });
    expect(owesNothing(needs)).toBe(false);
    expect(acceptancesOf(needs)).toEqual([MOBILE_EULA, WORKER_TERMS]);
  });

  it("asks a member with no engagement only for the Mobile EULA", () => {
    expect(legalNeeds(standing({ acceptedDocuments: [] }), []).documents).toEqual([MOBILE_EULA]);
  });

  it("asks nothing of someone who has answered, at any version", () => {
    const needs = legalNeeds(standing(), []);
    expect(owesNothing(needs)).toBe(true);
    expect(acceptancesOf(needs)).toEqual([]);
  });

  it("asks someone who confirmed only the earlier age again", () => {
    expect(legalNeeds(standing({ ageConfirmed: false }), []).age).toBe(true);
  });

  it("stops only for a change past its effective date, and records the announced version", () => {
    expect(owesNothing(legalNeeds(standing(), [change()]))).toBe(true);
    const needs = legalNeeds(standing(), [change({ required: true })]);
    expect(owesNothing(needs)).toBe(false);
    expect(acceptancesOf(needs)).toEqual([{ slug: "mobile-eula", version: "2.0.0" }]);
  });
});

describe("deciding the gate", () => {
  const clear = legalNeeds(standing(), []);
  const owed = legalNeeds(standing({ ageConfirmed: false }), []);

  it("follows the server whenever it answers, whatever the device remembers", () => {
    expect(decideGate({ needs: clear, clearedBefore: false, cachedIdentity: false }).kind).toBe(
      "clear",
    );
    expect(decideGate({ needs: owed, clearedBefore: true, cachedIdentity: true })).toEqual({
      kind: "ask",
      needs: owed,
    });
  });

  it("says a connection is needed when nothing shows the person ever answered", () => {
    expect(decideGate({ needs: null, clearedBefore: false, cachedIdentity: false }).kind).toBe(
      "needs-connection",
    );
  });

  it("never stops the time clock of someone Compass already opened for", () => {
    expect(decideGate({ needs: null, clearedBefore: true, cachedIdentity: false }).kind).toBe(
      "carry-on",
    );
    expect(decideGate({ needs: null, clearedBefore: false, cachedIdentity: true }).kind).toBe(
      "carry-on",
    );
  });
});

describe("what the device remembers", () => {
  beforeEach(() => stored.clear());

  function client(answers: { standing: unknown; pending?: unknown; failing?: boolean }) {
    return {
      rpc: (fn: string) =>
        Promise.resolve(
          answers.failing
            ? { data: null, error: { code: "PGRST000", message: "fetch failed" } }
            : { data: fn === "my_legal_standing" ? answers.standing : (answers.pending ?? []), error: null },
        ),
    } as never;
  }
  const answered = {
    age_confirmed: true,
    accepted_documents: ["mobile-eula"],
    worker_terms_apply: false,
    ai_choice: "Allowed",
    ai_disclosure_version: AI_DISCLOSURE_VERSION,
  };

  it("remembers the clearance and the AI choice, so the person can work offline", async () => {
    const online = await readGate(client({ standing: answered }), "u1", () => Promise.resolve(false));
    expect(online.decision.kind).toBe("clear");
    expect(online.aiChoice).toBe("Allowed");
    const offline = await readGate(client({ standing: null, failing: true }), "u1", () =>
      Promise.resolve(false),
    );
    expect(offline.decision.kind).toBe("carry-on");
    expect(offline.aiChoice).toBe("Allowed");
  });

  it("asks a new person, and offline tells them to connect", async () => {
    const asked = await readGate(
      client({ standing: { ...answered, age_confirmed: false } }),
      "u2",
      () => Promise.resolve(false),
    );
    expect(asked.decision.kind).toBe("ask");
    const offline = await readGate(client({ standing: null, failing: true }), "u3", () =>
      Promise.resolve(false),
    );
    expect(offline.decision.kind).toBe("needs-connection");
    expect(offline.aiChoice).toBe("unknown");
  });

  it("lets an install with a cached identity keep working until the server answers", async () => {
    const offline = await readGate(client({ standing: null, failing: true }), "u4", () =>
      Promise.resolve(true),
    );
    expect(offline.decision.kind).toBe("carry-on");
  });

  it("splits announced changes into a stop and a prompt", async () => {
    const pending = [
      {
        document_slug: "mobile-eula",
        document_version: "2.0.0",
        summary: "S",
        noticed_at: "2026-11-01T00:00:00Z",
        effective_on: "2026-12-01",
        required: false,
      },
    ];
    const reading = await readGate(client({ standing: answered, pending }), "u5", () =>
      Promise.resolve(false),
    );
    expect(reading.decision.kind).toBe("clear");
    expect(reading.upcoming.map((c) => c.documentVersion)).toEqual(["2.0.0"]);
  });

  it("forgets everything at sign-out", async () => {
    await readGate(client({ standing: answered }), "u6", () => Promise.resolve(false));
    expect(stored.size).toBeGreaterThan(0);
    await forgetGate("u6");
    expect(stored.size).toBe(0);
  });

  it("ignores a remembered choice it cannot read, and forgets a cleared one", async () => {
    stored.set("xos.compass.ai-choice.u7", "not json");
    const offline = await readGate(client({ standing: null, failing: true }), "u7", () =>
      Promise.resolve(true),
    );
    expect(offline.aiChoice).toBe("unknown");
    await rememberAiChoice("u7", "Declined", AI_DISCLOSURE_VERSION);
    expect(
      (await readGate(client({ standing: null, failing: true }), "u7", () => Promise.resolve(true)))
        .aiChoice,
    ).toBe("Declined");
    await rememberAiChoice("u7", null, null);
    expect(stored.has("xos.compass.ai-choice.u7")).toBe(false);
  });
});

describe("an account the server could not close", () => {
  it("names why in the person's language", () => {
    expect(heldReason("account_delete_legal_hold")).toBe("legalHold");
    expect(heldReason("account_delete_on_shift")).toBe("onShift");
    expect(heldReason("account_delete_sole_owner")).toBe("soleOwner");
    expect(heldReason("something_new")).toBe("other");
  });
});

describe("the AI choice", () => {
  it("asks first when no choice is recorded, or the words changed since they allowed", () => {
    expect(aiChoiceState(null, null)).toBe("unknown");
    expect(aiChoiceState("Allowed", AI_DISCLOSURE_VERSION)).toBe("Allowed");
    expect(aiChoiceState("Allowed", "2020-01-01")).toBe("unknown");
  });

  it("keeps a decline until the person changes it, whatever the words say now", () => {
    expect(aiChoiceState("Declined", "2020-01-01")).toBe("Declined");
  });
});

describe("the documents and the words", () => {
  const registry = (
    parse(readFileSync(new URL("../../../legal/index.yaml", import.meta.url), "utf8")) as {
      documents: { slug: string; version: string; acceptance_by: string[] }[];
    }
  ).documents;

  it("asks for the versions and audiences the legal registry names", () => {
    const eula = registry.find((d) => d.slug === MOBILE_EULA.slug);
    expect(eula?.acceptance_by).toContain("compass_user_at_first_sign_in");
    expect(eula?.version).toBe(MOBILE_EULA.version);
    const terms = registry.find((d) => d.slug === WORKER_TERMS.slug);
    expect(terms?.version).toBe(WORKER_TERMS.version);
  });

  const flatten = (value: unknown, prefix = ""): [string, string][] =>
    typeof value === "string"
      ? [[prefix, value]]
      : Object.entries(value as Record<string, unknown>).flatMap(([k, v]) =>
          flatten(v, prefix ? `${prefix}.${k}` : k),
        );
  const compass = (locale: "en-US" | "es-US") =>
    (getMessages(locale) as { compass: Record<string, unknown> }).compass;

  it("has every question in English and in real Spanish", () => {
    for (const block of ["legalGate", "aiDisclosure"]) {
      const en = new Map(flatten(compass("en-US")[block]));
      const es = new Map(flatten(compass("es-US")[block]));
      expect([...es.keys()].sort()).toEqual([...en.keys()].sort());
      for (const [key, text] of en) expect(es.get(key), key).not.toBe(text);
    }
  });

  it("states no rule in the age question before it is answered", () => {
    const age = compass("en-US")["legalGate"] as { age: Record<string, string> };
    expect(age.age["title"]).not.toMatch(/18|must|only/i);
    expect(age.age["sentence"]).not.toMatch(/18|must|only/i);
  });

  it("names the provider category and what goes to it", () => {
    const ai = compass("en-US")["aiDisclosure"] as Record<string, string>;
    expect(ai["provider"]).toMatch(/third-party AI provider/);
    expect(ai["sent"]).toMatch(/questions/);
    expect(ai["sent"]).toMatch(/receipt photos/);
  });
});

import { describe, expect, it } from "vitest";
import { handlers as identity } from "../src/handlers/identity.ts";
import { contractApp, expectContract, testContext } from "./support/contract.ts";
import { memoryDb, requests, success } from "./support/memory-db.ts";

const PERSON = testContext().personId as string;
const OTHER = "0192f1e2-7c3a-7b4d-9e8f-000000164001";
const GRANT = "0192f1e2-7c3a-7b4d-9e8f-000000164002";
const ATTESTED = "0192f1e2-7c3a-7b4d-9e8f-000000164003";

const row = (over: Record<string, unknown>) => ({
  id: GRANT,
  category: "Accessibility",
  basis: "Own Consent",
  person_id: PERSON,
  account_id: null,
  guest_list_entry_id: null,
  org_id: null,
  notice_version: "2026-11-06",
  locale: "en-US",
  surface: "API",
  authority_confirmed: false,
  notice_confirmed: false,
  given_by: PERSON,
  given_at: "2026-11-06T10:00:00Z",
  withdrawn_at: null,
  withdrawn_by: null,
  created_at: "2026-11-06T10:00:00Z",
  updated_at: "2026-11-06T10:00:00Z",
  ...over,
});

function setup() {
  const consents = [row({}), row({ id: ATTESTED, basis: "Attested Authority", given_by: OTHER })];
  const db = memoryDb(
    { sensitive_data_consents: consents },
    {
      give_sensitive_consent: () => GRANT,
      withdraw_sensitive_consent: () => {
        (consents[0] as Record<string, unknown>)["withdrawn_at"] = "2026-11-07T10:00:00Z";
        return true;
      },
      remove_sensitive_entry: () => {
        (consents[1] as Record<string, unknown>)["withdrawn_at"] = "2026-11-07T10:00:00Z";
        return null;
      },
    },
  );
  return { db, http: requests(contractApp({ handlers: [identity], db })) };
}

describe("Identity: consent for sensitive data (ADR 0164)", () => {
  it("records a consent as coming from the API, with the wording's version and language", async () => {
    const { db, http } = setup();
    const created = await success(
      http.post("/sensitive-consents", {
        category: "Accessibility",
        notice_version: "2026-11-06",
        locale: "en-US",
      }),
    );
    await expectContract(created, "sensitiveConsents.create");
    expect(db.calls[0]).toMatchObject({
      name: "give_sensitive_consent",
      args: {
        p_category: "Accessibility",
        p_notice_version: "2026-11-06",
        p_locale: "en-US",
        p_surface: "API",
      },
    });
  });

  it("lists what the person's grants are", async () => {
    const { http } = setup();
    await expectContract(await success(http.get("/sensitive-consents")), "sensitiveConsents.list");
  });

  it("withdraws the person's own through the withdrawal, which clears the values", async () => {
    const { db, http } = setup();
    await success(http.post(`/sensitive-consents/${GRANT}/withdraw`, {}));
    expect(db.calls.map((c) => c.name)).toContain("withdraw_sensitive_consent");
  });

  it("removes an attestation about the person through its own RPC", async () => {
    const { db, http } = setup();
    await success(http.post(`/sensitive-consents/${ATTESTED}/withdraw`, {}));
    expect(db.calls.map((c) => c.name)).toEqual(["remove_sensitive_entry"]);
  });
});

import { describe, expect, it } from "vitest";
import { handlers as advancing } from "../src/handlers/advancing.ts";
import { handlers as identity } from "../src/handlers/identity.ts";
import { contractApp, expectContract, testContext } from "./support/contract.ts";
import { memoryDb, requests, success, tenantRow } from "./support/memory-db.ts";

const PERSON = testContext().personId as string;
const OTHER = "0192f1e2-7c3a-7b4d-9e8f-000000164001";
const GRANT = "0192f1e2-7c3a-7b4d-9e8f-000000164002";
const ATTESTED = "0192f1e2-7c3a-7b4d-9e8f-000000164003";
const RECORD = "0192f1e2-7c3a-7b4d-9e8f-000000164004";
const GUEST = "0192f1e2-7c3a-7b4d-9e8f-000000164005";
const PROJECT = "0192f1e2-7c3a-7b4d-9e8f-000000164006";
const ORG = testContext().org?.id as string;

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
    {
      sensitive_data_consents: consents,
      sensitive_field_records: [
        {
          id: RECORD,
          field_code: "allergies",
          person_id: PERSON,
          account_id: null,
          guest_list_entry_id: null,
          consent_id: GRANT,
          entered_by: PERSON,
          entered_at: "2026-11-06T10:00:00Z",
          changed_at: "2026-11-06T10:00:00Z",
          cleared_at: null,
          awaiting_since: null,
        },
      ],
      guest_list_entries: [
        tenantRow(GUEST, ORG, {
          project_id: PROJECT,
          scope_node_id: null,
          person_id: null,
          counterparty_id: null,
          engagement_id: null,
          guest_name: "Jordan Vale",
          plus_ones: 0,
          note: null,
          entry_state: "Requested",
          decided_at: null,
          decided_by: null,
          checked_in_at: null,
          checked_in_by: null,
        }),
      ],
    },
    {
      give_sensitive_consent: () => GRANT,
      set_guest_care_needs: () => "needs",
      clear_guest_care_needs: () => null,
      read_guest_care_needs: () => [
        {
          guest_list_entry_id: GUEST,
          guest_name: "Jordan Vale",
          dietary_needs: ["Vegan"],
          allergies: "Peanuts",
          dietary_notes: null,
          accessibility_needs: [],
          accessibility_notes: null,
        },
      ],
      sensitive_consent_report: () => [
        {
          subject_kind: "Guest",
          subject_id: GUEST,
          subject_name: "Jordan Vale",
          category: "Dietary and Allergies",
          field_code: "guest_allergies",
          standing: "Attested",
          notice_version: "2026-11-06",
          given_at: "2026-11-06T10:00:00Z",
          given_by_name: "Carol Nguyen",
          withdrawn_at: null,
        },
      ],
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
  return { db, http: requests(contractApp({ handlers: [identity, advancing], db })) };
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
    await expectContract(
      await success(http.get(`/sensitive-consents/${GRANT}`)),
      "sensitiveConsents.get",
    );
    await expectContract(
      await success(http.get("/sensitive-field-records")),
      "sensitiveFieldRecords.list",
    );
  });

  it("withdraws the person's own through the withdrawal, which clears the values", async () => {
    const { db, http } = setup();
    const withdrawn = await success(http.post(`/sensitive-consents/${GRANT}/withdraw`, {}));
    await expectContract(withdrawn, "sensitiveConsents.withdraw");
    expect(db.calls.map((c) => c.name)).toContain("withdraw_sensitive_consent");
  });

  it("removes an attestation about the person through its own RPC", async () => {
    const { db, http } = setup();
    await success(http.post(`/sensitive-consents/${ATTESTED}/withdraw`, {}));
    expect(db.calls.map((c) => c.name)).toEqual(["remove_sensitive_entry"]);
  });

  it("reports consent state per field, never a value", async () => {
    const { http } = setup();
    const page = (await expectContract(
      await success(http.get("/sensitive-consents/report")),
      "sensitiveConsents.report",
    )) as { data: Record<string, unknown>[] };
    expect(page.data[0]).not.toHaveProperty("allergies");
    expect(page.data[0]?.["standing"]).toBe("Attested");
  });

  it("sets a guest's needs under the caller's attestation, as coming from the API", async () => {
    const { db, http } = setup();
    const set = await success(
      http.post(`/guest-list-entries/${GUEST}/set-needs`, {
        dietary_needs: ["Vegan"],
        authority_confirmed: true,
        notice_confirmed: true,
        dietary_notice_version: "2026-11-06",
        locale: "en-US",
      }),
    );
    await expectContract(set, "guestListEntries.setNeeds");
    expect(db.calls[0]).toMatchObject({
      name: "set_guest_care_needs",
      args: {
        p_authority_confirmed: true,
        p_notice_confirmed: true,
        p_surface: "API",
        p_dietary_notice_version: "2026-11-06",
        p_accessibility_notice_version: null,
      },
    });
  });

  it("removes a guest's needs, and reads them for a holder of the capability", async () => {
    const { http } = setup();
    const cleared = await success(http.post(`/guest-list-entries/${GUEST}/clear-needs`, {}));
    await expectContract(cleared, "guestListEntries.clearNeeds");
    await expectContract(
      await success(http.get(`/guest-list-entries/needs?project_id=${PROJECT}`)),
      "guestListEntries.needs",
    );
  });
});

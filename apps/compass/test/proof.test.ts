import { getMessages } from "@xos/i18n";
import { TABLE_RULES, type Mutation, type Row } from "@xos/sync";
import { describe, expect, it } from "vitest";
import { sourcesFor } from "../src/data/sources";
import type { EngagementSummary } from "../src/domain/access";
import { EXTERNAL_PAGES } from "../src/domain/external";
import {
  buildProofPhoto,
  photoCounts,
  PROOF_PHOTO_RPC,
  PROOF_PHOTOS_TABLE,
  proofEngagement,
  proofPhotoPath,
} from "../src/domain/proof";
import { summarizeMutation } from "../src/domain/queue-summary";

// Sponsors' proof-of-performance photos from Compass (A140, migration 2332).
const ORG = "01920000-0000-7000-8000-00000000000a";
const PROJECT = "01920000-0000-7000-8000-000000001001";
const sponsor: EngagementSummary = {
  id: "01920000-0000-7000-8000-0000000000e1",
  orgId: ORG,
  orgName: "Demo Productions",
  projectId: PROJECT,
  projectName: "Northwind Summer Series",
  roleType: "sponsor",
  state: "Active",
};
const T0 = Date.UTC(2027, 5, 12, 19, 30);
const PHOTO_ID = "0199ffff-0000-7000-8000-000000000001";

describe("proof-of-performance photos (A140)", () => {
  it("captures only on the person's Sponsor engagement on the entitlement's project while it is active", () => {
    expect(proofEngagement([sponsor], PROJECT)).toBe(sponsor);
    expect(proofEngagement([{ ...sponsor, state: "Closing" }], PROJECT)?.id).toBe(sponsor.id);
    for (const state of ["Onboarding", "Blocked", "Complete", "Canceled"] as const)
      expect(proofEngagement([{ ...sponsor, state }], PROJECT), state).toBeNull();
    expect(proofEngagement([{ ...sponsor, roleType: "vendor" }], PROJECT)).toBeNull();
    expect(proofEngagement([sponsor], "another-project")).toBeNull();
    expect(proofEngagement([sponsor], null)).toBeNull();
  });

  it("stores the photo in the engagement's field-media folder and records it once through the outbox", () => {
    expect(proofPhotoPath(sponsor, PHOTO_ID)).toBe(
      `${ORG}/proof-of-performance/${sponsor.id}/${PHOTO_ID}.jpg`,
    );
    const input = buildProofPhoto(
      {
        entitlementId: "se-1",
        engagement: sponsor,
        localUri: "file:///photo.jpg",
        capturedAt: "2027-06-12T19:29:00Z",
      },
      T0,
      () => PHOTO_ID,
    );
    const path = proofPhotoPath(sponsor, PHOTO_ID);
    expect(input).toMatchObject({
      op: "rpc",
      target: PROOF_PHOTO_RPC,
      table: PROOF_PHOTOS_TABLE,
      rowId: PHOTO_ID,
      policy: "append",
      payload: {
        p_id: PHOTO_ID,
        p_sponsor_entitlement_id: "se-1",
        p_media_uri: path,
        p_captured_at: "2027-06-12T19:29:00Z",
        storage_path: path,
        local_uri: "file:///photo.jpg",
      },
      optimistic: { id: PHOTO_ID, sponsor_entitlement_id: "se-1", project_id: PROJECT },
    });
    // The default id is a fresh UUID v7.
    const minted = buildProofPhoto(
      { entitlementId: "se-1", engagement: sponsor, localUri: "f", capturedAt: "x" },
      T0,
    );
    expect(minted.rowId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/);

    // The offline queue says what it is in both languages, never the path.
    const queued = { ...input, target: PROOF_PHOTO_RPC, queuedAt: new Date(T0).toISOString() };
    const summary = summarizeMutation(queued as unknown as Mutation, {
      time: (iso) => new Date(iso).toISOString().slice(11, 16),
      day: (iso) => iso.slice(0, 10),
      projectName: () => null,
      zoneName: () => null,
      punchAction: (k) => k,
      kind: (t) => t,
    });
    expect(summary).toEqual({ key: "proofPhoto", values: { time: "19:29" } });
    for (const locale of ["en-US", "es-US"] as const) {
      const catalog = getMessages(locale) as unknown as {
        compass: { queue: { summary: Record<string, string> } };
      };
      expect(catalog.compass.queue.summary["proofPhoto"]).toContain("{time}");
    }
  });

  it("shows how many photos each entitlement has, from the device's rows", () => {
    const rows = [
      { id: "a", sponsor_entitlement_id: "se-1" },
      { id: "b", sponsor_entitlement_id: "se-1" },
      { id: "c", sponsor_entitlement_id: "se-2" },
      { id: "d" },
    ] as unknown as Row[];
    expect([...photoCounts(rows)]).toEqual([
      ["se-1", 2],
      ["se-2", 1],
    ]);
    const page = EXTERNAL_PAGES["proof-of-performance"];
    expect(page.tables).toContain(PROOF_PHOTOS_TABLE);
    const sections = page.build({
      rows: (table) =>
        table === "sponsor_entitlements"
          ? ([{ id: "se-1", project_id: PROJECT, description: "Banner" }] as unknown as Row[])
          : table === PROOF_PHOTOS_TABLE
            ? rows
            : [],
      projectId: PROJECT,
      personId: "p",
      engagements: [sponsor],
      zoneOf: () => null,
      todayOf: () => "2027-06-12",
    });
    expect(sections[0]?.items[0]?.facts[0]).toEqual({
      kind: "label",
      key: "compassExternal.proof.photosOther",
      values: { count: 2 },
    });
  });

  it("downloads the sponsor's photos, kept to their engagements on the device", () => {
    const source = sourcesFor("sponsor").find((s) => s.table === PROOF_PHOTOS_TABLE);
    expect(source).toMatchObject({
      schema: "api_external",
      relation: "proof_of_performance_photos",
    });
    expect(sourcesFor("crew").some((s) => s.table === PROOF_PHOTOS_TABLE)).toBe(false);
    expect(TABLE_RULES.find((r) => r.table === PROOF_PHOTOS_TABLE)?.anyOf[0]).toMatchObject({
      column: "engagement_id",
      key: "engagementIds",
    });
  });
});

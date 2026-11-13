import { describe, expect, it, vi } from "vitest";
import type { XosClient } from "@xos/data";
import type { IncidentSeverity } from "@xos/data/incidents";

vi.mock("@/lib/observability", () => ({ observability: { logger: { error: () => undefined } } }));

const { incidentMediaPath, uploadIncidentMedia, INCIDENT_MEDIA_MAX_BYTES } =
  await import("../lib/incidents/media");
const { reportSeverityOptions } = await import("../lib/incidents/severity-options");

const ORG = "0193a000-0000-7000-8000-0000000000a1";
const INCIDENT = "0193a000-0000-7000-8000-0000000000b2";
const ID = "0193a000-0000-7000-8000-0000000000c3";

/** A client whose storage records what was uploaded where. */
function storage(error: unknown = null) {
  const uploads: { bucket: string; path: string; contentType: string }[] = [];
  const db = {
    storage: {
      from: (bucket: string) => ({
        upload: async (path: string, _body: ArrayBuffer, options: { contentType: string }) => {
          uploads.push({ bucket, path, contentType: options.contentType });
          return { data: error ? null : { path }, error };
        },
      }),
    },
  } as unknown as XosClient;
  return { db, uploads };
}

describe("Attach media on an incident (crawl 4.9)", () => {
  it("names the object as Compass does, under the incident in field-media", () => {
    expect(incidentMediaPath(ORG, INCIDENT, "image/jpeg", ID)).toBe(
      `${ORG}/incidents/${INCIDENT}/${ID}.jpg`,
    );
    expect(incidentMediaPath(ORG, INCIDENT, "video/quicktime", ID)).toBe(
      `${ORG}/incidents/${INCIDENT}/${ID}.mov`,
    );
    expect(incidentMediaPath(ORG, INCIDENT, "application/pdf", ID)).toBeNull();
  });

  it("uploads the chosen file and returns the path and id to attach", async () => {
    const { db, uploads } = storage();
    const file = new File([new Uint8Array([1, 2, 3])], "gate.png", { type: "image/png" });
    expect(
      await uploadIncidentMedia(db, { orgId: ORG, incidentId: INCIDENT, file, id: ID }),
    ).toEqual({ ok: true, id: ID, path: `${ORG}/incidents/${INCIDENT}/${ID}.png` });
    expect(uploads).toEqual([
      {
        bucket: "field-media",
        path: `${ORG}/incidents/${INCIDENT}/${ID}.png`,
        contentType: "image/png",
      },
    ]);
  });

  it("refuses no file, another type or a file over the bucket's limit, before uploading", async () => {
    const { db, uploads } = storage();
    const base = { orgId: ORG, incidentId: INCIDENT };
    expect(await uploadIncidentMedia(db, { ...base, file: null })).toEqual({
      ok: false,
      error: "fileInput",
    });
    expect(await uploadIncidentMedia(db, { ...base, file: "org/incidents/gate.jpg" })).toEqual({
      ok: false,
      error: "fileInput",
    });
    expect(
      await uploadIncidentMedia(db, {
        ...base,
        file: new File(["%PDF"], "notes.pdf", { type: "application/pdf" }),
      }),
    ).toEqual({ ok: false, error: "mediaType" });
    const big = new File([new Uint8Array(1)], "big.mp4", { type: "video/mp4" });
    Object.defineProperty(big, "size", { value: INCIDENT_MEDIA_MAX_BYTES + 1 });
    expect(await uploadIncidentMedia(db, { ...base, file: big })).toEqual({
      ok: false,
      error: "fileSize",
    });
    expect(uploads).toEqual([]);
  });

  it("reports a refused upload", async () => {
    const { db } = storage({ message: "new row violates row-level security policy" });
    const file = new File([new Uint8Array([1])], "gate.jpg", { type: "image/jpeg" });
    expect(await uploadIncidentMedia(db, { orgId: ORG, incidentId: INCIDENT, file })).toEqual({
      ok: false,
      error: "mediaUpload",
    });
  });
});

describe("Report incident severity (crawl 4.9)", () => {
  const severities: IncidentSeverity[] = [
    { id: "ENM-100", code: "1", label: "Level 1 - Critical", sortOrder: 1, isCritical: true },
    { id: "ENM-104", code: "5", label: "Level 5 - Advisory", sortOrder: 5, isCritical: false },
  ];

  it("starts on an empty prompt, so nothing is preselected as critical", () => {
    const options = reportSeverityOptions(severities, "Choose a severity");
    expect(options[0]).toEqual({ value: "", label: "Choose a severity" });
    expect(options.slice(1).map((o) => o.value)).toEqual(["ENM-100", "ENM-104"]);
  });
});

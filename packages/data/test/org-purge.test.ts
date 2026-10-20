import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildDeletionCertificateModel,
  certificateKey,
  deletionCertificateFileName,
  deletionCertificateVersion,
  renderDeletionCertificate,
} from "../src/documents/deletion-certificate.ts";
import {
  batchObjects,
  certificateObjectName,
  runDeletionCertificates,
  supabasePurgeStorage,
  supabasePurgeStore,
  toClaimedCertificate,
  type ClaimedCertificate,
  type PurgeStorage,
  type PurgeStore,
  type StorageObjectRef,
} from "../src/org-purge.ts";
import type { ReportEmail, ReportMailer } from "../src/report-deliveries.ts";

/** A79 (migration 1351): the org-lifecycle worker's share of the day-90 deletion, with fake ports throughout. */

const messages = (locale: string) =>
  JSON.parse(
    readFileSync(new URL(`../../i18n/messages/${locale}/documents.json`, import.meta.url), "utf8"),
  ) as unknown;

const base: ClaimedCertificate = {
  id: "0192a000-0000-7000-8000-00000000c001",
  deletedOrgId: "0192a000-0000-7000-8000-0000000000b1",
  orgName: "Harbor Lights Productions",
  orgSlug: "harbor-lights",
  basis: "cancellation",
  requestedAt: "2026-07-10T12:00:00Z",
  dueAt: "2026-10-08T12:00:00Z",
  purgedAt: "",
  tablesPurged: 0,
  rowsPurged: 0,
  storageObjectsDeleted: 0,
  ownerName: "Xavier Dubois",
  ownerEmail: "xavier@harborlights.example",
  locale: "en-US",
  storageClearedAt: null,
  issuedAt: null,
  documentObject: null,
  deliveredAt: null,
  purged: false,
};

const purged: ClaimedCertificate = {
  ...base,
  purgedAt: "2026-10-08T13:23:00Z",
  tablesPurged: 41,
  rowsPurged: 1820,
  storageObjectsDeleted: 12,
  storageClearedAt: "2026-10-08T12:30:00Z",
  purged: true,
};

function fakeStore(claimed: ClaimedCertificate[], objects: StorageObjectRef[][] = []) {
  const log: string[] = [];
  const store: PurgeStore = {
    async claim() {
      return claimed;
    },
    async storageObjects() {
      return objects.shift() ?? [];
    },
    async recordStorageCleared(id, deleted) {
      log.push(`cleared ${id} ${deleted}`);
      return objects.length === 0;
    },
    async recordIssued(id, object, sha) {
      log.push(`issued ${id} ${object} ${sha.length}`);
    },
    async recordDelivered(id, messageId) {
      log.push(`delivered ${id} ${messageId}`);
    },
    async release(id, error) {
      log.push(`release ${id} ${error}`);
    },
  };
  return { store, log };
}

function fakeStorage(files: Map<string, Uint8Array> = new Map()) {
  const removed: string[][] = [];
  const storage: PurgeStorage = {
    async remove(bucket, names) {
      removed.push([bucket, ...names]);
      return names.length;
    },
    async upload(bucket, name, bytes) {
      files.set(`${bucket}/${name}`, bytes);
    },
    async download(bucket, name) {
      const file = files.get(`${bucket}/${name}`);
      if (!file) throw new Error("missing");
      return file;
    },
  };
  return { storage, removed, files };
}

const fakeMailer = () => {
  const sent: ReportEmail[] = [];
  const mailer: ReportMailer = {
    name: "fake",
    async send(email) {
      sent.push(email);
      return { messageId: `msg-${sent.length}` };
    },
  };
  return { mailer, sent };
};

const copy = () => ({
  subject: ({ org }: { org: string }) => `Deletion certificate for ${org}`,
  text: ({ org, date, id }: { org: string; date: string; id: string }) =>
    `The data of ${org} was deleted on ${date}.\n\nCertificate ${id} & <attached>.`,
  date: (iso: string) => iso.slice(0, 10),
});

const render = async (c: ClaimedCertificate) => ({
  bytes: new TextEncoder().encode(`%PDF certificate ${c.id}`),
  fileName: deletionCertificateFileName(c),
});

describe("storage before the purge", () => {
  it("deletes the org's objects through the Storage API in batches per bucket, then records the storage clear", async () => {
    const many = Array.from({ length: 150 }, (_, i) => ({
      bucket: "attachments",
      name: `${base.deletedOrgId}/f${i}`,
    }));
    const { store, log } = fakeStore(
      [base],
      [[...many, { bucket: "org-brand", name: `${base.deletedOrgId}/logo.png` }]],
    );
    const { storage, removed } = fakeStorage();
    const { mailer } = fakeMailer();
    const results = await runDeletionCertificates({
      store,
      storage,
      render,
      mailer,
      copy,
      worker: "w",
    });
    expect(results).toEqual([{ id: base.id, outcome: "storage-cleared", deleted: 151 }]);
    expect(removed.map((r) => [r[0], r.length - 1])).toEqual([
      ["attachments", 100],
      ["attachments", 50],
      ["org-brand", 1],
    ]);
    expect(log).toEqual([`cleared ${base.id} 151`]);
  });

  it("reports storage still pending when new objects keep appearing", async () => {
    const { store } = fakeStore(
      [base],
      [[{ bucket: "attachments", name: "a" }], [{ bucket: "attachments", name: "b" }]],
    );
    const pending: PurgeStore = { ...store, recordStorageCleared: async () => false };
    const { storage } = fakeStorage();
    const results = await runDeletionCertificates({
      store: pending,
      storage,
      render,
      mailer: fakeMailer().mailer,
      copy,
      worker: "w",
    });
    expect(results[0]?.outcome).toBe("storage-pending");
  });

  it("batches objects by bucket", () => {
    expect(
      batchObjects(
        [
          { bucket: "b", name: "1" },
          { bucket: "a", name: "2" },
          { bucket: "b", name: "3" },
        ],
        1,
      ).map((g) => g.map((o) => o.name)),
    ).toEqual([["2"], ["1"], ["3"]]);
  });
});

describe("after the purge", () => {
  it("stores the certificate PDF with its hash and emails it to the former Owner", async () => {
    const { store, log } = fakeStore([purged]);
    const { storage, files } = fakeStorage();
    const { mailer, sent } = fakeMailer();
    const results = await runDeletionCertificates({
      store,
      storage,
      render,
      mailer,
      copy,
      worker: "w",
    });
    expect(results).toEqual([{ id: purged.id, outcome: "delivered" }]);
    expect(files.has(`deletion-certificates/${certificateObjectName(purged.id)}`)).toBe(true);
    expect(log).toEqual([
      `issued ${purged.id} ${purged.id}.pdf 64`,
      `delivered ${purged.id} msg-1`,
    ]);
    expect(sent[0]).toMatchObject({
      to: "xavier@harborlights.example",
      toName: "Xavier Dubois",
      subject: "Deletion certificate for Harbor Lights Productions",
      attachment: {
        contentType: "application/pdf",
        filename: `deletion-certificate-harbor-lights-${certificateKey(purged.id)}-letter.pdf`,
      },
    });
    expect(sent[0]?.html).toBe(
      `<p>The data of Harbor Lights Productions was deleted on 2026-10-08.</p><p>Certificate ${purged.id} &amp; &lt;attached&gt;.</p>`,
    );
  });

  it("resends a stored certificate without rendering it again", async () => {
    const stored = new TextEncoder().encode("%PDF stored");
    const { store } = fakeStore([
      { ...purged, issuedAt: "2026-10-08T13:30:00Z", documentObject: "c.pdf" },
    ]);
    const { storage } = fakeStorage(new Map([["deletion-certificates/c.pdf", stored]]));
    const { mailer, sent } = fakeMailer();
    let rendered = 0;
    await runDeletionCertificates({
      store,
      storage,
      render: async (c) => {
        rendered += 1;
        return render(c);
      },
      mailer,
      copy,
      worker: "w",
    });
    expect(rendered).toBe(0);
    expect(new TextDecoder().decode(sent[0]?.attachment.content)).toBe("%PDF stored");
  });

  it("keeps the certificate in Atlas when the former Owner has no address", async () => {
    const { store, log } = fakeStore([{ ...purged, ownerEmail: null }]);
    const results = await runDeletionCertificates({
      store,
      storage: fakeStorage().storage,
      render,
      mailer: fakeMailer().mailer,
      copy,
      worker: "w",
    });
    expect(results[0]?.outcome).toBe("no-address");
    expect(log.at(-1)).toMatch(/^release .* no email address/);
  });

  it("releases the certificate with the error when mail fails, for the next run", async () => {
    const { store, log } = fakeStore([purged]);
    const failing: ReportMailer = {
      name: "down",
      send: async () => {
        throw new Error("Resend refused the message: rate limited");
      },
    };
    const results = await runDeletionCertificates({
      store,
      storage: fakeStorage().storage,
      render,
      mailer: failing,
      copy,
      worker: "w",
    });
    expect(results[0]).toEqual({
      id: purged.id,
      outcome: "failed",
      error: "Resend refused the message: rate limited",
    });
    expect(log.at(-1)).toBe(`release ${purged.id} Resend refused the message: rate limited`);
  });
});

describe("the certificate document", () => {
  it("builds the PDF/UA model with the org, the timeline and what was deleted", () => {
    const model = buildDeletionCertificateModel(purged, {
      locale: "en-US",
      messages: messages("en-US"),
      recordUrl: "https://atlas.example.test/deletion-certificates/c",
      now: new Date("2026-10-08T13:30:00Z"),
    });
    expect(model.kind).toBe("deletion-certificate");
    expect(model.title).toBe("Deletion certificate: Harbor Lights Productions");
    expect(model.brand.name).toBe("XOS");
    expect(model.facts.recordKey).toBe(certificateKey(purged.id));
    expect(model.blocks[0]).toMatchObject({ kind: "paragraph" });
    const table = model.blocks.find((b) => b.kind === "table");
    expect(table && table.kind === "table" && table.rows).toEqual([
      ["Records", "1,820"],
      ["Kinds of record", "41"],
      ["Stored files", "12"],
    ]);
    const timeline = model.blocks.find((b) => b.kind === "fields" && b.caption === "Timeline");
    expect(timeline && timeline.kind === "fields" && timeline.fields[0]?.label).toBe("Canceled");
  });

  it("renders in Spanish with the deletion request wording and no untranslated keys", async () => {
    const model = buildDeletionCertificateModel(
      { ...purged, basis: "deletion_request", ownerName: null },
      { locale: "es-US", messages: messages("es-US"), recordUrl: "https://atlas.example.test/x" },
    );
    const text = JSON.stringify(model.blocks);
    expect(text).toContain("Eliminación solicitada");
    expect(text).toContain("El antiguo Propietario");
    expect(text).not.toMatch(/deletionCertificate\./);
  });

  it("renders a tagged PDF on Letter and A4", async () => {
    for (const paper of ["letter", "a4"] as const) {
      const { bytes, fileName } = await renderDeletionCertificate(purged, {
        locale: "en-US",
        messages: messages("en-US"),
        recordUrl: "https://atlas.example.test/x",
        paper,
      });
      const head = new TextDecoder("latin1").decode(bytes.slice(0, 2048));
      expect(head.startsWith("%PDF-")).toBe(true);
      expect(new TextDecoder("latin1").decode(bytes)).toContain("/StructTreeRoot");
      expect(fileName).toMatch(new RegExp(`-${paper}\\.pdf$`));
    }
  }, 30_000);

  it("escapes the title in the XMP metadata, so a name with & keeps PDF/UA's dc:title", async () => {
    const { bytes } = await renderDeletionCertificate(
      { ...purged, orgName: "R&D <Stage> Rentals" },
      { locale: "en-US", messages: messages("en-US"), recordUrl: "https://atlas.example.test/x" },
    );
    const pdf = new TextDecoder("latin1").decode(bytes);
    expect(pdf).toContain("Deletion certificate: R&amp;D &lt;Stage&gt; Rentals");
    expect(pdf).not.toContain('<rdf:li xml:lang="x-default">Deletion certificate: R&D');
    expect(pdf).toContain("pdfuaid:part");
  }, 30_000);

  it("versions the template by issue time", () => {
    expect(deletionCertificateVersion("2026-10-21T00:00:00Z")).toBe(1);
    expect(deletionCertificateVersion("2020-01-01T00:00:00Z")).toBe(1);
  });
});

describe("Supabase adapters", () => {
  it("maps a claimed certificate row", () => {
    expect(
      toClaimedCertificate({
        id: "c",
        deleted_org_id: "o",
        org_name: "Org",
        org_slug: "org",
        basis: "deletion_request",
        requested_at: "r",
        due_at: "d",
        purged_at: null,
        tables_purged: null,
        rows_purged: null,
        storage_objects_deleted: 3,
        owner_name: null,
        owner_email: "a@b.example",
        locale: "es-US",
        storage_cleared_at: null,
        issued_at: null,
        document_object: null,
        delivered_at: null,
      }),
    ).toMatchObject({
      basis: "deletion_request",
      purged: false,
      storageObjectsDeleted: 3,
      locale: "es-US",
      rowsPurged: 0,
    });
  });

  it("calls the 1351 worker RPCs and the Storage API", async () => {
    const calls: string[] = [];
    const answers: Record<string, unknown> = {
      claim_deletion_certificates: [{ id: "c", purged_at: "2026-10-08T00:00:00Z", locale: "" }],
      deletion_storage_objects: [{ bucket_id: "attachments", name: "o/f" }],
      record_deletion_storage_cleared: true,
    };
    const client = {
      schema: () => ({
        rpc: async (fn: string) => {
          calls.push(fn);
          return { data: answers[fn] ?? null, error: null };
        },
      }),
      storage: {
        from: (bucket: string) => ({
          remove: async (names: string[]) => ({
            data: names.map((name) => ({ name, bucket })),
            error: null,
          }),
          upload: async () => ({ data: {}, error: null }),
          download: async () => ({ data: new Blob(["%PDF"]), error: null }),
        }),
      },
    };
    const store = supabasePurgeStore(client as never);
    const [claimed] = await store.claim("w", 5);
    expect(claimed?.purged).toBe(true);
    expect(claimed?.locale).toBe("en-US");
    expect(await store.storageObjects("c")).toEqual([{ bucket: "attachments", name: "o/f" }]);
    expect(await store.recordStorageCleared("c", 1)).toBe(true);
    await store.recordIssued("c", "c.pdf", "a".repeat(64));
    await store.recordDelivered("c", "m");
    await store.release("c", "boom");
    expect(calls).toEqual([
      "claim_deletion_certificates",
      "deletion_storage_objects",
      "record_deletion_storage_cleared",
      "record_deletion_certificate_issued",
      "record_deletion_certificate_delivered",
      "release_deletion_certificate",
    ]);
    const storage = supabasePurgeStorage(client as never);
    expect(await storage.remove("attachments", ["o/a", "o/b"])).toBe(2);
    await storage.upload("deletion-certificates", "c.pdf", new Uint8Array([1]), "application/pdf");
    expect(new TextDecoder().decode(await storage.download("deletion-certificates", "c.pdf"))).toBe(
      "%PDF",
    );
  });

  it("raises a refused RPC or storage call with what failed", async () => {
    const client = {
      schema: () => ({ rpc: async () => ({ data: null, error: { message: "denied" } }) }),
      storage: {
        from: () => ({
          remove: async () => ({ data: null, error: { message: "nope" } }),
          upload: async () => ({ data: null, error: { message: "full" } }),
          download: async () => ({ data: null, error: { message: "gone" } }),
        }),
      },
    };
    await expect(supabasePurgeStore(client as never).claim("w", 1)).rejects.toThrow(
      "claim_deletion_certificates: denied",
    );
    const storage = supabasePurgeStorage(client as never);
    await expect(storage.remove("b", ["x"])).rejects.toThrow(/refused deleting 1 objects in b/);
    await expect(storage.upload("b", "x", new Uint8Array(), "application/pdf")).rejects.toThrow(
      /refused storing x/,
    );
    await expect(storage.download("b", "x")).rejects.toThrow(/could not read x/);
  });
});

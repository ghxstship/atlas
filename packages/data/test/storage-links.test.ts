import { describe, expect, it } from "vitest";
import type { XosClient } from "../src/client.ts";
import {
  listDocumentFileLinks,
  listLinkableConnections,
  removeFileLink,
} from "../src/storage-links.ts";
import { errorResponse, fakeClient, okResponse } from "./fake-client.ts";

/** B16 (migration 3053, ADR 0155 D5): linked files for readers, linkable connections for writers. */

describe("storage links", () => {
  it("lists a document's linked files with their provider", async () => {
    const { db, calls } = fakeClient({
      "rpc:document_file_links": [
        okResponse([
          {
            link_id: "l1",
            provider_code: "onedrive_sharepoint",
            link_mode: "Link",
            file_name: "Stage Plot.pdf",
            mime_type: "application/pdf",
            size_bytes: 1200,
            web_url: "https://onedrive.example.test/f",
            external_modified_at: "2026-10-29T10:00:00Z",
            created_at: "2026-10-30T12:00:00Z",
          },
          {
            link_id: "l2",
            provider_code: "google_drive",
            link_mode: "Import",
            file_name: "Rider",
            mime_type: null,
            size_bytes: null,
            web_url: null,
            external_modified_at: null,
            created_at: "2026-10-30T12:00:00Z",
          },
        ]),
        errorResponse("08000", "down"),
      ],
    });
    const result = await listDocumentFileLinks(db as unknown as XosClient, "doc-1");
    expect(result.ok && result.data.map((l) => [l.provider, l.mode, l.webUrl])).toEqual([
      ["onedrive_sharepoint", "Link", "https://onedrive.example.test/f"],
      ["google_drive", "Import", null],
    ]);
    expect(calls[0]?.steps[0]).toEqual(["args", [{ p_document_id: "doc-1" }]]);
    expect((await listDocumentFileLinks(db as unknown as XosClient, "doc-1")).ok).toBe(false);
  });

  it("lists the connections a writer may link from", async () => {
    const { db } = fakeClient({
      "rpc:storage_connections_for_linking": [
        okResponse([
          {
            connection_id: "c1",
            provider_code: "google_drive",
            display_name: "Drive",
            external_account_name: "crew@x.test",
          },
        ]),
      ],
    });
    expect(await listLinkableConnections(db as unknown as XosClient, "org-1")).toEqual({
      ok: true,
      data: [
        {
          connectionId: "c1",
          provider: "google_drive",
          displayName: "Drive",
          accountName: "crew@x.test",
        },
      ],
    });
  });

  it("removes a link with a soft delete, or says it is gone", async () => {
    const { db } = fakeClient({
      "from:integration_file_links": [okResponse([{ id: "l1" }]), okResponse([])],
    });
    expect(await removeFileLink(db as unknown as XosClient, "l1")).toEqual({
      ok: true,
      data: null,
    });
    expect(await removeFileLink(db as unknown as XosClient, "l1")).toEqual({
      ok: false,
      error: { kind: "not-found" },
    });
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The route that serves party uploads (R9, migration 2712). app.party_file_object answers only for a
 * caller who may read the file, and the download runs under the caller's session, so every other
 * case is a 404 and the stored bytes never leave.
 */
const VERSION = "3c1d9e57-2a4b-4f6e-8d0c-7b5a9e1f2c34";
const OBJECT = "org-1/advance/rcp-1/sec-1/stage-plot.pdf";

const state = vi.hoisted(() => ({ viewer: null as unknown }));

vi.mock("@/lib/shell/context", () => ({ getViewer: async () => state.viewer }));

const { GET } = await import("@/app/files/party/[version]/route");

interface Fakes {
  readonly rows?: unknown;
  readonly rpcError?: { message: string } | null;
  readonly stored?: Uint8Array | null;
}

/** A signed-in viewer whose client answers party_file_object and the party-uploads download. */
function viewerWith({ rows = [], rpcError = null, stored = null }: Fakes) {
  const rpc = vi.fn(async () => ({ data: rows, error: rpcError }));
  const download = vi.fn(async () =>
    stored
      ? { data: new Blob([new Uint8Array(stored)]), error: null }
      : { data: null, error: { message: "denied" } },
  );
  const bucket = vi.fn(() => ({ download }));
  state.viewer = { person: { id: "p1" }, db: { rpc, storage: { from: bucket } } };
  return { rpc, download, bucket };
}

const get = (version = VERSION) =>
  GET(new Request(`https://atlas.test/files/party/${version}`), {
    params: Promise.resolve({ version }),
  } as never);

const object = {
  object_name: OBJECT,
  title: "Stage plot rev B",
  content_type: "application/pdf",
};

beforeEach(() => {
  state.viewer = null;
});

describe("/files/party/{version}", () => {
  it("serves a readable upload under the caller's session", async () => {
    const bytes = new TextEncoder().encode("%PDF-1.7 plot");
    const fakes = viewerWith({ rows: [object], stored: bytes });
    const res = await get();
    expect(res.status).toBe(200);
    expect(fakes.rpc).toHaveBeenCalledWith("party_file_object", { p_document_version_id: VERSION });
    expect(fakes.bucket).toHaveBeenCalledWith("party-uploads");
    expect(fakes.download).toHaveBeenCalledWith(OBJECT);
    expect(res.headers.get("Content-Type")).toBe("application/pdf");
    expect(res.headers.get("Content-Disposition")).toContain("Stage plot rev B");
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
  });

  it("names the file after its object and types it octet-stream without a title or type", async () => {
    viewerWith({
      rows: [{ object_name: OBJECT, title: null, content_type: null }],
      stored: new Uint8Array([1, 2, 3]),
    });
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/octet-stream");
    expect(res.headers.get("Content-Disposition")).toContain("stage-plot.pdf");
  });

  it("is a 404 for a version that is not a uuid, before any call", async () => {
    const fakes = viewerWith({ rows: [object], stored: new Uint8Array([1]) });
    expect((await get("not-a-uuid")).status).toBe(404);
    expect(fakes.rpc).not.toHaveBeenCalled();
  });

  it("is a 404 with no signed-in person", async () => {
    state.viewer = null;
    expect((await get()).status).toBe(404);
    const fakes = viewerWith({ rows: [object] });
    state.viewer = { ...(state.viewer as object), person: null };
    expect((await get()).status).toBe(404);
    expect(fakes.rpc).not.toHaveBeenCalled();
  });

  it("is a 404 when the caller may not read the file", async () => {
    const fakes = viewerWith({ rows: [], stored: new Uint8Array([1]) });
    expect((await get()).status).toBe(404);
    expect(fakes.download).not.toHaveBeenCalled();
  });

  it("is a 404 when the lookup fails", async () => {
    const fakes = viewerWith({ rows: [object], rpcError: { message: "boom" } });
    expect((await get()).status).toBe(404);
    expect(fakes.download).not.toHaveBeenCalled();
  });

  it("is a 404 when storage refuses, as it does before a Clean scan", async () => {
    viewerWith({ rows: [object], stored: null });
    const res = await get();
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("");
  });
});

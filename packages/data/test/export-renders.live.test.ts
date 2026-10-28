import { randomBytes } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import type { XosClient } from "../src/client.ts";
import { requestCollectionExport } from "../src/collection-exports.ts";
import {
  DEFAULT_EXPORT_COPY,
  EXPORT_ROW_LIMITS,
  runExportRenders,
  supabaseExportRenderStore,
  type ExportFiles,
} from "../src/export-renders.ts";

/**
 * The export worker against a running local Supabase stack, through PostgREST (A102, migration 2360). PostgREST
 * caps a set-returning function at max_rows (1,000 in supabase/config.toml), which cut every larger export to
 * 1,000 rows without a truncation note; the fakes of export-renders.test.ts and the pgTAP suites, which call the
 * SQL directly, cannot see that cap. Skipped unless XOS_EXPORT_LIVE_URL, XOS_EXPORT_LIVE_ANON_KEY and
 * XOS_EXPORT_LIVE_SERVICE_KEY name a local stack's API and keys. Each run signs up a fresh test account and org.
 */
const url = process.env["XOS_EXPORT_LIVE_URL"];
const anonKey = process.env["XOS_EXPORT_LIVE_ANON_KEY"];
const serviceKey = process.env["XOS_EXPORT_LIVE_SERVICE_KEY"];
const live = Boolean(url && anonKey && serviceKey);
if (live && !/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(url as string)) {
  throw new Error("The live export test runs against a local stack only.");
}

function serviceClient(): SupabaseClient {
  return createClient(url as string, serviceKey as string, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function signUp(): Promise<XosClient> {
  const store = new Map<string, string>();
  const db = createClient(url as string, anonKey as string, {
    db: { schema: "app" },
    auth: {
      persistSession: true,
      autoRefreshToken: false,
      storage: {
        getItem: (key) => store.get(key) ?? null,
        setItem: (key, value) => void store.set(key, value),
        removeItem: (key) => void store.delete(key),
      },
    },
  });
  const email = `a102-${randomBytes(5).toString("hex")}@atlas-e2e.test`;
  const { error } = await db.auth.signUp({
    email,
    password: `Live-${randomBytes(12).toString("base64url")}`,
  });
  if (error) throw error;
  return db as unknown as XosClient;
}

/** Captures the files the worker writes instead of storing them. */
function capturedFiles(): ExportFiles & { readonly bodies: Map<string, string | Uint8Array> } {
  const bodies = new Map<string, string | Uint8Array>();
  return {
    bodies,
    async upload(_bucket, name, body) {
      bodies.set(name, body);
    },
    async remove() {},
  };
}

/** Runs worker passes until the export is rendered; answers its CSV. */
async function render(service: SupabaseClient, exportId: string): Promise<string> {
  const files = capturedFiles();
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const outcome = await runExportRenders({
      store: supabaseExportRenderStore(service),
      files,
      copy: () => DEFAULT_EXPORT_COPY,
      worker: "export-renders-live",
    });
    const mine = outcome.renders.find((r) => r.exportId === exportId);
    if (mine) {
      expect(mine.status, JSON.stringify(mine)).toBe("Ready");
      const body = [...files.bodies.entries()].find(([name]) => name.includes(exportId))?.[1];
      return typeof body === "string" ? body : new TextDecoder().decode(body);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("The export was never rendered.");
}

describe.skipIf(!live)("export worker on the local stack", () => {
  it("exports every row of a view past PostgREST's 1,000-row cap, and notes the cut at the limit", async () => {
    const service = serviceClient();
    const owner = await signUp();
    const id = randomBytes(4).toString("hex");
    const created = await owner.rpc("create_organization", {
      p_name: `Bulk Exports ${id}`,
      p_slug: `bulk-exports-${id}`,
    });
    expect(created.error).toBeNull();
    const orgId = created.data as string;

    const venues = Array.from({ length: 2_500 }, (_, i) => ({
      org_id: orgId,
      name: `Bulk Venue ${String(i + 1).padStart(4, "0")}`,
      locality: "Bulk Town",
      jurisdiction_id: "US-FL-MIAMI-DADE",
      time_zone: "America/New_York",
    }));
    const inserted = await service.schema("app").from("venues").insert(venues);
    expect(inserted.error).toBeNull();

    const csv = await requestCollectionExport(owner, {
      orgId,
      format: "CSV",
      label: "Venues",
      relation: "app.venues",
      columns: ["name", "locality"],
      headers: ["Venue", "City"],
      filters: [],
    });
    if (!csv.ok) throw new Error(JSON.stringify(csv.error));
    const lines = (await render(service, csv.data)).trimEnd().split("\n");
    expect(lines).toHaveLength(2_501);
    expect(lines[0]).toBe("Venue,City");
    expect(lines[1]).toBe("Bulk Venue 0001,Bulk Town");
    expect(lines[2_500]).toBe("Bulk Venue 2500,Bulk Town");
    const recorded = await service
      .schema("app")
      .from("export_jobs")
      .select("row_count, export_status")
      .eq("id", csv.data)
      .single();
    expect(recorded.data).toEqual({ row_count: 2_500, export_status: "Ready" });

    // A PDF stops at its own limit, past 1,000 rows, and says so.
    const pdf = await requestCollectionExport(owner, {
      orgId,
      format: "PDF",
      label: "Venues",
      relation: "app.venues",
      columns: ["name"],
      headers: ["Venue"],
      filters: [],
    });
    if (!pdf.ok) throw new Error(JSON.stringify(pdf.error));
    await render(service, pdf.data);
    const cut = await service
      .schema("app")
      .from("export_jobs")
      .select("row_count")
      .eq("id", pdf.data)
      .single();
    expect(cut.data).toEqual({ row_count: EXPORT_ROW_LIMITS.PDF });
  }, 120_000);
});

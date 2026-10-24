import { describe, expect, it } from "vitest";
import type { XosClient } from "../src/client.ts";
import {
  STANDARD_LIBRARIES,
  adoptStandardLibrary,
  getStandardLibraryStatus,
  isFullyAdopted,
} from "../src/standard-library.ts";
import { errorResponse, fakeClient, okResponse } from "./fake-client.ts";

const down = errorResponse("08006", "down");

describe("the Standard Library in an org", () => {
  it("reads the status of each library in order", async () => {
    const fake = fakeClient({
      "rpc:standard_library_status": [
        okResponse([
          { library: "document_library", standard_count: 34, adopted_count: 0 },
          { library: "emergency_codes", standard_count: 14, adopted_count: 14 },
          { library: "retired_library", standard_count: 1, adopted_count: 0 },
        ]),
        okResponse(null),
        down,
      ],
    });
    const db = fake.db as XosClient;
    const status = await getStandardLibraryStatus(db, "o1");
    expect(status).toEqual({
      ok: true,
      data: [
        { library: "document_library", standardCount: 34, adoptedCount: 0 },
        { library: "emergency_codes", standardCount: 14, adoptedCount: 14 },
      ],
    });
    expect(fake.calls[0]?.steps[0]).toEqual(["args", [{ p_org_id: "o1" }]]);
    expect(status.ok && isFullyAdopted(status.data)).toBe(false);
    expect(isFullyAdopted([{ library: "sops", standardCount: 34, adoptedCount: 34 }])).toBe(true);
    expect(await getStandardLibraryStatus(db, "o1")).toEqual({ ok: true, data: [] });
    expect((await getStandardLibraryStatus(db, "o1")).ok).toBe(false);
  });

  it("adopts and reports what one run copied", async () => {
    const fake = fakeClient({
      "rpc:adopt_standard_library": [
        okResponse({ emergency_codes: 14, sops: 34, verbiage: "x" }),
        okResponse(null),
        errorResponse("42501", "canon.extension.write is required"),
      ],
    });
    const db = fake.db as XosClient;
    const first = await adoptStandardLibrary(db, "o1");
    expect(first.ok && first.data.total).toBe(48);
    expect(first.ok && first.data.copied.emergency_codes).toBe(14);
    expect(first.ok && first.data.copied.verbiage).toBe(0);
    expect(first.ok && Object.keys(first.data.copied)).toEqual([...STANDARD_LIBRARIES]);
    const again = await adoptStandardLibrary(db, "o1");
    expect(again.ok && again.data.total).toBe(0);
    expect((await adoptStandardLibrary(db, "o1")).ok).toBe(false);
  });
});

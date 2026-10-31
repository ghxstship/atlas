import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A139: the W-9 mailing address checks against the US address format of @xos/i18n/formats, as Atlas checks venue,
 * vendor and legal entity addresses: the street, city, state and ZIP the US requires, and a ZIP that fits, written
 * the way the post writes it before it is saved.
 */

const saved = vi.hoisted(() => [] as Record<string, unknown>[]);

vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/lib/shell/context", () => ({ getGatewayContext: async () => ({ db: {} }) }));
vi.mock("@xos/data/form-1099", () => ({
  setTaxFormAddress: async (_db: unknown, input: Record<string, unknown>) => {
    saved.push(input);
    return { ok: true, data: "form-1" };
  },
}));

const { setTaxFormAddressAction } = await import("../lib/actions/payouts.ts");

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  const all = {
    taxFormId: "0190f1a2-7c1e-7d4b-9a33-2f6c1b9e8a10",
    legalName: "",
    streetAddress: "548 Market St",
    locality: "San Francisco",
    regionCode: "ca",
    postalCode: "94104 1234",
    ...fields,
  };
  for (const [k, v] of Object.entries(all)) data.set(k, v);
  return data;
}

describe("the W-9 mailing address (A139)", () => {
  beforeEach(() => {
    saved.length = 0;
  });

  it("saves a complete US address with the ZIP+4 hyphenated and the state in capitals", async () => {
    expect(await setTaxFormAddressAction({}, form({}))).toEqual({ done: true });
    expect(saved[0]).toMatchObject({ regionCode: "CA", postalCode: "94104-1234", legalName: null });
  });

  it("names the first field the US format finds missing or wrong", async () => {
    expect(await setTaxFormAddressAction({}, form({ locality: " " }))).toEqual({
      fieldError: "locality",
    });
    expect(await setTaxFormAddressAction({}, form({ regionCode: "" }))).toEqual({
      fieldError: "regionCode",
    });
    expect(await setTaxFormAddressAction({}, form({ postalCode: "9410" }))).toEqual({
      fieldError: "postalCode",
    });
    expect(await setTaxFormAddressAction({}, form({ regionCode: "California" }))).toEqual({
      fieldError: "regionCode",
    });
    expect(saved).toHaveLength(0);
  });
});

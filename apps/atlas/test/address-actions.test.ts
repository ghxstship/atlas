import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A139: the actions that save an address or a work phone (Section 15). A venue keeps every address field
 * optional but its postal code must fit its jurisdiction's country; a vendor's or legal entity's address
 * holds its country's required fields; a work phone is read in the person's region and saved in E.164.
 * The repositories are fakes, so each test sees exactly what would reach the database.
 */

const state = vi.hoisted(() => ({
  locale: "en-US",
  entityCountry: "US" as string | null,
  venues: [] as { op: "create" | "update"; input: Record<string, unknown> }[],
  vendorAddresses: [] as Record<string, unknown>[],
  entityAddresses: [] as Record<string, unknown>[],
  personal: [] as { key: string; value: unknown }[],
}));

const VENUE = "0b8f3a52-2f5c-4f0e-9a51-5d1b1c7f0a11";
const VENDOR = "6f1c2d4e-8a9b-4c3d-9e2f-1a2b3c4d5e6f";
const ENTITY = "9d8c7b6a-5e4f-4a3b-8c2d-1e0f9a8b7c6d";

vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("notFound");
  },
}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next-intl/server", () => ({ getLocale: async () => state.locale }));
vi.mock("@/lib/shell/actions", () => ({ applyDevicePreference: async () => undefined }));
vi.mock("@/lib/custom-fields/form", () => ({
  customFieldsOf: async () => ({ save: async () => undefined }),
}));
vi.mock("@/lib/shell/context", () => ({
  getOrgContext: async () => ({
    org: { id: "org-1", slug: "acme" },
    role: "owner",
    viewer: {
      person: { id: "person-1" },
      db: {
        // legalEntityAddressAction reads the entity's country from the masked view.
        from: () => ({
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: state.entityCountry === null ? null : { country_code: state.entityCountry },
              }),
            }),
          }),
        }),
      },
    },
  }),
}));
vi.mock("@xos/data/places", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  createVenue: async (_db: unknown, _org: string, input: Record<string, unknown>) => {
    state.venues.push({ op: "create", input });
    return { ok: true, data: { id: VENUE } };
  },
  updateVenue: async (_db: unknown, _id: string, input: Record<string, unknown>) => {
    state.venues.push({ op: "update", input });
    return { ok: true, data: { id: VENUE } };
  },
  setVenueLocation: async () => ({ ok: true, data: null }),
}));
vi.mock("@xos/data/vendors", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  updateVendorAddress: async (_db: unknown, id: string, input: Record<string, unknown>) => {
    state.vendorAddresses.push(input);
    return { ok: true, data: { id } };
  },
}));
vi.mock("@xos/data/access-controls", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  setLegalEntityAddress: async (_db: unknown, id: string, input: Record<string, unknown>) => {
    state.entityAddresses.push(input);
    return { ok: true, data: { id } };
  },
}));
vi.mock("@xos/data/settings", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  setPersonalSetting: async (_db: unknown, input: { key: string; value: unknown }) => {
    state.personal.push({ key: input.key, value: input.value });
    return { ok: true, data: "v1" };
  },
}));

const { saveVenueAction } = await import("@/app/[org]/places/actions");
const { updateVendorAddressAction } = await import("@/app/[org]/vendors/actions");
const { legalEntityAddressAction } = await import("@/app/[org]/settings/access-control-actions");
const { saveSettingsAction } = await import("@/app/[org]/settings/registry-actions");

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  data.set("org", "acme");
  for (const [k, v] of Object.entries(fields)) data.set(k, v);
  return data;
}

beforeEach(() => {
  state.locale = "en-US";
  state.entityCountry = "US";
  state.venues = [];
  state.vendorAddresses = [];
  state.entityAddresses = [];
  state.personal = [];
});

describe("saving a venue address", () => {
  const venue = {
    name: "Coral Assembly Hall",
    jurisdictionId: "US-FL-MIAMI-DADE",
    timeZone: "America/New_York",
    streetAddress: "",
    locality: "Miami",
    postalCode: "",
  };

  it("takes a venue with only its city, on create and on edit", async () => {
    expect(await saveVenueAction({}, form(venue))).toEqual({ ok: true, id: VENUE });
    expect(await saveVenueAction({}, form({ ...venue, id: VENUE, locality: "Doral" }))).toEqual({
      ok: true,
      id: VENUE,
    });
    expect(state.venues.map((v) => [v.op, v.input["locality"], v.input["streetAddress"]])).toEqual([
      ["create", "Miami", null],
      ["update", "Doral", null],
    ]);
  });

  it("writes a ZIP+4 as the US writes it and refuses a postal code from another country", async () => {
    await saveVenueAction({}, form({ ...venue, postalCode: "33131 1234" }));
    expect(state.venues[0]?.input["postalCode"]).toBe("33131-1234");
    expect(await saveVenueAction({}, form({ ...venue, postalCode: "SW1A 1AA" }))).toEqual({
      fieldErrors: { postalCode: "postalCode" },
    });
    expect(state.venues).toHaveLength(1);
  });
});

describe("saving a vendor's mailing address", () => {
  const us = {
    id: VENDOR,
    countryCode: "us",
    streetAddress: "548 Market St",
    locality: "San Francisco",
    administrativeArea: "CA",
    postalCode: "94104",
  };

  it("saves the country's fields with the country in capitals", async () => {
    expect(await updateVendorAddressAction({}, form(us))).toEqual({ ok: true, id: VENDOR });
    expect(state.vendorAddresses).toEqual([
      {
        countryCode: "US",
        streetAddress: "548 Market St",
        locality: "San Francisco",
        administrativeArea: "CA",
        postalCode: "94104",
      },
    ]);
  });

  it("names a required field the form showed and left blank", async () => {
    const result = await updateVendorAddressAction({}, form({ ...us, administrativeArea: "" }));
    expect(result.ok).toBeUndefined();
    expect(result.fieldErrors).toEqual({ administrativeArea: "addressRequired" });
    expect(state.vendorAddresses).toEqual([]);
  });

  it("saves a change of country from a layout without a state, rather than asking for a field it never showed", async () => {
    // The vendor's stored address is in GB, so the form shows no state; the person types US.
    const gbLayout = {
      id: VENDOR,
      countryCode: "US",
      streetAddress: "1 Main St",
      postalCode: "62701",
      locality: "Springfield",
    };
    expect(await updateVendorAddressAction({}, form(gbLayout))).toEqual({ ok: true, id: VENDOR });
    expect(state.vendorAddresses[0]).toMatchObject({ countryCode: "US", administrativeArea: null });
  });

  it("asks for the country of an address and refuses a postal code that does not fit it", async () => {
    expect(
      (await updateVendorAddressAction({}, form({ ...us, countryCode: "" }))).fieldErrors,
    ).toEqual({ countryCode: "countryNeeded" });
    expect(
      (await updateVendorAddressAction({}, form({ ...us, countryCode: "GB" }))).fieldErrors,
    ).toEqual({ postalCode: "postalCode" });
    expect(state.vendorAddresses).toEqual([]);
  });
});

describe("saving a legal entity's registered address", () => {
  const address = {
    legalEntityId: ENTITY,
    streetAddress: "Hauptstraße 5",
    locality: "Berlin",
    postalCode: "10115",
  };

  it("checks the address against the entity's own country", async () => {
    state.entityCountry = "DE";
    expect(await legalEntityAddressAction({}, form(address))).toEqual({ ok: true });
    expect(state.entityAddresses).toEqual([
      {
        streetAddress: "Hauptstraße 5",
        locality: "Berlin",
        administrativeArea: null,
        postalCode: "10115",
      },
    ]);
    state.entityCountry = "US";
    expect(
      await legalEntityAddressAction({}, form({ ...address, administrativeArea: "" })),
    ).toEqual({ fieldErrors: { administrativeArea: "addressRequired" } });
    expect(state.entityAddresses).toHaveLength(1);
  });

  it("refuses an entity the person cannot read", async () => {
    state.entityCountry = null;
    expect(await legalEntityAddressAction({}, form(address))).toEqual({ error: "denied" });
  });
});

describe("saving a work phone", () => {
  const phone = (value: string) => {
    const data = form({ group: "personal" });
    data.append("dirty", "workforce.work_phone");
    data.set("value:workforce.work_phone", value);
    return data;
  };

  it("stores a national number in E.164, read in the person's region", async () => {
    state.locale = "es-US";
    const result = await saveSettingsAction({}, phone("(305) 555-0142"));
    expect(result.saved).toEqual(["workforce.work_phone"]);
    expect(state.personal).toEqual([{ key: "workforce.work_phone", value: "+13055550142" }]);
  });

  it("keeps an international number's own country", async () => {
    await saveSettingsAction({}, phone("+44 20 7946 0958"));
    expect(state.personal).toEqual([{ key: "workforce.work_phone", value: "+442079460958" }]);
  });

  it("refuses what is not a phone number and keeps what was typed", async () => {
    const result = await saveSettingsAction({}, phone("desk 4412"));
    expect(result.errors).toEqual({ "workforce.work_phone": "phone" });
    expect(result.values).toEqual({ "workforce.work_phone": "desk 4412" });
    expect(state.personal).toEqual([]);
  });
});

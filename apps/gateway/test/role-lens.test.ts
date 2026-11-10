import type { ApplicationWithOpportunity, Engagement, Representation } from "@xos/data/gateway";
import { GATEWAY_LENS_SCOPE, roleLensCookie } from "@xos/data/role-lens";
import { describe, expect, it } from "vitest";
import {
  inLens,
  lensApplications,
  lensEngagements,
  lensRepresentations,
  lensRoleTypes,
  lensSlug,
  resolveGatewayLens,
} from "../lib/shell/role-lens";

const cookie = (slug: string) => roleLensCookie(GATEWAY_LENS_SCOPE, slug);

const engagements: (Pick<Engagement, "roleType"> & { id: string })[] = [
  { id: "e1", roleType: "Crew" },
  { id: "e2", roleType: "Artist" },
  { id: "e3", roleType: "Crew" },
];

describe("resolveGatewayLens", () => {
  it("narrows to a role type the person holds", () => {
    const lens = resolveGatewayLens(["Crew", "Artist"], cookie("artist"));
    expect(lens).toEqual({ roleTypes: ["Artist", "Crew"], roleType: "Artist" });
  });

  it("is All roles without a cookie, for another scope, for a role type not held or with one role type", () => {
    expect(resolveGatewayLens(["Crew", "Artist"], undefined).roleType).toBeNull();
    expect(resolveGatewayLens(["Crew", "Artist"], "demo-productions:artist").roleType).toBeNull();
    expect(resolveGatewayLens(["Crew", "Artist"], cookie("vendor")).roleType).toBeNull();
    expect(resolveGatewayLens(["Crew"], cookie("crew")).roleType).toBeNull();
  });

  it("spells a two-word role type as one slug", () => {
    expect(lensSlug("Artist Representative")).toBe("artist-representative");
    expect(
      resolveGatewayLens(["Artist", "Artist Representative"], cookie("artist-representative"))
        .roleType,
    ).toBe("Artist Representative");
  });
});

describe("what the lens shows", () => {
  const artist = resolveGatewayLens(["Crew", "Artist"], cookie("artist"));
  const all = resolveGatewayLens(["Crew", "Artist"], undefined);

  it("keeps only the lens's engagements, and every engagement under All roles", () => {
    expect(lensEngagements(artist, engagements).map((e) => e.id)).toEqual(["e2"]);
    expect(lensEngagements(all, engagements).map((e) => e.id)).toEqual(["e1", "e2", "e3"]);
  });

  it("never shows an engagement All roles does not", () => {
    for (const roleType of all.roleTypes) {
      const lens = resolveGatewayLens(all.roleTypes, cookie(lensSlug(roleType)));
      for (const e of lensEngagements(lens, engagements)) expect(engagements).toContain(e);
    }
  });

  it("keeps applications for the lens's opportunities and any whose opportunity is gone", () => {
    const apps = [
      { id: "a1", opportunity: { roleType: "Crew" } },
      { id: "a2", opportunity: { roleType: "Artist" } },
      { id: "a3", opportunity: null },
    ] as unknown as ApplicationWithOpportunity[];
    expect(lensApplications(artist, apps).map((a) => a.id)).toEqual(["a2", "a3"]);
  });

  it("keeps representations for the Artist role only", () => {
    const reps = [{ id: "r1" }] as unknown as Representation[];
    expect(lensRepresentations(artist, reps)).toHaveLength(1);
    const crew = resolveGatewayLens(["Crew", "Artist"], cookie("crew"));
    expect(lensRepresentations(crew, reps)).toHaveLength(0);
    expect(inLens(all, "Vendor")).toBe(true);
  });

  it("decides paid-work navigation from the lens's role type alone", () => {
    const client = resolveGatewayLens(["Crew", "Client"], cookie("client"));
    expect(lensRoleTypes(client, ["Crew", "Client"])).toEqual(["Client"]);
    expect(lensRoleTypes(all, ["Crew", "Artist"])).toEqual(["Crew", "Artist"]);
  });
});

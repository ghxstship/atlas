import { describe, expect, it } from "vitest";
import type { XosClient } from "../src/client.ts";
import { getPersonCard } from "../src/person-card.ts";

/** A query builder that records its calls and answers with a fixed result. */
function builder(answer: unknown, calls: string[]) {
  const chain: Record<string, unknown> = {};
  for (const name of ["select", "eq", "is", "order", "limit", "not"]) {
    chain[name] = (...args: unknown[]) => {
      calls.push(`${name}(${args.map((a) => JSON.stringify(a)).join(",")})`);
      return chain;
    };
  }
  chain["maybeSingle"] = () => Promise.resolve(answer);
  chain["then"] = (resolve: (v: unknown) => unknown) => Promise.resolve(answer).then(resolve);
  return chain;
}

function client(memberships: unknown, records: unknown) {
  const calls: string[] = [];
  const db = {
    from(table: string) {
      calls.push(`from(${table})`);
      return builder(table === "memberships" ? memberships : records, calls);
    },
  } as unknown as XosClient;
  return { db, calls };
}

describe("getPersonCard", () => {
  it("names the person, their best role, when they joined and their open records", async () => {
    const { db, calls } = client(
      {
        data: {
          valid_from: "2026-03-02T09:00:00Z",
          person: { full_name: "Erin Castillo" },
          membership_roles: [
            { deleted_at: null, role: { name: "Collaborator", band: 5 } },
            { deleted_at: null, role: { name: "Manager", band: 3 } },
            { deleted_at: "2026-04-01T00:00:00Z", role: { name: "Owner", band: 1 } },
          ],
        },
        error: null,
      },
      { count: 4, error: null },
    );
    const card = await getPersonCard(db, "org-1", "person-1");
    expect(card).toEqual({
      ok: true,
      data: {
        personId: "person-1",
        name: "Erin Castillo",
        role: "Manager",
        memberSince: "2026-03-02T09:00:00Z",
        openRecords: 4,
      },
    });
    expect(calls).toContain('not("record_state","in","(Complete,Canceled)")');
    expect(calls).toContain('eq("owner_party_id","person-1")');
  });

  it("reads a person the viewer cannot see as not found, and passes errors on", async () => {
    expect(
      await getPersonCard(
        client({ data: null, error: null }, { count: 0, error: null }).db,
        "o",
        "p",
      ),
    ).toEqual({
      ok: false,
      error: { kind: "not-found" },
    });
    const failed = await getPersonCard(
      client({ data: null, error: null }, { count: null, error: { code: "42501", message: "no" } })
        .db,
      "o",
      "p",
    );
    expect(failed).toEqual({ ok: false, error: { kind: "not-found" } });
    const broken = await getPersonCard(
      client({ data: null, error: { code: "XX000", message: "boom" } }, { count: 0, error: null })
        .db,
      "o",
      "p",
    );
    expect(broken.ok).toBe(false);
  });
});

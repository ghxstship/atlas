import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import {
  deleteMyAccount,
  parsePreview,
  previewAccountDeletion,
  removeProfileMedia,
} from "../src/account-deletion.ts";

interface Rpc {
  data: unknown;
  error: { code?: string; message: string; hint?: string | null } | null;
}

/**
 * A client whose RPCs answer from queues and whose storage holds the given objects: profile-media paths,
 * or `upload-staging:<name>` for a staged upload.
 */
function fake(rpcs: Record<string, Rpc[]>, objects: string[] = [], failRemove = false) {
  const calls: string[] = [];
  const stored = new Set(objects);
  const key = (bucket: string, path: string) =>
    bucket === "profile-media" ? path : `${bucket}:${path}`;
  const client = {
    rpc(name: string, args?: unknown) {
      calls.push(`rpc:${name}:${JSON.stringify(args ?? null)}`);
      const next = rpcs[name]?.shift();
      if (!next) throw new Error(`no queued response for ${name}`);
      return Promise.resolve(next);
    },
    storage: {
      from: (bucket: string) => ({
        list: (folder: string) => {
          calls.push(`list:${bucket}:${folder}`);
          const names = new Map<string, boolean>();
          const prefix = key(bucket, `${folder}/`);
          for (const path of stored) {
            if (!path.startsWith(prefix)) continue;
            const rest = path.slice(prefix.length);
            const [head, ...tail] = rest.split("/");
            names.set(head ?? "", tail.length > 0 || names.get(head ?? "") === true);
          }
          return Promise.resolve({
            data: [...names].map(([name, isFolder]) => ({ name, id: isFolder ? null : name })),
            error: null,
          });
        },
        remove: (paths: string[]) => {
          calls.push(`remove:${bucket}:${paths.join(",")}`);
          if (failRemove)
            return Promise.resolve({ data: null, error: { message: "storage down" } });
          for (const p of paths) stored.delete(key(bucket, p));
          return Promise.resolve({ data: paths.map((name) => ({ name })), error: null });
        },
      }),
    },
  };
  return { client: client as unknown as SupabaseClient, calls, stored };
}

const preview = (blockers: unknown[] = []) => ({
  data: {
    person_id: "p1",
    email: "tech@example.com",
    blockers,
    kept: [
      { category: "time_and_pay", retention: "7 years" },
      { category: "audit_trail", retention: "7 years" },
    ],
  },
  error: null,
});

describe("account deletion", () => {
  it("parses the preview with blockers and kept records", () => {
    const parsed = parsePreview({
      person_id: "p1",
      email: "a@example.com",
      blockers: [
        { code: "account_delete_legal_hold", org_id: "o1", org_name: "Demo Org", matter: "Claim" },
        { code: "account_delete_on_shift", org_id: "o1", org_name: "Demo Org" },
      ],
      kept: [{ category: "tax_forms", retention: "7 years" }],
    });
    expect(parsed.blockers).toEqual([
      { code: "account_delete_legal_hold", orgId: "o1", orgName: "Demo Org", matter: "Claim" },
      { code: "account_delete_on_shift", orgId: "o1", orgName: "Demo Org", matter: null },
    ]);
    expect(parsed.kept).toEqual([{ category: "tax_forms", retention: "7 years" }]);
    expect(parsePreview({}).blockers).toEqual([]);
  });

  it("returns a typed error when the preview fails", async () => {
    const { client } = fake({
      account_deletion_preview: [{ data: null, error: { code: "42501", message: "no person" } }],
    });
    expect(await previewAccountDeletion(client)).toEqual({
      ok: false,
      error: { kind: "not-found" },
    });
  });

  it("removes nested profile media, then deletes the account", async () => {
    const { client, calls, stored } = fake(
      {
        account_deletion_preview: [preview()],
        delete_my_account: [
          {
            data: {
              deleted_at: "2026-10-17T12:00:00Z",
              replayed: false,
              kept: [{ category: "audit_trail", retention: "7 years" }],
              memberships_ended: 1,
              engagements_canceled: 0,
              orgs_notified: 1,
            },
            error: null,
          },
        ],
      },
      ["p1/photo.jpg", "p1/portfolio/reel.mp4", "other/photo.jpg"],
    );
    const result = await deleteMyAccount(client, " Tech@Example.com ");
    expect(result).toEqual({
      ok: true,
      data: {
        deletedAt: "2026-10-17T12:00:00Z",
        replayed: false,
        kept: [{ category: "audit_trail", retention: "7 years" }],
        membershipsEnded: 1,
        engagementsCanceled: 0,
        orgsNotified: 1,
      },
    });
    expect([...stored]).toEqual(["other/photo.jpg"]);
    expect(calls.at(-1)).toBe('rpc:delete_my_account:{"p_confirm_email":" Tech@Example.com "}');
  });

  it("leaves media alone and returns the refusal when a blocker stands", async () => {
    const { client, stored } = fake(
      {
        account_deletion_preview: [
          preview([
            {
              code: "account_delete_legal_hold",
              org_id: "o1",
              org_name: "Demo Org",
              matter: "Claim",
            },
          ]),
        ],
        delete_my_account: [
          {
            data: null,
            error: {
              code: "XR001",
              message:
                "account_delete_legal_hold: Demo Org keeps your records under a legal hold (Claim).",
              hint: "account_delete_legal_hold",
            },
          },
        ],
      },
      ["p1/photo.jpg"],
    );
    const result = await deleteMyAccount(client, "tech@example.com");
    expect(result).toMatchObject({
      ok: false,
      error: { kind: "refusal", rule: "account_delete_legal_hold" },
    });
    expect([...stored]).toEqual(["p1/photo.jpg"]);
  });

  it("leaves media alone when the typed email does not match", async () => {
    const { client, stored } = fake(
      {
        account_deletion_preview: [preview()],
        delete_my_account: [
          {
            data: null,
            error: {
              code: "XR001",
              message: "account_delete_confirmation: Type the email.",
              hint: "account_delete_confirmation",
            },
          },
        ],
      },
      ["p1/photo.jpg"],
    );
    const result = await deleteMyAccount(client, "wrong@example.com");
    expect(result).toMatchObject({
      ok: false,
      error: { kind: "refusal", rule: "account_delete_confirmation" },
    });
    expect(stored.size).toBe(1);
  });

  it("stops before the deletion when media cannot be removed", async () => {
    const { client, calls } = fake(
      { account_deletion_preview: [preview()] },
      ["p1/photo.jpg"],
      true,
    );
    const result = await deleteMyAccount(client, "tech@example.com");
    expect(result).toEqual({ ok: false, error: { kind: "unexpected", message: "storage down" } });
    expect(calls.some((c) => c.startsWith("rpc:delete_my_account"))).toBe(false);
  });

  it("removes uploads still staged for the folder too (1265)", async () => {
    const { client, calls, stored } = fake({}, [
      "p1/photo.jpg",
      "upload-staging:profile-media/p1/new-photo.jpg",
      "upload-staging:profile-media/other/photo.jpg",
      "upload-staging:org-brand/o1/logo.png",
    ]);
    expect(await removeProfileMedia(client, "p1")).toEqual({ ok: true, data: 2 });
    expect([...stored]).toEqual([
      "upload-staging:profile-media/other/photo.jpg",
      "upload-staging:org-brand/o1/logo.png",
    ]);
    expect(calls).toContain("remove:upload-staging:profile-media/p1/new-photo.jpg");
  });

  it("removes nothing from an empty folder", async () => {
    const { client } = fake({});
    expect(await removeProfileMedia(client, "p1")).toEqual({ ok: true, data: 0 });
  });
});

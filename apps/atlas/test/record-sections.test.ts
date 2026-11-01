/**
 * The sections a record shows in every peek and on its full page (Section 11.2 item 4): the shared
 * loaders (components/work/record-sections.ts) read the comments, files and related records once
 * for the full page, the work peeks and the shell's peek, and RelatedRecords renders the related
 * records the same everywhere. @xos/data is replaced by the answers each read gives.
 */
import { getMessages } from "@xos/i18n";
import type { OrgContext } from "@/lib/shell/context";
import { NextIntlClientProvider } from "next-intl";
import { createElement, type ComponentProps, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadConversation, loadRelations } from "@/components/work/record-sections";
import { RelatedRecords, type RecordRelations } from "@/components/work/related-records";

const data = vi.hoisted(() => ({
  family: vi.fn(),
  dependencies: vi.fn(),
  links: vi.fn(),
  records: vi.fn(),
  threads: vi.fn(),
  attachments: vi.fn(),
  names: vi.fn(),
}));

vi.mock("@xos/data/work", () => ({ getRecordFamily: data.family, listRecords: data.records }));
vi.mock("@xos/data/schedule", () => ({ listDependencies: data.dependencies }));
vi.mock("@xos/data/custom-objects", () => ({ listRecordLinks: data.links }));
vi.mock("@xos/data/comments", () => ({ listThreads: data.threads }));
vi.mock("@xos/data/attachments", () => ({ listAttachments: data.attachments }));
vi.mock("@xos/data/person-names", () => ({ personNames: data.names }));
vi.mock("@/components/work/load", () => ({
  must: <T>(r: { ok: true; data: T } | { ok: false; error: unknown }, what: string): T => {
    if (!r.ok) throw new Error(`Cannot load ${what}`);
    return r.data;
  },
}));

const ok = <T>(value: T) => ({ ok: true as const, data: value });
const ctx = { org: { id: "o1", slug: "demo-productions" }, viewer: { db: {} } } as OrgContext;
const record = (id: string, number: number, state = "Active") => ({
  id,
  key: `NWS-${number}`,
  title: `Record ${number}`,
  kind: "Task",
  state,
});

beforeEach(() => {
  for (const fn of Object.values(data)) fn.mockReset();
});

describe("the shared record loaders", () => {
  it("read the parent, sub-records, dependencies both ways and linked custom object records", async () => {
    data.family.mockResolvedValue(
      ok({ parent: record("r0", 1), parentHidden: false, children: [record("r2", 3, "Proposed")] }),
    );
    data.dependencies.mockResolvedValue(
      ok([
        { id: "d1", predecessorId: "r5", successorId: "r1", type: "Finish to Start", lag: "0" },
        { id: "d2", predecessorId: "r1", successorId: "r9", type: "Start to Start", lag: "0" },
      ]),
    );
    data.links.mockResolvedValue(
      ok([
        {
          id: "l1",
          relationKey: "sponsor",
          objectKey: "sponsors",
          objectLabel: "Sponsors",
          recordId: "c1",
          title: "Acme",
        },
      ]),
    );
    // r9 is outside the viewer's view: row level security leaves it out.
    data.records.mockResolvedValue(ok([record("r5", 5)]));
    const { relations, dependencies } = await loadRelations(ctx, "r1");
    // Dependency ends are known records, so archived ones are named too (A124).
    expect(data.records).toHaveBeenCalledWith(
      {},
      { orgId: "o1", ids: ["r5", "r9"], archived: "include" },
    );
    expect(relations.parent?.key).toBe("NWS-1");
    expect(relations.children.map((c) => c.key)).toEqual(["NWS-3"]);
    expect(relations.waitsOn).toEqual([
      { id: "d1", type: "Finish to Start", record: record("r5", 5) },
    ]);
    expect(relations.holdsUp).toEqual([{ id: "d2", type: "Start to Start", record: null }]);
    expect(relations.links.map((l) => l.title)).toEqual(["Acme"]);
    expect(dependencies.map((d) => d.id)).toEqual(["d1", "d2"]);
  });

  it("reads no other records when the record has no dependencies", async () => {
    data.family.mockResolvedValue(ok({ parent: null, parentHidden: true, children: [] }));
    data.dependencies.mockResolvedValue(ok([]));
    data.links.mockResolvedValue(ok([]));
    const { relations } = await loadRelations(ctx, "r1");
    expect(data.records).not.toHaveBeenCalled();
    expect(relations.parentHidden).toBe(true);
  });

  it("fails when a read fails, as the full page does", async () => {
    data.family.mockResolvedValue({ ok: false, error: { kind: "unexpected" } });
    data.dependencies.mockResolvedValue(ok([]));
    data.links.mockResolvedValue(ok([]));
    await expect(loadRelations(ctx, "r1")).rejects.toThrow("parent and sub-records");
  });

  it("read a subject's comments and files with their authors' names", async () => {
    const comment = (id: string, author: string) => ({ id, authorPersonId: author });
    data.threads.mockResolvedValue(
      ok([{ id: "t1", comments: [comment("c1", "p1"), comment("c2", "p2")] }]),
    );
    data.attachments.mockResolvedValue(ok([{ id: "a1" }]));
    data.names.mockResolvedValue(new Map([["p1", "Dana Reyes"]]));
    const subject = { table: "app.custom_object_records", id: "c1" };
    const conversation = await loadConversation(ctx, subject);
    expect(data.threads).toHaveBeenCalledWith({}, subject);
    expect(data.names).toHaveBeenCalledWith({}, ["p1", "p2"]);
    expect(conversation.names).toEqual({ p1: "Dana Reyes" });
    expect(conversation.attachments).toHaveLength(1);
  });
});

const messages = getMessages("en-US");
const work = messages.work as unknown as {
  related: Record<"title" | "none" | "parent" | "children" | "links", string>;
};
const schedule = messages.schedule as unknown as {
  dependencies: { before: string; after: string; hidden: string };
};
type IntlProps = ComponentProps<typeof NextIntlClientProvider>;
const intl: Omit<IntlProps, "children"> = { locale: "en-US", timeZone: "UTC", messages };
const render = (element: ReactNode) =>
  renderToStaticMarkup(createElement(NextIntlClientProvider, intl as IntlProps, element));

const empty: RecordRelations = {
  parent: null,
  parentHidden: false,
  children: [],
  waitsOn: [],
  holdsUp: [],
  links: [],
};

describe("the related records section", () => {
  it("links each related record to its full page and each custom object record to its peek", () => {
    const html = render(
      createElement(RelatedRecords, {
        org: "demo-productions",
        recordId: "r1",
        relations: {
          ...empty,
          parent: record("r0", 1),
          children: [record("r2", 3)],
          waitsOn: [{ id: "d1", type: "Finish to Start", record: record("r5", 5) }],
          holdsUp: [{ id: "d2", type: "Start to Start", record: null }],
          links: [
            {
              id: "l1",
              relationKey: "activation_partner",
              objectKey: "sponsors",
              objectLabel: "Sponsors",
              recordId: "c1",
              title: "Acme",
            },
          ],
        },
      }),
    );
    expect(html).toContain(work.related.title);
    for (const heading of [
      work.related.parent,
      work.related.children,
      schedule.dependencies.before,
      schedule.dependencies.after,
      work.related.links,
    ]) {
      expect(html).toContain(heading);
    }
    expect(html).toContain('href="/demo-productions/r/NWS-1"');
    expect(html).toContain('href="/demo-productions/r/NWS-3"');
    expect(html).toContain('href="/demo-productions/r/NWS-5"');
    expect(html).toContain(schedule.dependencies.hidden);
    expect(html).toContain('href="/demo-productions/objects/sponsors?peek=c1"');
    expect(html).toContain("activation partner");
    expect(html).not.toContain(work.related.none);
  });

  it("says when there is nothing related, and lets the dependency editor list dependencies", () => {
    expect(
      render(createElement(RelatedRecords, { org: "o", recordId: "r1", relations: empty })),
    ).toContain(work.related.none);
    const html = render(
      createElement(RelatedRecords, {
        org: "o",
        recordId: "r1",
        relations: {
          ...empty,
          waitsOn: [{ id: "d1", type: "Finish to Start", record: record("r5", 5) }],
        },
        dependencies: createElement("p", null, "dependency editor"),
      }),
    );
    expect(html).toContain("dependency editor");
    expect(html).not.toContain(schedule.dependencies.before);
    expect(html).not.toContain(work.related.none);
  });
});

import { describe, expect, it } from "vitest";
import type { XosClient } from "../src/client.ts";
import {
  createFormLink,
  FIRST_WINDOW_FIELDS,
  formFieldShown,
  formLinkAsksForCode,
  openFormLink,
  parseFormLinkRefusal,
  liveFormAnswers,
  planFormWindows,
  readPublicForm,
  submitPublicForm,
  WINDOW_FIELDS,
  type PublicFormField,
} from "../src/form-links.ts";
import { fakeClient, okResponse, type Response } from "./fake-client.ts";

const TOKEN = `xfrm_${"ab".repeat(32)}`;

function withPublic(queues: Record<string, Response[]>) {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const db = {
    schema: () => ({
      rpc: async (fn: string, args: Record<string, unknown>) => {
        calls.push({ fn, args });
        const next = queues[`rpc:${fn}`]?.shift();
        if (!next) throw new Error(`no queued response for rpc:${fn}`);
        return next;
      },
    }),
  } as unknown as XosClient;
  return { db, calls };
}

const field = (key: string, showIf: PublicFormField["showIf"] = null): PublicFormField => ({
  key,
  label: key,
  kind: "text",
  required: false,
  choices: null,
  showIf,
});

describe("the form's windows", () => {
  it("does not let a stale answer of a hidden field keep its dependant showing", () => {
    const fields = [
      field("first"),
      field("second", { key: "first", equals: "yes" }),
      field("third", { key: "second", equals: "yes" }),
    ];
    // Answered down the chain, then the first answer changed: second hides, so third must too.
    const answers = { first: "no", second: "yes", third: "x" };
    expect(liveFormAnswers(fields, answers)).toEqual({ first: "no" });
    expect(
      planFormWindows(fields, answers)
        .flat()
        .map((f) => f.key),
    ).toEqual(["first"]);
    // Changing it back brings the stale answers back with their fields.
    const back = { ...answers, first: "yes" };
    expect(liveFormAnswers(fields, back)).toEqual(back);
  });

  it("never holds more than seven visible fields with name and email in the first", () => {
    const fields = Array.from({ length: 30 }, (_, i) => field(`f${i}`));
    const windows = planFormWindows(fields, {});
    expect(windows[0]).toHaveLength(FIRST_WINDOW_FIELDS);
    expect((windows[0]?.length ?? 0) + 2).toBeLessThanOrEqual(7);
    for (const w of windows.slice(1)) expect(w.length).toBeLessThanOrEqual(WINDOW_FIELDS);
    expect(windows.flat()).toHaveLength(30);
  });

  it("has one window for a short form", () => {
    expect(planFormWindows([field("a")], {})).toHaveLength(1);
    expect(planFormWindows([], {})).toEqual([[]]);
  });

  it("moves a show_if field across windows as answers change", () => {
    const fields = [
      field("trigger"),
      field("a"),
      field("b"),
      field("c"),
      field("hidden", { key: "trigger", equals: "yes" }),
      field("d"),
      field("e"),
    ];
    const without = planFormWindows(fields, {});
    expect(without.flat().map((f) => f.key)).not.toContain("hidden");
    const shown = planFormWindows(fields, { trigger: "yes" });
    expect(shown[0]?.map((f) => f.key)).toContain("hidden");
    expect(shown[1]?.map((f) => f.key)).toEqual(["d", "e"]);
  });

  it("decides a condition as private.form_field_shown does", () => {
    const f = field("x", { key: "k", equals: "v" });
    expect(formFieldShown(field("y"), {})).toBe(true);
    expect(formFieldShown(f, { k: "v" })).toBe(true);
    expect(formFieldShown(f, { k: "w" })).toBe(false);
    expect(formFieldShown(f, { k: ["w", "v"] })).toBe(true);
    expect(formFieldShown(field("z", { key: "k", equals: false }), { k: false })).toBe(true);
    expect(formFieldShown(f, {})).toBe(false);
  });
});

describe("form links", () => {
  it("returns the token and code once", async () => {
    const { db: client } = fakeClient({
      "rpc:create_form_link": [
        okResponse([{ form_link_id: "l", token: TOKEN, access_code: "123456", expires_at: "x" }]),
      ],
    });
    expect(
      await createFormLink(client, {
        templateId: "t",
        expiresAt: "x",
        projectId: null,
        dailyCap: 200,
        maxResponses: null,
        onePerEmail: true,
        note: null,
      }),
    ).toMatchObject({ data: { id: "l", accessCode: "123456" } });
  });

  it("knows the refusals, the same codes app.submit_form gives", () => {
    expect(parseFormLinkRefusal("form_answer_choice")).toBe("form_answer_choice");
    expect(parseFormLinkRefusal("nope")).toBe("form_link_invalid");
    expect(formLinkAsksForCode("form_link_grant")).toBe(true);
    expect(formLinkAsksForCode("form_link_too_fast")).toBe(false);
  });

  it("never calls for a token of the wrong shape", async () => {
    const { db, calls } = withPublic({});
    expect(
      await openFormLink(db, { token: "x", accessCode: null, clientAddress: null }),
    ).toMatchObject({ data: { refused: true } });
    expect(calls).toHaveLength(0);
  });

  it("reads only the fields the page renders", async () => {
    const { db } = withPublic({
      "rpc:public_form": [
        okResponse({
          status: "ok",
          meta: { brand_name: "N", expires_at: "x" },
          name: "Check",
          description: null,
          fields: [
            {
              key: "a",
              label: "A",
              kind: "choice",
              required: true,
              choices: ["x"],
              show_if: { key: "b", equals: 1 },
            },
          ],
        }),
      ],
    });
    expect(
      await readPublicForm(db, { token: TOKEN, grant: "g", clientAddress: null }),
    ).toMatchObject({
      data: {
        name: "Check",
        fields: [{ key: "a", required: true, choices: ["x"], showIf: { key: "b", equals: 1 } }],
      },
    });
  });

  it("sends an empty honeypot as null and maps a refusal", async () => {
    const { db, calls } = withPublic({
      "rpc:submit_public_form": [
        okResponse({ status: "ok" }),
        okResponse({ status: "refused", reason: "form_link_too_fast" }),
      ],
    });
    const input = {
      token: TOKEN,
      grant: "g",
      name: "R",
      email: "r@x.test",
      answers: {},
      website: "",
      clientAddress: null,
    };
    expect(await submitPublicForm(db, input)).toEqual({ ok: true, data: { refused: false } });
    expect(calls[0]?.args["p_website"]).toBeNull();
    expect(await submitPublicForm(db, input)).toMatchObject({
      data: { refused: true, reason: "form_link_too_fast" },
    });
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * B13 (RRR-237, S14.5-01): the Send flow's server actions. A send that succeeds is never rolled back by
 * a failed link; the page is not revalidated while the dialog holds a link shown once; and a link's
 * lifetime comes from the database, never from the form that asked for it.
 */

const state = vi.hoisted(() => ({
  send: { ok: true, data: { engagementDocumentId: "d1", contentSha256: "a" } } as unknown,
  window: { ok: true, data: { validUntil: "2099-01-01", timeZone: "UTC" } } as unknown,
  hours: 48,
  issue: {
    data: [{ token: "xdoc_token", access_code: "123456", expires_at: "2099-01-01T00:00:00Z" }],
    error: null,
  } as { data: unknown; error: unknown },
  rpc: vi.fn(),
  revalidate: vi.fn(),
  update: vi.fn(),
  draft: vi.fn(),
  windows: [] as unknown[],
}));

vi.mock("next/cache", () => ({ revalidatePath: state.revalidate }));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("not found");
  },
}));
vi.mock("@/lib/gateway-url", () => ({ gatewayUrl: (path: string) => `https://g.test${path}` }));
vi.mock("@/lib/observability", () => ({ observability: { logger: { error: vi.fn() } } }));
vi.mock("@/lib/shell/context", () => ({
  getOrgContext: async () => ({ org: { slug: "acme" }, viewer: { db: { rpc: state.rpc } } }),
}));
vi.mock("@xos/data/budget-transactions", () => ({}));
vi.mock("@xos/data/budget-versions", () => ({}));
vi.mock("@xos/data/quotes", () => ({
  sendQuoteVersion: vi.fn(async () => state.send),
  quoteLinkWindow: vi.fn(async (_db: unknown, where: unknown) => {
    state.windows.push(where);
    return state.window;
  }),
  signingLinkHours: vi.fn(() => state.hours),
  updateQuote: state.update,
  updateQuoteDraft: state.draft,
}));

const { quoteSigningLinkAction, saveQuoteDraftAction, sendQuoteAction } =
  await import("@/app/[org]/finance/quote-actions");

const VERSION = "0192f1e2-7c3a-7b4d-9e8f-000000000001";
const QUOTE = "0192f1e2-7c3a-7b4d-9e8f-000000000002";
const DOCUMENT = "0192f1e2-7c3a-7b4d-9e8f-000000000003";

function form(values: Record<string, string>): FormData {
  const data = new FormData();
  for (const [k, v] of Object.entries(values)) data.set(k, v);
  return data;
}
const sendForm = (email: string) => form({ org: "acme", versionId: VERSION, reason: "", email });

beforeEach(() => {
  state.send = { ok: true, data: { engagementDocumentId: DOCUMENT, contentSha256: "a" } };
  state.window = { ok: true, data: { validUntil: "2099-01-01", timeZone: "UTC" } };
  state.hours = 48;
  state.issue = {
    data: [{ token: "xdoc_token", access_code: "123456", expires_at: "2099-01-01T00:00:00Z" }],
    error: null,
  };
  state.windows = [];
  state.rpc.mockReset();
  state.rpc.mockImplementation(async () => state.issue);
  state.revalidate.mockReset();
  state.update.mockReset();
  state.update.mockResolvedValue({ ok: true, data: null });
  state.draft.mockReset();
  state.draft.mockResolvedValue({ ok: true, data: null });
});

describe("sendQuoteAction", () => {
  it("returns the link and code once, and does not refresh under the open dialog", async () => {
    const result = await sendQuoteAction({}, sendForm("client@example.test"));
    expect(result.ok).toBe(true);
    expect(result.link).toEqual({
      url: "https://g.test/sign/xdoc_token",
      accessCode: "123456",
      expiresAt: "2099-01-01T00:00:00Z",
    });
    expect(state.revalidate).not.toHaveBeenCalled();
  });

  it("reads the link's window from the document the send created, with the hours it allows", async () => {
    state.hours = 20;
    await sendQuoteAction({}, sendForm("client@example.test"));
    expect(state.windows).toEqual([{ documentId: DOCUMENT }]);
    expect(state.rpc.mock.calls[0]?.[1]).toMatchObject({ p_valid_for: "20 hours" });
  });

  it("ignores a valid until and time zone sent with the form", async () => {
    const data = sendForm("client@example.test");
    data.set("validUntil", "2199-01-01");
    data.set("timeZone", "Pacific/Kiritimati");
    await sendQuoteAction({}, data);
    expect(state.windows).toEqual([{ documentId: DOCUMENT }]);
  });

  it("says the quote was sent when the link fails, and offers the retry", async () => {
    state.issue = { data: null, error: { message: "boom" } };
    const result = await sendQuoteAction({}, sendForm("client@example.test"));
    expect(result).toMatchObject({ ok: true, linkFailed: true });
    expect(result.link).toBeUndefined();
  });

  it("issues no link with under an hour left, and the client signs in Gateway", async () => {
    state.hours = 0;
    const result = await sendQuoteAction({}, sendForm("client@example.test"));
    expect(result).toMatchObject({ ok: true, noLinkTime: true });
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("issues no link without an email", async () => {
    const result = await sendQuoteAction({}, sendForm(""));
    expect(result.ok).toBe(true);
    expect(result.link).toBeUndefined();
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("carries a refused send's rule, and asks for no link", async () => {
    state.send = {
      ok: false,
      error: { kind: "refusal", rule: "quote_client_engagement", message: "No client." },
    };
    const result = await sendQuoteAction({}, sendForm("client@example.test"));
    expect(result.ok).toBeUndefined();
    expect(result.error).toMatchObject({ kind: "refusal", rule: "quote_client_engagement" });
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("marks a bad email on its field", async () => {
    const result = await sendQuoteAction({}, sendForm("not an email"));
    expect(result.fieldErrors).toEqual({ email: "email" });
  });
});

describe("quoteSigningLinkAction", () => {
  it("reissues against the document, within the database's window", async () => {
    const result = await quoteSigningLinkAction(
      {},
      form({ org: "acme", documentId: DOCUMENT, email: "client@example.test" }),
    );
    expect(result.link?.accessCode).toBe("123456");
    expect(state.windows).toEqual([{ documentId: DOCUMENT }]);
  });
});

describe("saveQuoteDraftAction", () => {
  const draft = (over: Record<string, string> = {}) =>
    form({
      org: "acme",
      quoteId: QUOTE,
      versionId: VERSION,
      title: "Main stage",
      validUntil: "2099-01-01",
      terms: "",
      ...over,
    });

  it("sets the client engagement while it can still change, so a quote can reach Send", async () => {
    const engagement = "0192f1e2-7c3a-7b4d-9e8f-000000000004";
    expect((await saveQuoteDraftAction({}, draft({ engagementId: engagement }))).ok).toBe(true);
    expect(state.update).toHaveBeenCalledWith(expect.anything(), QUOTE, {
      title: "Main stage",
      engagementId: engagement,
    });
    expect(state.draft).toHaveBeenCalled();
  });

  it("leaves the engagement alone once the form no longer offers it", async () => {
    await saveQuoteDraftAction({}, draft());
    expect(state.update).toHaveBeenCalledWith(expect.anything(), QUOTE, { title: "Main stage" });
  });

  it("reads None as no engagement", async () => {
    await saveQuoteDraftAction({}, draft({ engagementId: "" }));
    expect(state.update).toHaveBeenCalledWith(expect.anything(), QUOTE, {
      title: "Main stage",
      engagementId: null,
    });
  });

  it("needs a title, and writes nothing without one", async () => {
    const result = await saveQuoteDraftAction({}, draft({ title: "  " }));
    expect(result.fieldErrors).toEqual({ title: "title" });
    expect(state.update).not.toHaveBeenCalled();
  });

  it("stops at a refused quote edit before touching the version", async () => {
    state.update.mockResolvedValue({
      ok: false,
      error: { kind: "refusal", rule: "quote_client_engagement", message: "No." },
    });
    const result = await saveQuoteDraftAction({}, draft());
    expect(result.error).toMatchObject({ rule: "quote_client_engagement" });
    expect(state.draft).not.toHaveBeenCalled();
  });
});

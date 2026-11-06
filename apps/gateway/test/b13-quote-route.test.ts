import { beforeEach, describe, expect, it, vi } from "vitest";

/** B13 (RRR-237): a signing link's PDF. POST only, same-origin only, re-resolved through api_public.token_quote. */

const state = vi.hoisted(() => ({
  read: { ok: true, data: { refused: false, quote: { quote_key: "NWF26-Q-14" } } } as unknown,
  generate: vi.fn(),
}));

vi.mock("@xos/data/gateway", () => ({ previewTokenQuote: vi.fn(async () => state.read) }));
vi.mock("@xos/data/documents/generate", () => ({ generateTokenQuoteDocument: state.generate }));
vi.mock("@xos/i18n/load", () => ({ loadMessages: vi.fn(async () => ({ documents: {} })) }));
vi.mock("next-intl/server", () => ({ getLocale: vi.fn(async () => "en-US") }));
vi.mock("@/lib/env", () => ({ env: () => ({ GATEWAY_SITE_URL: "https://gateway.example.test" }) }));
vi.mock("@/lib/observability", () => ({ observability: { logger: { error: vi.fn() } } }));
vi.mock("@/lib/supabase/server", () => ({ createServerSupabase: vi.fn(async () => ({})) }));

const { POST } = await import("../app/(public)/sign/[token]/quote/route");

const TOKEN = `xdoc_${"a".repeat(64)}`;
const context = { params: Promise.resolve({ token: TOKEN }) } as never;

function post(body: Record<string, string>, headers: Record<string, string> = {}) {
  const form = new FormData();
  for (const [k, v] of Object.entries(body)) form.set(k, v);
  return new Request(`https://gateway.example.test/sign/${TOKEN}/quote`, {
    method: "POST",
    body: form,
    headers,
  });
}

beforeEach(() => {
  state.generate.mockReset();
  state.generate.mockResolvedValue({
    ok: true,
    data: {
      bytes: new Uint8Array([37, 80]),
      fileName: "quote-NWF26-Q-14-v1-letter.pdf",
      templateVersion: 1,
    },
  });
  state.read = { ok: true, data: { refused: false, quote: { quote_key: "NWF26-Q-14" } } };
});

describe("POST /sign/{token}/quote", () => {
  it("streams the PDF from what the token reader returned", async () => {
    const response = await POST(
      post({ accessCode: "123456" }, { "sec-fetch-site": "same-origin" }),
      context,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/pdf");
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(state.generate.mock.calls[0]?.[0]).toMatchObject({ quote: { quote_key: "NWF26-Q-14" } });
  });

  it("refuses a cross-site post", async () => {
    const response = await POST(
      post({ accessCode: "123456" }, { "sec-fetch-site": "cross-site" }),
      context,
    );
    expect(response.status).toBe(403);
    expect(state.generate).not.toHaveBeenCalled();
  });

  it("answers 404 for a wrong code, without building anything", async () => {
    state.read = { ok: true, data: { refused: true, reason: "document_access_code" } };
    const response = await POST(post({ accessCode: "000000" }), context);
    expect(response.status).toBe(404);
    expect(state.generate).not.toHaveBeenCalled();
  });

  it("answers 404 for a malformed link", async () => {
    const response = await POST(post({ accessCode: "123456" }), {
      params: Promise.resolve({ token: "../etc" }),
    } as never);
    expect(response.status).toBe(404);
  });
});

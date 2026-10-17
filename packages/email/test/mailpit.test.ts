import { describe, expect, it } from "vitest";
import { createTransport, readEmailEnv } from "../src/env.ts";
import { EmailSendError, MailpitTransport, RecordingTransport } from "../src/transport.ts";

const message = {
  from: "Demo Productions <notifications@xos.localhost>",
  to: "vendor@example.com",
  replyTo: "reply@xos.localhost",
  subject: "Invoice submitted: DSS-1",
  html: "<p>Received.</p>",
  text: "Received.",
  headers: { "X-Entity-Ref-ID": "d1" },
  tags: [{ name: "kind", value: "invoice_submitted" }],
};

function recorder(status: number, body: unknown) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

describe("Mailpit transport", () => {
  it("posts the message to the local inbox's send API", async () => {
    const { calls, fetchImpl } = recorder(200, { ID: "abc123" });
    const transport = new MailpitTransport("http://127.0.0.1:58324", fetchImpl);
    expect(await transport.send(message)).toEqual({ providerMessageId: "mailpit-abc123" });
    expect(calls[0]?.url).toBe("http://127.0.0.1:58324/api/v1/send");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      From: { Email: "notifications@xos.localhost", Name: "Demo Productions" },
      To: [{ Email: "vendor@example.com" }],
      ReplyTo: [{ Email: "reply@xos.localhost" }],
      Subject: "Invoice submitted: DSS-1",
      HTML: "<p>Received.</p>",
      Text: "Received.",
      Headers: { "X-Entity-Ref-ID": "d1" },
      Tags: ["invoice_submitted"],
    });
  });

  it("sends a bare address without optional parts", async () => {
    const { calls, fetchImpl } = recorder(200, { ID: "x" });
    const transport = new MailpitTransport("http://supabase_inbucket_xos4-a44:8025", fetchImpl);
    await transport.send({
      from: "a@xos.localhost",
      to: "b@example.com",
      subject: "S",
      html: "",
      text: "",
    });
    const body = JSON.parse(String(calls[0]?.init?.body)) as Record<string, unknown>;
    expect(body["From"]).toEqual({ Email: "a@xos.localhost" });
    expect(body["ReplyTo"]).toBeUndefined();
    expect(body["Headers"]).toBeUndefined();
  });

  it("refuses an inbox that is not local", () => {
    expect(() => new MailpitTransport("https://mail.example.com")).toThrow(/only to a local inbox/);
  });

  it("turns a refusal or a missing id into a send error", async () => {
    const refused = new MailpitTransport("http://localhost:58324", recorder(400, {}).fetchImpl);
    await expect(refused.send(message)).rejects.toBeInstanceOf(EmailSendError);
    const noId = new MailpitTransport("http://localhost:58324", recorder(200, {}).fetchImpl);
    await expect(noId.send(message)).rejects.toThrow(/no message id/);
  });

  it("is chosen by XOS_EMAIL_TRANSPORT=mailpit, which needs the inbox URL", () => {
    expect(() => readEmailEnv({ XOS_EMAIL_TRANSPORT: "mailpit" })).toThrow(/XOS_EMAIL_MAILPIT_URL/);
    const env = readEmailEnv({
      XOS_EMAIL_TRANSPORT: "mailpit",
      XOS_EMAIL_MAILPIT_URL: "http://127.0.0.1:58324",
    });
    expect(createTransport(env)).toBeInstanceOf(MailpitTransport);
    expect(createTransport(readEmailEnv({}))).toBeInstanceOf(RecordingTransport);
  });
});

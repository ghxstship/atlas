import { describe, expect, it } from "vitest";
import {
  attachmentName,
  mailpitMailer,
  resendMailer,
  runReportDeliveries,
  toBase64,
  type DeliveryCopy,
  type ReportDelivery,
  type ReportDeliveryStore,
  type ReportEmail,
  type ReportMailer,
} from "../src/report-deliveries.ts";

const delivery: ReportDelivery = {
  deliveryId: "d-1",
  orgName: "Demo Productions",
  reportName: "Spend by Account",
  exportFormat: "PDF",
  storagePath: "org-1/run-1.pdf",
  rowCount: 2,
  unpricedCount: 1,
  recipientEmail: "producer@example.com",
  recipientName: "Demo Producer",
  status: "Queued",
  scheduledFor: "2026-10-19T13:00:00Z",
};

const copy: DeliveryCopy = {
  subject: ({ report, org }) => `${report} from ${org}`,
  body: ({ report, rows, unpriced }) => `${report}: ${rows} rows, ${unpriced} unpriced.`,
};

function fakeStore(found: ReportDelivery | null, jobStatusOnFailure = "Queued") {
  const calls = {
    finished: [] as { id: string; outcome: unknown }[],
    jobs: [] as { jobId: string; succeeded: boolean; error: string | null }[],
  };
  const store: ReportDeliveryStore = {
    queueDue: async () => 0,
    claim: async () => [{ jobId: "job-1", deliveryId: "d-1" }],
    delivery: async () => found,
    finish: async (id, outcome) => {
      calls.finished.push({ id, outcome });
    },
    finishJob: async (jobId, succeeded, error) => {
      calls.jobs.push({ jobId, succeeded, error });
      return succeeded ? "Succeeded" : jobStatusOnFailure;
    },
  };
  return { store, calls };
}

function recordingMailer(): ReportMailer & { sent: ReportEmail[] } {
  const sent: ReportEmail[] = [];
  return { name: "record", sent, send: async (e) => (sent.push(e), { messageId: "m-1" }) };
}

const files = { download: async () => new TextEncoder().encode("%PDF-1.7 report") };

describe("the report.deliver worker", () => {
  it("emails the run's file to the recipient and records it sent (A38-004)", async () => {
    const { store, calls } = fakeStore(delivery);
    const mailer = recordingMailer();
    const results = await runReportDeliveries({ store, files, mailer, copy, worker: "t" });
    expect(results).toEqual([{ jobId: "job-1", deliveryId: "d-1", status: "Sent" }]);
    expect(mailer.sent[0]).toMatchObject({
      to: "producer@example.com",
      subject: "Spend by Account from Demo Productions",
      text: "Spend by Account: 2 rows, 1 unpriced.",
      attachment: { filename: "spend-by-account.pdf", contentType: "application/pdf" },
    });
    expect(calls.finished).toEqual([{ id: "d-1", outcome: { sent: true, messageId: "m-1" } }]);
  });

  it("retries a failed send while the job has attempts, then fails the delivery", async () => {
    const broken: ReportMailer = {
      name: "broken",
      send: async () => {
        throw new Error("connection refused");
      },
    };
    const retry = fakeStore(delivery);
    const first = await runReportDeliveries({ ...retry, files, mailer: broken, copy, worker: "t" });
    expect(first[0]).toMatchObject({ status: "Queued", error: "connection refused" });
    expect(retry.calls.finished).toEqual([]);
    const last = fakeStore(delivery, "Failed");
    const final = await runReportDeliveries({ ...last, files, mailer: broken, copy, worker: "t" });
    expect(final[0]?.status).toBe("Failed");
    expect(last.calls.finished[0]?.outcome).toEqual({ sent: false, error: "connection refused" });
  });

  it("skips a finished delivery and fails one with no address", async () => {
    const done = fakeStore({ ...delivery, status: "Sent" });
    const mailer = recordingMailer();
    expect(
      (await runReportDeliveries({ ...done, files, mailer, copy, worker: "t" }))[0]?.status,
    ).toBe("Skipped");
    const noMail = fakeStore({ ...delivery, recipientEmail: null }, "Failed");
    const out = await runReportDeliveries({ ...noMail, files, mailer, copy, worker: "t" });
    expect(out[0]?.error).toBe("The recipient has no email address on file.");
    expect(mailer.sent).toEqual([]);
  });

  it("sends to the local Mailpit only, with the file as a base64 attachment", async () => {
    const requests: { url: string; body: Record<string, unknown> }[] = [];
    const fakeFetch = (async (url: URL, init: RequestInit) => {
      requests.push({ url: String(url), body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ ID: "abc" }), { status: 200 });
    }) as unknown as typeof fetch;
    const mailer = mailpitMailer(
      "http://127.0.0.1:58224",
      { email: "reports@xos.test", name: "XOS" },
      fakeFetch,
    );
    const sent = await mailer.send({
      to: "producer@example.com",
      toName: "Demo Producer",
      subject: "S",
      text: "T",
      html: "<p>T</p>",
      attachment: {
        filename: "r.pdf",
        contentType: "application/pdf",
        content: new Uint8Array([1, 2]),
      },
    });
    expect(sent.messageId).toBe("abc");
    expect(requests[0]?.url).toBe("http://127.0.0.1:58224/api/v1/send");
    expect(requests[0]?.body["Attachments"]).toEqual([
      { Content: "AQI=", Filename: "r.pdf", ContentType: "application/pdf" },
    ]);
    expect(() => mailpitMailer("https://mail.example.com", { email: "a@b.c", name: "X" })).toThrow(
      /only sends to a local inbox/,
    );
  });

  it("keeps Resend to the allow-list", async () => {
    const payloads: unknown[] = [];
    const client = {
      emails: {
        send: async (p: unknown) => (payloads.push(p), { data: { id: "re-1" }, error: null }),
      },
    };
    const mailer = resendMailer(client, "XOS <reports@xos.test>", (a) => a.endsWith("@xos.test"));
    const email = {
      to: "someone@elsewhere.com",
      toName: null,
      subject: "S",
      text: "T",
      html: "T",
      attachment: { filename: "r.csv", contentType: "text/csv", content: new Uint8Array([65]) },
    };
    await expect(mailer.send(email)).rejects.toThrow(/allow-list/);
    expect(payloads).toEqual([]);
    expect((await mailer.send({ ...email, to: "ok@xos.test" })).messageId).toBe("re-1");
  });

  it("names attachments and encodes bytes portably", () => {
    expect(attachmentName("Labor by Department (Q4)", "XLSX")).toBe("labor-by-department-q4.xlsx");
    expect(attachmentName("!!!", "CSV")).toBe("report.csv");
    expect(toBase64(new TextEncoder().encode("hello"))).toBe("aGVsbG8=");
  });
});

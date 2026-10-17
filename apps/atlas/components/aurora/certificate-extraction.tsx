"use client";

import { createAuroraClient, type AuroraSuggestion } from "@xos/ai/client";
import { Button, InlineAlert, Select } from "@xos/ui";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useState } from "react";

type Translate = (key: string, values?: Record<string, string | number>) => string;

const MAX_BYTES = 10 * 1024 * 1024;
const MEDIA = ["application/pdf", "text/plain", "image/png", "image/jpeg", "image/webp"] as const;
type Media = (typeof MEDIA)[number];
/** Fields insuranceCertificates.create cannot do without; a NO ANSWER on one blocks confirming. */
const REQUIRED = ["insurer", "policy_identifier", "coverage_type", "valid_from", "valid_to"];
const INSURED_OPERATION = "insuranceCertificateInsureds.create";
const ENDORSEMENTS = ["Additional Insured", "Primary and Noncontributory", "Waiver of Subrogation"];

/** A proposed field's value, or null when it was not read. */
function read(s: AuroraSuggestion, path: string): string | null {
  const f = s.proposed_fields.find((x) => x.field_path === path);
  return f && f.refusal === null && f.proposed_value !== null ? String(f.proposed_value) : null;
}

/** The endorsement to write: the one read when it is a known kind, otherwise Additional Insured. */
function endorsementOf(s: AuroraSuggestion): string {
  const value = read(s, "endorsement_kind");
  return value !== null && ENDORSEMENTS.includes(value) ? value : "Additional Insured";
}

type Phase =
  | { readonly kind: "idle" }
  | { readonly kind: "running" }
  | {
      readonly kind: "review";
      readonly suggestion: AuroraSuggestion;
      readonly insureds: readonly AuroraSuggestion[];
      readonly busy: boolean;
    }
  | {
      readonly kind: "message";
      readonly tone: "info" | "success" | "warning" | "danger";
      readonly text: string;
    };

async function toBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/**
 * Journey 36 (Section 4.7, Section 20.2): Aurora reads an insurance certificate into proposed
 * fields, each with its confidence and the words it came from; the person reviews them and either
 * confirms, which writes the certificate through insuranceCertificates.create as them, or discards
 * the proposal. Nothing is saved before the confirmation. Shown only when extraction is on.
 */
export function CertificateExtraction({
  vendors,
}: {
  vendors: readonly { readonly value: string; readonly label: string }[];
}) {
  const t = useTranslations("auroraCertificates") as unknown as Translate;
  const router = useRouter();
  const client = useMemo(() => createAuroraClient({ baseUrl: "/api/v1" }), []);
  const [enabled, setEnabled] = useState(false);
  const [vendor, setVendor] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });

  useEffect(() => {
    let live = true;
    void client.status().then((r) => {
      if (live) setEnabled(r.ok && r.data.enabled_features.includes("extraction"));
    });
    return () => {
      live = false;
    };
  }, [client]);

  if (!enabled) return null;

  const extract = async () => {
    if (!file) return;
    if (vendor === "") {
      setPhase({ kind: "message", tone: "warning", text: t("needVendor") });
      return;
    }
    if (file.size > MAX_BYTES) {
      setPhase({ kind: "message", tone: "warning", text: t("tooLarge") });
      return;
    }
    const media: Media = (MEDIA as readonly string[]).includes(file.type)
      ? (file.type as Media)
      : "text/plain";
    setPhase({ kind: "running" });
    const result = await client.extract({
      kind: "insurance_certificate",
      media_type: media,
      content_base64: await toBase64(file),
      file_name: file.name,
    });
    if (!result.ok) {
      setPhase({ kind: "message", tone: "danger", text: result.problem.detail });
      return;
    }
    if (result.data.outcome === "no_answer") {
      setPhase({
        kind: "message",
        tone: "info",
        text: t("noAnswer", { missing: result.data.missing ?? "" }),
      });
      return;
    }
    const header = result.data.suggestions.find(
      (s) => s.operation_id === "insuranceCertificates.create",
    );
    const loaded = header ? await client.suggestion(header.suggestion_id) : null;
    if (result.data.outcome === "failed" || !loaded || !loaded.ok) {
      setPhase({ kind: "message", tone: "danger", text: t("failed") });
      return;
    }
    const insureds: AuroraSuggestion[] = [];
    for (const line of result.data.suggestions.filter(
      (s) => s.operation_id === INSURED_OPERATION,
    )) {
      const one = await client.suggestion(line.suggestion_id);
      if (one.ok) insureds.push(one.data);
    }
    setPhase({ kind: "review", suggestion: loaded.data, insureds, busy: false });
  };

  /** Confirms each named party against the saved certificate; unreadable names are discarded. */
  const settleInsureds = async (
    insureds: readonly AuroraSuggestion[],
    certificateId: string | null,
  ): Promise<string | null> => {
    for (const line of insureds) {
      const result =
        certificateId !== null && read(line, "insured_name") !== null
          ? await client.confirm(line.id, t("confirmReason"), {
              certificate_id: certificateId,
              endorsement_kind: endorsementOf(line),
            })
          : await client.reject(line.id, t("discardReason"));
      if (!result.ok) return result.problem.detail;
    }
    return null;
  };

  const decide = async (
    suggestion: AuroraSuggestion,
    insureds: readonly AuroraSuggestion[],
    confirm: boolean,
  ) => {
    setPhase({ kind: "review", suggestion, insureds, busy: true });
    const result = confirm
      ? await client.confirm(suggestion.id, t("confirmReason"), { vendor_id: vendor })
      : await client.reject(suggestion.id, t("discardReason"));
    if (!result.ok) {
      setPhase({
        kind: "message",
        tone: "danger",
        text: t("saveFailed", { detail: result.problem.detail }),
      });
      return;
    }
    const lines = await settleInsureds(insureds, confirm ? result.data.applied_id : null);
    if (lines !== null) {
      setPhase({ kind: "message", tone: "danger", text: t("insuredsFailed", { detail: lines }) });
      if (confirm) router.refresh();
      return;
    }
    setPhase({
      kind: "message",
      tone: confirm ? "success" : "info",
      text: confirm ? t("saved") : t("discarded"),
    });
    if (confirm) router.refresh();
  };

  return (
    <section
      aria-labelledby="certificate-extraction-title"
      className="flex flex-col gap-8 rounded-card border border-border-subtle p-12"
    >
      <h3 id="certificate-extraction-title" className="m-0 text-text-14 font-semibold">
        {t("title")}
      </h3>
      <p className="m-0 text-text-12 text-text-secondary">{t("sentence")}</p>
      {phase.kind === "review" ? (
        <Review
          suggestion={phase.suggestion}
          insureds={phase.insureds}
          busy={phase.busy}
          t={t}
          onConfirm={() => void decide(phase.suggestion, phase.insureds, true)}
          onDiscard={() => void decide(phase.suggestion, phase.insureds, false)}
        />
      ) : (
        <div className="flex flex-col gap-8">
          <Select
            label={t("vendor")}
            value={vendor}
            options={[{ value: "", label: t("chooseVendor") }, ...vendors]}
            onChange={(e) => setVendor(e.target.value)}
          />
          <label className="flex flex-col gap-4 text-text-12">
            <span className="font-medium">{t("file")}</span>
            <input
              type="file"
              accept=".pdf,.txt,.png,.jpg,.jpeg,.webp"
              aria-describedby="certificate-extraction-help"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
            <span id="certificate-extraction-help" className="text-text-secondary">
              {t("fileHelp")}
            </span>
          </label>
          <div>
            <Button
              variant="secondary"
              icon="Sparkles"
              loading={phase.kind === "running"}
              disabled={!file || phase.kind === "running"}
              onClick={() => void extract()}
            >
              {t("extract")}
            </Button>
          </div>
        </div>
      )}
      {phase.kind === "running" ? (
        <p role="status" className="m-0 text-text-12 text-text-secondary">
          {t("running")}
        </p>
      ) : null}
      {phase.kind === "message" ? <InlineAlert tone={phase.tone}>{phase.text}</InlineAlert> : null}
    </section>
  );
}

function Review({
  suggestion,
  insureds,
  busy,
  t,
  onConfirm,
  onDiscard,
}: {
  suggestion: AuroraSuggestion;
  insureds: readonly AuroraSuggestion[];
  busy: boolean;
  t: Translate;
  onConfirm: () => void;
  onDiscard: () => void;
}) {
  const blocked = suggestion.proposed_fields.some(
    (f) => REQUIRED.includes(f.field_path) && f.refusal !== null,
  );
  return (
    <div className="flex flex-col gap-8">
      <p className="m-0 text-text-12 text-text-secondary">{t("review")}</p>
      <span className="text-text-11 text-text-tertiary">{t("provenance")}</span>
      <table className="w-full border-collapse text-text-13">
        <caption className="sr-only">{t("caption")}</caption>
        <thead>
          <tr className="text-start text-text-12 text-text-secondary">
            <th scope="col" className="py-4 pe-8 text-start font-medium">
              {t("field")}
            </th>
            <th scope="col" className="py-4 pe-8 text-start font-medium">
              {t("value")}
            </th>
            <th scope="col" className="py-4 text-start font-medium">
              {t("confidence")}
            </th>
          </tr>
        </thead>
        <tbody>
          {suggestion.proposed_fields.map((f) => (
            <tr key={f.field_path} className="border-t border-border-subtle">
              <th scope="row" className="py-4 pe-8 text-start font-normal">
                {t(`fields.${f.field_path}`)}
              </th>
              <td className="py-4 pe-8">
                {f.refusal !== null
                  ? t("notRead", { missing: f.missing ?? "" })
                  : String(f.proposed_value)}
              </td>
              <td className="py-4">
                {f.refusal === null && f.confidence !== null
                  ? t("confidenceValue", { percent: Math.round(f.confidence * 100) })
                  : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <InsuredList insureds={insureds} t={t} />
      {blocked ? <InlineAlert tone="warning">{t("missingRequired")}</InlineAlert> : null}
      <div className="flex flex-wrap gap-8">
        <Button variant="primary" loading={busy} disabled={blocked || busy} onClick={onConfirm}>
          {t("confirm")}
        </Button>
        <Button variant="ghost" disabled={busy} onClick={onDiscard}>
          {t("discard")}
        </Button>
      </div>
    </div>
  );
}

/** The parties the certificate names, as read, each saved with the certificate on confirm. */
function InsuredList({ insureds, t }: { insureds: readonly AuroraSuggestion[]; t: Translate }) {
  return (
    <section aria-labelledby="extraction-insureds-title" className="flex flex-col gap-4">
      <h4 id="extraction-insureds-title" className="m-0 text-text-13 font-semibold">
        {t("insuredsTitle")}
      </h4>
      {insureds.length === 0 ? (
        <p className="m-0 text-text-12 text-text-secondary">{t("insuredsNone")}</p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-2 p-0 text-text-13">
          {insureds.map((line) => {
            const name = read(line, "insured_name");
            return (
              <li key={line.id}>
                {name === null
                  ? t("insuredNotRead")
                  : t("insuredLine", { name, endorsement: endorsementOf(line) })}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

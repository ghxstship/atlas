"use client";

import { createAuroraClient, type AuroraSuggestion } from "@xos/ai/client";
import type { RiderLineProposal } from "@xos/data/advancing";
import { Button, InlineAlert } from "@xos/ui";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useState } from "react";
import { RiderProposalReview } from "@/components/advancing/forms";
import { confirmRiderExtractionAction } from "./rider-actions";

type Translate = (key: string, values?: Record<string, string | number>) => string;

const MAX_BYTES = 10 * 1024 * 1024;
const MEDIA = ["application/pdf", "text/plain", "image/png", "image/jpeg", "image/webp"] as const;
type Media = (typeof MEDIA)[number];

interface Proposal extends RiderLineProposal {
  readonly suggestionId: string;
}

type Phase =
  | { readonly kind: "idle" }
  | { readonly kind: "running" }
  | {
      readonly kind: "review";
      readonly proposals: readonly Proposal[];
      readonly others: readonly string[];
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

/** A rider line proposal from one extracted line suggestion; null when its ask was NO ANSWER. */
export function proposalFrom(s: AuroraSuggestion): Proposal | null {
  const description = s.proposed_fields.find((f) => f.field_path === "description");
  if (
    !description ||
    description.refusal !== null ||
    typeof description.proposed_value !== "string"
  ) {
    return null;
  }
  const quantity = s.proposed_fields.find((f) => f.field_path === "quantity");
  const confidences = s.proposed_fields
    .map((f) => f.confidence)
    .filter((c): c is number => c !== null);
  return {
    suggestionId: s.id,
    description: description.proposed_value,
    elementId: null,
    quantity:
      quantity && quantity.refusal === null && typeof quantity.proposed_value === "number"
        ? quantity.proposed_value
        : null,
    confidence: confidences.length === 0 ? 0 : Math.min(...confidences),
    source: description.source_excerpt,
  };
}

/**
 * Aurora's rider extraction (Section 4.7) on a rider page: the person chooses the rider file,
 * Aurora proposes its asks through the public API, and A10's RiderProposalReview lets them pick
 * which to keep. Only confirmed lines are stored. Shown only when document extraction is on.
 */
export function RiderExtraction({ org, riderId }: { org: string; riderId: string }) {
  const t = useTranslations("aurora.extraction") as unknown as Translate;
  const router = useRouter();
  const client = useMemo(() => createAuroraClient({ baseUrl: "/api/v1" }), []);
  const [enabled, setEnabled] = useState(false);
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
    if (file.size > MAX_BYTES) {
      setPhase({ kind: "message", tone: "warning", text: t("tooLarge") });
      return;
    }
    const media: Media = (MEDIA as readonly string[]).includes(file.type)
      ? (file.type as Media)
      : "text/plain";
    setPhase({ kind: "running" });
    const result = await client.extract({
      kind: "rider",
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
    if (result.data.outcome === "failed") {
      setPhase({ kind: "message", tone: "danger", text: t("failed") });
      return;
    }
    const lines = result.data.suggestions.filter((s) => s.operation_id === "riderLines.create");
    const header = result.data.suggestions.filter((s) => s.operation_id !== "riderLines.create");
    const loaded = await Promise.all(lines.map((s) => client.suggestion(s.suggestion_id)));
    const proposals: Proposal[] = [];
    const others = header.map((s) => s.suggestion_id);
    loaded.forEach((r, i) => {
      const p = r.ok ? proposalFrom(r.data) : null;
      if (p) proposals.push(p);
      else others.push(lines[i]?.suggestion_id ?? "");
    });
    setPhase(
      proposals.length === 0
        ? { kind: "message", tone: "info", text: t("noLines") }
        : { kind: "review", proposals, others: others.filter((id) => id !== "") },
    );
  };

  return (
    <section className="flex flex-col gap-8" aria-label={t("button")}>
      {phase.kind === "review" ? (
        <>
          <p className="m-0 text-text-12 text-text-secondary">{t("review")}</p>
          <RiderProposalReview
            proposals={phase.proposals}
            onConfirm={async (chosen) => {
              const chosenIds = new Set((chosen as readonly Proposal[]).map((c) => c.suggestionId));
              const result = await confirmRiderExtractionAction({
                org,
                riderId,
                chosen: (chosen as readonly Proposal[]).map((c) => ({
                  suggestionId: c.suggestionId,
                  description: c.description,
                  quantity: c.quantity,
                  confidence: c.confidence,
                  source: c.source,
                })),
                others: [
                  ...phase.others,
                  ...phase.proposals
                    .filter((p) => !chosenIds.has(p.suggestionId))
                    .map((p) => p.suggestionId),
                ],
              });
              setPhase({
                kind: "message",
                tone: result.ok ? (result.error ? "warning" : "success") : "danger",
                text: result.ok
                  ? result.error
                    ? t("suggestionsOpen")
                    : t("saved")
                  : t("saveFailed"),
              });
              if (result.ok) router.refresh();
            }}
          />
        </>
      ) : (
        <div className="flex flex-wrap items-end gap-8">
          <label className="flex flex-col gap-4 text-text-12">
            <span className="font-medium">{t("fileLabel")}</span>
            <input
              type="file"
              accept=".pdf,.txt,.png,.jpg,.jpeg,.webp"
              aria-describedby="rider-extraction-help"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
            <span id="rider-extraction-help" className="text-text-secondary">
              {t("fileHelp")}
            </span>
          </label>
          <Button
            variant="secondary"
            icon="Sparkles"
            loading={phase.kind === "running"}
            disabled={!file || phase.kind === "running"}
            onClick={() => void extract()}
          >
            {t("button")}
          </Button>
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

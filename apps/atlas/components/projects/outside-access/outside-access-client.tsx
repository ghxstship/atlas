"use client";

import type { OutsideAccessRow, OutsideAccessSource } from "@xos/data/outside-access";
import { Button, Tag } from "@xos/ui";
import type { Route } from "next";
import NextLink from "next/link";
import { useRouter } from "next/navigation";
import { useFormatter, useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { onDemand, useOnDemand } from "@/components/shell/on-demand";
import {
  regenerateSourceAction,
  resetRecipientCodeAction,
  revokeSourceAction,
  type ProjectKeyRef,
  type Revealed,
  type RevokeKind,
} from "@/lib/outside-access/actions";
import { RevealPanels, useReveals } from "./reveal-panel";

/** Each dialog and its writes load the first time someone opens it (ADR 0027). */
const packEditor = onDemand(() => import("./pack-editor-dialog"));
const intakeDialog = onDemand(() => import("./intake-link-dialog"));

type Translate = ((key: string, values?: Record<string, string | number>) => string) & {
  has?: (key: string) => boolean;
};

/** Which toolbar controls show. A row's own controls follow its viewer_can_manage, the check that source's RPC makes. */
export interface OutsideCan {
  readonly packs: boolean;
  readonly engagement: boolean;
}

const REVOKE: Partial<Record<OutsideAccessSource, RevokeKind>> = {
  "Live view link": "live",
  "Display link": "live",
  "File link": "file",
  "Advance link": "advance",
  "Signing link": "signing",
  "Pack recipient": "recipient",
  "Intake link": "intake",
  "Form link": "form",
};

const REGENERATE: Partial<Record<OutsideAccessSource, "view" | "display" | "intake" | "form">> = {
  "Live view link": "view",
  "Display link": "display",
  "Intake link": "intake",
  "Form link": "form",
};

const STATE_TONES: Readonly<Record<string, "success" | "warning" | "neutral" | "danger">> = {
  Active: "success",
  Pending: "warning",
  Locked: "danger",
  Onboarding: "warning",
  Blocked: "danger",
};

function Row({
  refs,
  timeZone,
  row,
  onReveal,
}: {
  refs: ProjectKeyRef;
  timeZone: string;
  row: OutsideAccessRow;
  onReveal: (revealed: Revealed) => void;
}) {
  const t = useTranslations("projects.outsideAccess") as unknown as Translate;
  const format = useFormatter();
  const router = useRouter();
  const [confirm, setConfirm] = useState<"revoke" | "regenerate" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const date = (iso: string) => format.dateTime(new Date(iso), { dateStyle: "medium", timeZone });
  const open = row.state === "Active" || row.state === "Locked" || row.state === "Pending";
  const revoke = REVOKE[row.source];
  const regenerate = REGENERATE[row.source];
  const canRevoke = open && revoke !== undefined && row.viewerCanManage;
  const canRegenerate = open && regenerate !== undefined && row.viewerCanManage;
  const canReset = open && row.source === "Pack recipient" && row.viewerCanManage;
  const name = row.label ?? "";
  const done = (result: { ok: true } | { ok: false; error: string }) => {
    if (!result.ok) setError(result.error);
    setConfirm(null);
    router.refresh();
  };
  const act = () =>
    start(async () => {
      setError(null);
      if (confirm === "revoke" && revoke) {
        done(await revokeSourceAction(refs, revoke, row.sourceId));
      } else if (confirm === "regenerate" && regenerate) {
        const result = await regenerateSourceAction(refs, regenerate, row.sourceId, name);
        if (result.ok) onReveal(result.data);
        done(result);
      }
    });
  const reset = () =>
    start(async () => {
      setError(null);
      const result = await resetRecipientCodeAction(refs, row.sourceId, name);
      if (result.ok) onReveal(result.data);
      done(result);
    });
  return (
    <li className="flex flex-col gap-4 py-8" data-outside-row={row.source}>
      <span className="flex flex-wrap items-baseline justify-between gap-8">
        <span className="text-text-13 text-text-primary">
          {row.label ?? t(`defaultLabels.${row.source}`)}
        </span>
        <Tag tone={STATE_TONES[row.state] ?? "neutral"}>
          {t.has?.(`states.${row.state}`) === false ? row.state : t(`states.${row.state}`)}
        </Tag>
      </span>
      <span className="text-text-12 text-text-secondary">
        {[
          row.recipientEmail,
          row.tokenHint ? t("hint", { hint: row.tokenHint }) : null,
          row.expiresAt ? t("expires", { date: date(row.expiresAt) }) : null,
          row.openCount === null ? null : t("opens", { count: row.openCount }),
          row.lastOpenedAt ? t("lastOpened", { date: date(row.lastOpenedAt) }) : null,
        ]
          .filter((part) => part !== null)
          .join(" · ")}
      </span>
      {error ? (
        <span role="alert" className="text-text-12 text-danger-text">
          {t.has?.(`errors.${error}`) === false ? t("errors.unexpected") : t(`errors.${error}`)}
        </span>
      ) : null}
      {confirm ? (
        <span className="flex flex-col gap-8">
          <span className="text-text-12">
            {t(confirm === "revoke" ? "revokeConfirm" : "regenerateConfirm")}
          </span>
          <span className="flex gap-8">
            <Button type="button" size="sm" variant="secondary" onClick={() => setConfirm(null)}>
              {t("cancel")}
            </Button>
            <Button
              type="button"
              size="sm"
              variant={confirm === "revoke" ? "danger" : "secondary"}
              loading={pending}
              onClick={act}
            >
              {t("confirm")}
            </Button>
          </span>
        </span>
      ) : canRevoke ||
        canRegenerate ||
        canReset ||
        row.source === "Engagement" ||
        row.source === "Roster invitation" ? (
        <span className="flex flex-wrap gap-8">
          {canRegenerate ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => setConfirm("regenerate")}
            >
              {t("regenerate")}
            </Button>
          ) : null}
          {canReset ? (
            <Button type="button" size="sm" variant="ghost" loading={pending} onClick={reset}>
              {t("resetCode")}
            </Button>
          ) : null}
          {canRevoke ? (
            <Button type="button" size="sm" variant="ghost" onClick={() => setConfirm("revoke")}>
              {t("revoke")}
            </Button>
          ) : null}
          {row.source === "Engagement" ? (
            <NextLink
              className="text-label-13 text-accent-text underline"
              href={`/${refs.org}/p/${refs.projectKey}/engagements?id=${row.sourceId}` as Route}
            >
              {t("openEngagement")}
            </NextLink>
          ) : null}
          {row.source === "Roster invitation" ? (
            <NextLink
              className="text-label-13 text-accent-text underline"
              href={`/${refs.org}/p/${refs.projectKey}/engagements` as Route}
            >
              {t("openEngagement")}
            </NextLink>
          ) : null}
        </span>
      ) : null}
    </li>
  );
}

/**
 * The section's client side (B2, ADR 0141): the static toolbar, the reveal panel above the list, and the rows. Project
 * Settings already has its form's primary, so everything here is secondary. Buttons are static and each dialog body
 * loads on first click, so the first click on a just-loaded page opens it.
 */
export function OutsideAccessClient({
  refs,
  timeZone,
  groups,
  can,
}: {
  refs: ProjectKeyRef;
  timeZone: string;
  groups: readonly {
    readonly source: OutsideAccessSource;
    readonly rows: readonly OutsideAccessRow[];
  }[];
  can: OutsideCan;
}) {
  const t = useTranslations("projects.outsideAccess") as unknown as Translate;
  const router = useRouter();
  const { reveals, add: reveal, dismiss } = useReveals();
  const [dialog, setDialog] = useState<"pack" | "packs" | "intake" | null>(null);
  const packs = useOnDemand(packEditor, dialog === "pack" || dialog === "packs");
  const intake = useOnDemand(intakeDialog, dialog === "intake");
  const close = () => {
    setDialog(null);
    router.refresh();
  };
  return (
    <div className="flex flex-col gap-16">
      {can.packs || can.engagement ? (
        <div className="flex flex-wrap gap-8">
          {can.packs ? (
            <>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                onMouseEnter={() => void packEditor.load()}
                onFocus={() => void packEditor.load()}
                onClick={() => setDialog("pack")}
              >
                {t("newPack")}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                onMouseEnter={() => void packEditor.load()}
                onFocus={() => void packEditor.load()}
                onClick={() => setDialog("packs")}
              >
                {t("managePacks")}
              </Button>
            </>
          ) : null}
          {can.engagement ? (
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onMouseEnter={() => void intakeDialog.load()}
              onFocus={() => void intakeDialog.load()}
              onClick={() => setDialog("intake")}
            >
              {t("newIntake")}
            </Button>
          ) : null}
        </div>
      ) : null}
      <RevealPanels reveals={reveals} onDismiss={dismiss} />
      {groups.length === 0 ? (
        <p className="m-0 text-text-13 text-text-secondary">{t("empty")}</p>
      ) : (
        groups.map((group) => (
          <div key={group.source} className="flex flex-col gap-4">
            <h3 className="m-0 text-label-13 font-medium">{t(`sources.${group.source}`)}</h3>
            <ul className="m-0 flex list-none flex-col divide-y divide-border-subtle p-0">
              {group.rows.map((row) => (
                <Row
                  key={`${row.source}-${row.sourceId}`}
                  refs={refs}
                  timeZone={timeZone}
                  row={row}
                  onReveal={reveal}
                />
              ))}
            </ul>
          </div>
        ))
      )}
      {(dialog === "pack" || dialog === "packs") && packs ? (
        <packs.PackEditorDialog
          refs={refs}
          timeZone={timeZone}
          startNew={dialog === "pack"}
          reveals={reveals}
          onReveal={reveal}
          onDismiss={dismiss}
          onClose={close}
        />
      ) : null}
      {dialog === "intake" && intake ? (
        <intake.IntakeLinkDialog refs={refs} onReveal={reveal} onClose={close} />
      ) : null}
    </div>
  );
}

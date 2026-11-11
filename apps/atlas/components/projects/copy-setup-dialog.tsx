"use client";

import {
  offsetBetween,
  PROJECT_COPY_PARTS,
  summarizeProjectCopy,
  type CopySourceProject,
} from "@xos/data/project-copy";
import type { ProjectSummary } from "@xos/data/projects";
import { Button, Checkbox, Dialog, Input, Select, Toast, ToastRegion } from "@xos/ui";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import {
  copyIntoProjectAction,
  listCopySourcesAction,
  type CopyPreviewState,
} from "@/lib/projects/intake";
import { CopyPreviewList } from "./copy-preview-list";

type Translate = (key: string, values?: Record<string, string | number>) => string;

/**
 * Project Settings, Copy from another project (B14, G-252; ADR 0153 D4): a past project, the parts and the days to move
 * by (prefilled from the two first show days), then a preview grouped by part with each skip's reason in words, then
 * Copy, which writes exactly the previewed rows. Loaded on demand from Settings, which is not a key page.
 */
export function CopySetupDialog({
  org,
  project,
  open,
  onOpenChange,
}: {
  org: string;
  project: ProjectSummary;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("projects") as unknown as Translate;
  const [sources, setSources] = useState<readonly CopySourceProject[]>([]);
  const [source, setSource] = useState("");
  const [parts, setParts] = useState<readonly string[]>(PROJECT_COPY_PARTS);
  const [offset, setOffset] = useState("");
  const [preview, setPreview] = useState<CopyPreviewState | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    listCopySourcesAction(org, project.key).then((list) => live && setSources(list));
    return () => {
      live = false;
    };
  }, [org, project.key]);

  const input = () => ({
    sourceProjectId: source,
    parts,
    offsetDays: offset === "" ? null : Number(offset),
  });
  const run = async (commit: boolean) => {
    setBusy(true);
    const result = await copyIntoProjectAction(org, project.key, input(), commit);
    setBusy(false);
    if (commit && result.ok) {
      const copied = result.items.filter((i) => i.outcome === "copy").length;
      const skipped = result.items.length - copied;
      setDone(t("copy.done", { copied, skipped }));
      setPreview(null);
      onOpenChange(false);
      return;
    }
    setPreview(result);
  };

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={onOpenChange}
        title={t("copy.title")}
        actions={
          <>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              {t("create.cancel")}
            </Button>
            <Button
              type="button"
              variant="secondary"
              loading={busy && !preview}
              disabled={!source || parts.length === 0}
              onClick={() => run(false)}
            >
              {t("copy.preview")}
            </Button>
            <Button
              type="button"
              variant="primary"
              loading={busy && Boolean(preview)}
              disabled={!preview?.ok || preview.items.every((i) => i.outcome === "skip")}
              onClick={() => run(true)}
            >
              {t("copy.commit")}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-12">
          <p className="m-0 text-text-13 text-text-secondary">{t("copy.lead")}</p>
          <Select
            id="copy-source"
            label={t("copy.source")}
            value={source}
            placeholder={t("create.choose")}
            options={sources.map((p) => ({
              value: p.id,
              label: `${p.key} ${p.name}${p.archived ? ` (${t("copy.archived")})` : ""}`,
            }))}
            onChange={(e) => {
              setSource(e.target.value);
              setPreview(null);
              const days = offsetBetween(
                sources.find((p) => p.id === e.target.value)?.startsOn ?? null,
                project.startsOn,
              );
              setOffset(days === null ? "" : String(days));
            }}
          />
          <fieldset className="m-0 flex flex-col gap-8 border-0 p-0">
            <legend className="mb-8 text-text-13 font-medium">{t("copy.parts")}</legend>
            {PROJECT_COPY_PARTS.map((part) => (
              <Checkbox
                key={part}
                value={part}
                checked={parts.includes(part)}
                onChange={(e) => {
                  setParts((now) =>
                    e.target.checked ? [...now, part] : now.filter((p) => p !== part),
                  );
                  setPreview(null);
                }}
                label={t(`copy.partNames.${part.replaceAll(" ", "")}`)}
              />
            ))}
          </fieldset>
          <Input
            id="copy-offset"
            type="number"
            min={-3660}
            max={3660}
            width={200}
            label={t("copy.offset")}
            help={t("copy.offsetHelp")}
            value={offset}
            onChange={(e) => {
              setOffset(e.target.value);
              setPreview(null);
            }}
          />
          {preview ? (
            <>
              {preview.ok ? (
                <p className="m-0 text-text-13" role="status">
                  {summarizeProjectCopy(preview.items).length === 0
                    ? t("copy.nothingToCopy")
                    : t("copy.previewLead")}
                </p>
              ) : null}
              <CopyPreviewList preview={preview} />
            </>
          ) : null}
        </div>
      </Dialog>
      <ToastRegion label={t("copy.title")}>{done ? <Toast message={done} /> : null}</ToastRegion>
    </>
  );
}

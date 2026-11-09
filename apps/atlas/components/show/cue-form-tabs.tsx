"use client";

import { Button, Tabs } from "@xos/ui";
import { useTranslations } from "next-intl";
import { useState, type ReactNode } from "react";

/**
 * A cue's fields in tabs, for the run peek, the portal and the segment library (B3, ADR 0142). The tabs keep every
 * panel mounted and hidden, so what was typed survives a switch, and a screen shows at most seven fields (gate 27).
 *
 * Each of the Cue, Words and Calls panels holds its own form over the same controlled state, so Enter in a field saves
 * and validates only what is visible. `action` stays beside onSubmit: React replays a click that came before hydration
 * through it, where a form without one would do a native GET with the fields in the URL. The one Save sits under the
 * tabs and clicks straight through to `submit`, so a bad value on a hidden tab reaches the database's refusal rather
 * than blocking the save on native validation nobody can see. The Fields panel is outside any form: its fields save on
 * their own, and Enter in one must not save the cue. Refusals go in `alert`, above the tabs, so every tab shows them.
 */
export function CueFormTabs({
  label,
  alert,
  cue,
  words,
  calls,
  fields,
  saving,
  canSave,
  saveVariant = "secondary",
  saveLabel,
  cancelLabel,
  onCancel,
  submit,
}: {
  label: string;
  alert?: ReactNode;
  cue: ReactNode;
  words: ReactNode;
  calls: ReactNode;
  /** The cue's custom fields; the tab shows only when the org has any. */
  fields?: ReactNode;
  saving: boolean;
  canSave: boolean;
  saveVariant?: "primary" | "secondary";
  saveLabel: string;
  cancelLabel: string;
  onCancel: () => void;
  submit: () => void;
}) {
  const t = useTranslations("show.cueTabs");
  const [tab, setTab] = useState("cue");
  const save = () => {
    if (canSave) submit();
  };
  const panel = (name: string, children: ReactNode) => (
    <form
      aria-label={name}
      className="flex flex-col gap-8"
      action={save}
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      {children}
      {/* A form with several fields takes Enter only through a submit button; the visible Save is the footer's. */}
      <button type="submit" hidden tabIndex={-1} />
    </form>
  );
  const tabs = [
    { value: "cue", label: t("cue") },
    { value: "words", label: t("words") },
    { value: "calls", label: t("calls") },
    ...(fields ? [{ value: "fields", label: t("fields") }] : []),
  ];
  return (
    <div className="flex w-full flex-col gap-12">
      {alert}
      <Tabs
        label={label}
        tabs={tabs}
        onChange={setTab}
        panels={{
          cue: panel(t("cue"), cue),
          words: panel(t("words"), words),
          calls: panel(t("calls"), calls),
          ...(fields ? { fields } : {}),
        }}
      />
      {tab === "fields" ? (
        <div>
          <Button variant="ghost" onClick={onCancel}>
            {cancelLabel}
          </Button>
        </div>
      ) : (
        <div className="flex gap-8">
          <Button variant={saveVariant} loading={saving} disabled={!canSave} onClick={save}>
            {saveLabel}
          </Button>
          <Button variant="ghost" onClick={onCancel}>
            {cancelLabel}
          </Button>
        </div>
      )}
    </div>
  );
}

"use client";

import {
  bindingProblem,
  chordOf,
  displayKeys,
  effectiveBindings,
  SHORTCUT_REGISTRY,
  type BindingProblem,
  type CustomBindings,
  type Platform,
} from "@xos/schemas/shortcuts";
import { Button, InlineAlert, ShortcutEditor } from "@xos/ui";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { resetShortcutAction, saveShortcutAction } from "@/lib/settings/shell-preferences-actions";

type Translate = (key: string, values?: Record<string, string>) => string;

/** How long the editor waits after a letter for the second key of a sequence such as G then H. */
const SEQUENCE_MS = 1200;
const LETTER = /^[A-Z]$/;

export interface ShortcutRebinderProps {
  readonly org: string;
  readonly platform: Platform;
  /** The person's stored bindings the registry accepts. */
  readonly custom: CustomBindings;
  /** Registry ids of the shortcuts the person may change, in sheet order. */
  readonly rows: readonly string[];
  /** me.shortcuts_enabled. */
  readonly singleKeys: boolean;
}

/**
 * Rebinding in Personal settings, Keyboard Shortcuts (Section 11.7): Change records the next keys
 * pressed (a letter then a second key within a moment makes a sequence; Esc cancels), refuses keys
 * another shortcut holds where their scopes meet and keys that belong to the browser, the operating
 * system or screen readers, then saves; Reset returns one shortcut or all of them to the default.
 * Every check comes from the shortcut registry, and the server checks again before it saves.
 */
export function ShortcutRebinder({
  org,
  platform,
  custom,
  rows,
  singleKeys,
}: ShortcutRebinderProps) {
  const t = useTranslations() as unknown as Translate;
  const router = useRouter();
  const shell = SHORTCUT_REGISTRY.shells.atlas;
  const [bindings, setBindings] = useState<CustomBindings>(custom);
  const [recording, setRecording] = useState<string | null>(null);
  const [first, setFirst] = useState<string | null>(null);
  const [problem, setProblem] = useState<{ readonly id: string; readonly text: string } | null>(
    null,
  );
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const byId = new Map(shell.shortcuts.map((s) => [s.id, s]));
  const label = (id: string) => t(byId.get(id)?.label ?? id);
  const current = (p: Platform) => effectiveBindings(shell, bindings, p);
  const keysOf = (id: string) => current(platform).get(id) ?? null;

  const explain = (found: BindingProblem | { readonly kind: "failed" }, keys: string) => {
    const shown = displayKeys(keys, platform);
    if (found.kind === "conflict") {
      return t("settings.shortcuts.problems.conflict", { keys: shown, action: label(found.with) });
    }
    if (found.kind === "reserved") {
      return t(`settings.shortcuts.problems.${found.reason}`, { keys: shown });
    }
    return t(`settings.shortcuts.problems.${found.kind}`);
  };

  const commit = async (id: string, keys: string) => {
    setRecording(null);
    setFirst(null);
    const found = bindingProblem(SHORTCUT_REGISTRY, "atlas", current, id, keys);
    if (found) {
      const text = explain(found, keys);
      setProblem({ id, text });
      setStatus(text);
      return;
    }
    setBusy(true);
    const result = await saveShortcutAction(org, id, keys);
    setBusy(false);
    if (!result.ok) {
      const text = explain(result.problem, keys);
      setProblem({ id, text });
      setStatus(text);
      return;
    }
    setProblem(null);
    setBindings((b) => ({ ...b, [id]: keys }));
    setStatus(
      t("settings.shortcuts.saved", { action: label(id), keys: displayKeys(keys, platform) }),
    );
    router.refresh();
  };

  // The key listener below calls the latest commit, which reads the latest bindings.
  const commitRef = useRef(commit);
  useEffect(() => {
    commitRef.current = commit;
  });

  // While recording, the next keys pressed belong to the editor, not to the page or the shell.
  useEffect(() => {
    if (recording === null) return undefined;
    const onKey = (event: KeyboardEvent) => {
      const chord = chordOf(event, platform);
      if (chord === null) return;
      if (chord === "Tab" || chord === "Shift+Tab") {
        clearTimeout(timer.current);
        setRecording(null);
        setFirst(null);
        setStatus("");
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      clearTimeout(timer.current);
      if (chord === "Escape" && first === null) {
        setRecording(null);
        setStatus("");
        return;
      }
      if (first !== null) {
        void commitRef.current(recording, `${first} ${chord}`);
      } else if (LETTER.test(chord)) {
        setFirst(chord);
        timer.current = setTimeout(() => void commitRef.current(recording, chord), SEQUENCE_MS);
      } else {
        void commitRef.current(recording, chord);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [recording, first, platform]);
  useEffect(() => () => clearTimeout(timer.current), []);

  const reset = async (id: string | null) => {
    setBusy(true);
    const result = await resetShortcutAction(org, id);
    setBusy(false);
    if (!result.ok) {
      setStatus(t("settings.shortcuts.problems.failed"));
      return;
    }
    setProblem(null);
    if (id === null) {
      setBindings({});
      setStatus(t("settings.shortcuts.resetAllDone"));
    } else {
      setBindings((b) => Object.fromEntries(Object.entries(b).filter(([k]) => k !== id)));
      setStatus(t("settings.shortcuts.resetOne", { action: label(id) }));
    }
    router.refresh();
  };

  const idByLabel = new Map(rows.map((id) => [label(id), id]));
  return (
    <section aria-labelledby="shortcut-rebinder-heading" className="flex flex-col gap-12">
      <h2 id="shortcut-rebinder-heading" className="m-0 text-heading-16 font-semibold">
        {t("settings.shortcuts.title")}
      </h2>
      <p className="m-0 max-w-layout-form text-text-13 text-text-secondary">
        {t("settings.shortcuts.description")}
      </p>
      {singleKeys ? null : (
        <InlineAlert tone="warning">{t("settings.shortcuts.singleKeysOff")}</InlineAlert>
      )}
      <ShortcutEditor
        label={t("settings.shortcuts.table")}
        rows={rows.map((id) => {
          const keys = recording === id && first !== null ? first : keysOf(id);
          return {
            action: label(id),
            keys: keys === null ? "" : displayKeys(keys, platform),
            ...(problem?.id === id ? { conflict: problem.text } : {}),
            ...(Object.hasOwn(bindings, id) ? { custom: true } : {}),
            ...(recording === id ? { recording: true } : {}),
          };
        })}
        onChange={(action) => {
          const id = idByLabel.get(action);
          if (!id || busy) return;
          clearTimeout(timer.current);
          setFirst(null);
          setProblem(null);
          setRecording(id);
          setStatus(t("settings.shortcuts.recording", { action }));
        }}
        onReset={(action) => {
          const id = idByLabel.get(action);
          if (id && !busy) void reset(id);
        }}
      />
      <p className="m-0 max-w-layout-form text-text-12 text-text-secondary">
        {t("settings.shortcuts.fixed")}
      </p>
      <div>
        <Button
          disabled={busy || Object.keys(bindings).length === 0}
          onClick={() => void reset(null)}
        >
          {t("settings.shortcuts.resetAll")}
        </Button>
      </div>
      <p role="status" className="m-0 text-text-13">
        {status}
      </p>
    </section>
  );
}

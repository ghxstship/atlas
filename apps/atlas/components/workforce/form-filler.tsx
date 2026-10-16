"use client";

import { Button, InlineAlert } from "@xos/ui";
import {
  fieldShown,
  formScore,
  missingAnswers,
  type FormAnswer,
  type FormField,
} from "@xos/data/workforce-forms";
import { useRouter } from "next/navigation";
import { useActionState, useEffect, useMemo, useRef, useState } from "react";
import { ActionFeedback } from "@/components/collection-kit/kit";
import { useCopy } from "@/components/collection-kit/use-copy";
import type { ActionState } from "@/lib/collection-kit/forms";
import { submitFormAction } from "@/lib/workforce/actions";

import { keepInputOnSubmit } from "@/components/collection-kit/keep-input";
const control =
  "w-full max-w-full rounded-control border border-border-control bg-bg-surface px-8 text-text-13 focus-visible:outline-(length:--stroke-width-focus) focus-visible:outline-focus-ring";

/**
 * Fills in a published form in Atlas (Section 4.9 Forms): fields appear and hide as their conditions
 * say, the running score shows, photos and the signature upload with the submission, and the GPS stamp
 * comes from the browser when the person allows it. The database checks every answer again.
 */
export function FormFiller({
  org,
  templateId,
  fields,
  requiresSignature,
  requiresLocation,
  projects,
}: {
  org: string;
  templateId: string;
  fields: readonly FormField[];
  requiresSignature: boolean;
  requiresLocation: boolean;
  projects: readonly { value: string; label: string }[];
}) {
  const t = useCopy("workforce.forms");
  const router = useRouter();
  const [answers, setAnswers] = useState<Record<string, FormAnswer>>({});
  const [photos, setPhotos] = useState<Record<string, number>>({});
  const [location, setLocation] = useState<{
    latitude: number;
    longitude: number;
    accuracy: number;
  } | null>(null);
  const [locating, setLocating] = useState<"idle" | "busy" | "denied">("idle");
  const [state, formAction, pending] = useActionState<ActionState, FormData>(submitFormAction, {});
  const done = useRef<ActionState | null>(null);
  useEffect(() => {
    if (state.ok && done.current !== state) {
      done.current = state;
      setAnswers({});
      router.refresh();
    }
  }, [state, router]);

  const shown = fields.filter((f) => fieldShown(f, answers));
  const withPhotos = useMemo(() => {
    const merged: Record<string, FormAnswer> = { ...answers };
    for (const [key, count] of Object.entries(photos))
      if (count > 0) merged[key] = Array.from({ length: count }, () => "pending");
    return merged;
  }, [answers, photos]);
  const missing = missingAnswers(fields, withPhotos);
  const score = formScore(fields, answers);
  const visibleAnswers = Object.fromEntries(
    Object.entries(answers).filter(([k]) => shown.some((f) => f.key === k)),
  );

  const set = (key: string, value: FormAnswer | undefined) =>
    setAnswers((current) => {
      const next = Object.fromEntries(Object.entries(current).filter(([k]) => k !== key));
      if (value !== undefined && value !== "") next[key] = value;
      return next;
    });

  const locate = () => {
    if (!("geolocation" in navigator)) {
      setLocating("denied");
      return;
    }
    setLocating("busy");
    navigator.geolocation.getCurrentPosition(
      (p) => {
        setLocation({
          latitude: p.coords.latitude,
          longitude: p.coords.longitude,
          accuracy: p.coords.accuracy,
        });
        setLocating("idle");
      },
      () => setLocating("denied"),
      { enableHighAccuracy: true, timeout: 15000 },
    );
  };

  return (
    <form
      action={formAction}
      onSubmit={keepInputOnSubmit(formAction)}
      className="flex max-w-[min(100%,var(--layout-reading))] flex-col gap-16"
      noValidate
    >
      <input type="hidden" name="org" value={org} />
      <input type="hidden" name="id" value={templateId} />
      <input type="hidden" name="answers" value={JSON.stringify(visibleAnswers)} />
      {location ? (
        <>
          <input type="hidden" name="latitude" value={String(location.latitude)} />
          <input type="hidden" name="longitude" value={String(location.longitude)} />
          <input type="hidden" name="accuracy" value={String(Math.round(location.accuracy))} />
        </>
      ) : null}
      {projects.length > 0 ? (
        <div className="flex flex-col gap-4">
          <label htmlFor={`${templateId}-project`} className="text-label-13 font-medium">
            {t("project")}
          </label>
          <select
            id={`${templateId}-project`}
            name="projectId"
            className={`${control} h-control-md`}
            defaultValue=""
          >
            <option value="">{t("noProject")}</option>
            {projects.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
          <p className="m-0 text-text-12 text-text-secondary">{t("projectHelp")}</p>
        </div>
      ) : null}
      {shown.map((f) => {
        const id = `${templateId}-${f.key}`;
        const label = (
          <label htmlFor={id} className="text-label-13 font-medium">
            {f.label}
            {f.required ? ` ${t("requiredMark")}` : ""}
          </label>
        );
        const value = answers[f.key];
        switch (f.kind) {
          case "yes_no":
            return (
              <fieldset key={f.key} className="m-0 flex flex-col gap-4 border-0 p-0">
                <legend className="text-label-13 font-medium">
                  {f.label}
                  {f.required ? ` ${t("requiredMark")}` : ""}
                </legend>
                <div className="flex gap-16 text-text-13">
                  {[true, false].map((v) => (
                    <label key={String(v)} className="flex items-center gap-4">
                      <input
                        type="radio"
                        name={`ui-${f.key}`}
                        checked={value === v}
                        onChange={() => set(f.key, v)}
                      />
                      {v ? t("yes") : t("no")}
                    </label>
                  ))}
                </div>
              </fieldset>
            );
          case "choice":
            return (
              <div key={f.key} className="flex flex-col gap-4">
                {label}
                <select
                  id={id}
                  className={`${control} h-control-md`}
                  value={typeof value === "string" ? value : ""}
                  onChange={(e) => set(f.key, e.target.value)}
                >
                  <option value="">{t("pickOne")}</option>
                  {(f.choices ?? []).map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </div>
            );
          case "multi_choice":
            return (
              <fieldset key={f.key} className="m-0 flex flex-col gap-4 border-0 p-0">
                <legend className="text-label-13 font-medium">{f.label}</legend>
                {(f.choices ?? []).map((c) => {
                  const list = Array.isArray(value) ? (value as string[]) : [];
                  return (
                    <label key={c} className="flex items-center gap-4 text-text-13">
                      <input
                        type="checkbox"
                        checked={list.includes(c)}
                        onChange={(e) =>
                          set(f.key, e.target.checked ? [...list, c] : list.filter((x) => x !== c))
                        }
                      />
                      {c}
                    </label>
                  );
                })}
              </fieldset>
            );
          case "long_text":
            return (
              <div key={f.key} className="flex flex-col gap-4">
                {label}
                <textarea
                  id={id}
                  rows={4}
                  className={`${control} py-4`}
                  value={typeof value === "string" ? value : ""}
                  onChange={(e) => set(f.key, e.target.value)}
                />
              </div>
            );
          case "photo":
            return (
              <div key={f.key} className="flex flex-col gap-4">
                {label}
                <input
                  id={id}
                  name={`photo:${f.key}`}
                  type="file"
                  accept="image/jpeg,image/png,image/webp,image/heic"
                  multiple
                  capture="environment"
                  className="text-text-13"
                  onChange={(e) =>
                    setPhotos((p) => ({ ...p, [f.key]: e.target.files?.length ?? 0 }))
                  }
                />
                <p className="m-0 text-text-12 text-text-secondary">{t("photoHelp")}</p>
              </div>
            );
          default:
            return (
              <div key={f.key} className="flex flex-col gap-4">
                {label}
                <input
                  id={id}
                  type={f.kind === "number" ? "number" : f.kind === "date" ? "date" : "text"}
                  className={`${control} h-control-md`}
                  value={value === undefined ? "" : String(value)}
                  onChange={(e) =>
                    set(
                      f.key,
                      f.kind === "number"
                        ? e.target.value === ""
                          ? undefined
                          : Number(e.target.value)
                        : e.target.value,
                    )
                  }
                />
              </div>
            );
        }
      })}
      {requiresLocation ? (
        <div className="flex flex-col gap-4">
          <span className="text-label-13 font-medium">{t("gps")}</span>
          <div className="flex flex-wrap items-center gap-8">
            <Button type="button" size="sm" onClick={locate} loading={locating === "busy"}>
              {location ? t("gpsAgain") : t("gpsTake")}
            </Button>
            <span role="status" className="text-text-12 text-text-secondary">
              {location
                ? t("gpsTaken", {
                    latitude: location.latitude.toFixed(5),
                    longitude: location.longitude.toFixed(5),
                    accuracy: Math.round(location.accuracy),
                  })
                : locating === "denied"
                  ? t("gpsDenied")
                  : t("gpsNeeded")}
            </span>
          </div>
        </div>
      ) : null}
      {requiresSignature ? (
        <fieldset className="m-0 flex flex-col gap-8 border-0 p-0">
          <legend className="text-label-13 font-medium">{t("signature")}</legend>
          <label htmlFor={`${templateId}-signer`} className="text-text-13">
            {t("signerName")}
          </label>
          <input
            id={`${templateId}-signer`}
            name="signerName"
            className={`${control} h-control-md`}
            autoComplete="name"
          />
          <label htmlFor={`${templateId}-signature`} className="text-text-13">
            {t("signatureImage")}
          </label>
          <input
            id={`${templateId}-signature`}
            name="signature"
            type="file"
            accept="image/png,image/jpeg"
            className="text-text-13"
          />
          <p className="m-0 text-text-12 text-text-secondary">{t("signatureHelp")}</p>
        </fieldset>
      ) : null}
      {score ? (
        <p role="status" className="m-0 text-text-13">
          {t("runningScore", { score: score.score, max: score.max })}
        </p>
      ) : null}
      {missing.length > 0 ? (
        <InlineAlert tone="info" title={t("stillNeeded")}>
          {missing.map((k) => fields.find((f) => f.key === k)?.label ?? k).join(", ")}
        </InlineAlert>
      ) : null}
      {state.ok ? (
        <InlineAlert tone="success" title={t("submittedTitle")}>
          {t("submittedBody")}
        </InlineAlert>
      ) : null}
      <ActionFeedback state={state} refusals="workforce.refusals" />
      <div>
        <Button type="submit" variant="primary" loading={pending}>
          {t("submit")}
        </Button>
      </div>
    </form>
  );
}

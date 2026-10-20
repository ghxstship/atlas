"use client";

import { createCredential, webAuthnAvailable } from "@xos/data/webauthn-json";
import { Button, Dialog, InlineAlert, Input } from "@xos/ui";
import { useActionState, useRef, useState, useSyncExternalStore, useTransition } from "react";
import {
  finishPasskeyRegistrationAction,
  removeFactorAction,
  removePasskeyAction,
  renameFactorAction,
  renamePasskeyAction,
  startPasskeyRegistrationAction,
  type SecurityState,
} from "@/app/auth/security-actions";
import { errorText, useSecurityCopy } from "./copy";
import { useStepUp, useStepUpForm } from "./step-up";

/**
 * Row controls for Personal settings, Security (Section 4.5.6 personal setting 4): rename and remove a second
 * factor or a passkey, and add a passkey. Removing a second factor, and adding or removing a passkey once the
 * person holds a second factor, refuse with `step_up_required` until a second factor passed in the last 15
 * minutes; the step-up dialog then resumes the action.
 */

type Action = (state: SecurityState, form: FormData) => Promise<SecurityState>;
const INITIAL: SecurityState = {};
const stepUpRefusal = (state: SecurityState) => state.error === "step_up_required";

function Feedback({ state, success }: { state: SecurityState; success: string }) {
  const t = useSecurityCopy();
  if (state.error && state.error !== "step_up_required") {
    return <InlineAlert tone="danger">{errorText(t, state.error)}</InlineAlert>;
  }
  if (state.ok) {
    return (
      <p role="status" className="m-0 text-text-12 text-success-text">
        {success}
      </p>
    );
  }
  return null;
}

/** Rename in place: a button that opens a one-field form. */
export function RenameControl({
  kind,
  id,
  name,
}: {
  kind: "factor" | "passkey";
  id: string;
  name: string;
}) {
  const t = useSecurityCopy();
  const copy = kind === "factor" ? "factors" : "passkeys";
  const action: Action = kind === "factor" ? renameFactorAction : renamePasskeyAction;
  const [editing, setEditing] = useState(false);
  const [state, dispatch, pending] = useActionState(action, INITIAL);
  // A saved name closes the form (state derived during render, as React recommends over an effect).
  const [judged, setJudged] = useState(state);
  if (state !== judged) {
    setJudged(state);
    if (state.ok) setEditing(false);
  }
  if (!editing) {
    return (
      <div className="flex flex-col items-end gap-4">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          aria-label={t(`${copy}.renameLabel`, { name })}
          onClick={() => setEditing(true)}
        >
          {t(`${copy}.rename`)}
        </Button>
        <Feedback state={state} success={t(`${copy}.renamed`)} />
      </div>
    );
  }
  return (
    <form action={dispatch} className="flex flex-wrap items-end gap-8" noValidate>
      <input type="hidden" name={kind === "factor" ? "factorId" : "passkeyId"} value={id} />
      <Input
        id={`rename-${id}`}
        name="label"
        label={t(`${copy}.renameLabel`, { name })}
        defaultValue={name}
        maxLength={80}
        width={220}
        required
      />
      <Button type="submit" size="sm" variant="secondary" loading={pending}>
        {t(`${copy}.save`)}
      </Button>
      <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(false)}>
        {t(`${copy}.cancel`)}
      </Button>
      <Feedback state={state} success={t(`${copy}.renamed`)} />
    </form>
  );
}

/** Remove, confirmed in a dialog, with step-up when the action asks for it. */
export function RemoveControl({
  kind,
  id,
  name,
}: {
  kind: "factor" | "passkey";
  id: string;
  name: string;
}) {
  const t = useSecurityCopy();
  const copy = kind === "factor" ? "factors" : "passkeys";
  const action: Action = kind === "factor" ? removeFactorAction : removePasskeyAction;
  const [open, setOpen] = useState(false);
  const [state, dispatch, pending] = useActionState(action, INITIAL);
  const form = useRef<HTMLFormElement>(null);
  const stepUpDialog = useStepUpForm(state, stepUpRefusal, form);
  const formId = `remove-${kind}-${id}`;
  // Removing, or handing over to the step-up dialog, closes the confirmation.
  const [judged, setJudged] = useState(state);
  if (state !== judged) {
    setJudged(state);
    if (state.ok || stepUpRefusal(state)) setOpen(false);
  }
  return (
    <>
      <form id={formId} ref={form} action={dispatch} className="hidden">
        <input type="hidden" name={kind === "factor" ? "factorId" : "passkeyId"} value={id} />
      </form>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        trigger={
          <Button
            type="button"
            size="sm"
            variant="ghost"
            aria-label={`${t(`${copy}.remove`)} ${name}`}
          >
            {t(`${copy}.remove`)}
          </Button>
        }
        title={t(`${copy}.removeTitle`, { name })}
        description={t(`${copy}.removeSentence`)}
        actions={
          <>
            <Button type="button" onClick={() => setOpen(false)}>
              {t(`${copy}.cancel`)}
            </Button>
            <Button type="submit" form={formId} variant="danger" loading={pending}>
              {t(`${copy}.remove`)}
            </Button>
          </>
        }
      >
        {state.error && !stepUpRefusal(state) ? (
          <InlineAlert tone="danger">{errorText(t, state.error)}</InlineAlert>
        ) : null}
      </Dialog>
      {state.error && !open && !stepUpRefusal(state) ? (
        <InlineAlert tone="danger">{errorText(t, state.error)}</InlineAlert>
      ) : null}
      {stepUpDialog}
    </>
  );
}

const subscribeNever = () => () => undefined;

/** Adds a passkey for this account on this device. */
export function AddPasskeyButton() {
  const t = useSecurityCopy();
  const supported = useSyncExternalStore(subscribeNever, webAuthnAvailable, () => true);
  const [name, setName] = useState(() => t("passkeys.labelDefault"));
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState(false);
  const [pending, start] = useTransition();
  const stepUp = useStepUp();

  const add = () =>
    start(async () => {
      setError(null);
      setAdded(false);
      const options = await startPasskeyRegistrationAction();
      if (!options.ok) {
        if (options.error === "step_up_required") return stepUp.request(add);
        return setError(options.error);
      }
      const result = await createCredential(options.data.options);
      if (!result.ok) return setError(result.reason);
      const saved = await finishPasskeyRegistrationAction({
        challengeId: options.data.challengeId,
        credential: result.credential,
        label: name,
      });
      if (!saved.ok) return setError(saved.error);
      setAdded(true);
    });

  if (!supported) {
    return <p className="m-0 text-text-13 text-text-secondary">{t("passkeys.unsupported")}</p>;
  }
  return (
    <div className="flex flex-col gap-12">
      {error ? <InlineAlert tone="danger">{errorText(t, error)}</InlineAlert> : null}
      {added ? (
        <p role="status" className="m-0 text-text-13 text-success-text">
          {t("passkeys.done")}
        </p>
      ) : null}
      <Input
        width="100%"
        id="passkey-label"
        label={t("passkeys.label")}
        value={name}
        maxLength={80}
        onChange={(e) => setName(e.currentTarget.value)}
      />
      <div>
        <Button type="button" variant="secondary" icon="Plus" loading={pending} onClick={add}>
          {t("passkeys.add")}
        </Button>
      </div>
      {stepUp.dialog}
    </div>
  );
}

"use client";

import { Button, InlineAlert, Input, Textarea } from "@xos/ui";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useActionState, useEffect, useState } from "react";
import { keepInputOnSubmit } from "@/components/forms/keep-input";
import {
  declineDocumentTextAction,
  signDocumentTextAction,
  type DocumentTextState,
} from "@/lib/actions/engagement";

type Translate = (key: string) => string;

const INITIAL: DocumentTextState = {};

function Problem({ state }: { state: DocumentTextState }) {
  const refusals = useTranslations("gateway.tokens.refusals") as unknown as Translate;
  const outcomes = useTranslations("gateway.outcomes") as unknown as Translate;
  if (state.refusal) return <InlineAlert tone="danger">{refusals(state.refusal)}</InlineAlert>;
  if (state.outcome) return <InlineAlert tone="danger">{outcomes(state.outcome)}</InlineAlert>;
  return null;
}

/** Read and sign a generated document: the full text, a typed name and the hash of what was read; or decline with a reason. */
export function DocumentTextPanel({
  documentId,
  title,
  body,
  sha256,
  canAnswer,
  path,
}: {
  documentId: string;
  title: string;
  body: string;
  sha256: string;
  canAnswer: boolean;
  path: string;
}) {
  const t = useTranslations("gateway.documents.readAndSign");
  const decline = useTranslations("gateway.documents.decline");
  const router = useRouter();
  const [signed, signAction, signing] = useActionState(signDocumentTextAction, INITIAL);
  const [declined, declineAction, declining] = useActionState(declineDocumentTextAction, INITIAL);
  const [declineOpen, setDeclineOpen] = useState(false);
  useEffect(() => {
    if (signed.done || declined.done) router.refresh();
  }, [signed.done, declined.done, router]);
  return (
    <div className="flex flex-col gap-12">
      <div
        aria-label={t("textLabel", { title })}
        className="whitespace-pre-wrap rounded-card border border-border-subtle p-12 text-text-14"
      >
        {body}
      </div>
      {canAnswer ? (
        <>
          <form
            action={signAction}
            onSubmit={keepInputOnSubmit(signAction)}
            aria-label={t("formLabel", { title })}
            className="flex flex-col gap-8"
          >
            <input type="hidden" name="documentId" value={documentId} />
            <input type="hidden" name="sha256" value={sha256} />
            <input type="hidden" name="path" value={path} />
            <Problem state={signed} />
            <Input
              name="signedName"
              required
              autoComplete="name"
              label={t("name")}
              help={t("nameHelp")}
            />
            <div>
              <Button type="submit" variant="secondary" disabled={signing} aria-busy={signing}>
                {t("sign")}
              </Button>
            </div>
          </form>
          {declineOpen ? (
            <form
              action={declineAction}
              onSubmit={keepInputOnSubmit(declineAction)}
              aria-label={decline("formLabel", { title })}
              className="flex flex-col gap-8"
            >
              <input type="hidden" name="documentId" value={documentId} />
              <input type="hidden" name="path" value={path} />
              <Problem state={declined} />
              <Textarea
                name="reason"
                required
                rows={2}
                width="100%"
                label={decline("reason")}
                help={decline("reasonHelp")}
              />
              <div>
                <Button type="submit" variant="ghost" disabled={declining} aria-busy={declining}>
                  {decline("submit")}
                </Button>
              </div>
            </form>
          ) : (
            <div>
              <Button type="button" variant="ghost" onClick={() => setDeclineOpen(true)}>
                {decline("open")}
              </Button>
            </div>
          )}
        </>
      ) : null}
    </div>
  );
}

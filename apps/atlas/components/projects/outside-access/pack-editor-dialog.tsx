"use client";

import { Button, Checkbox, Dialog, InlineAlert, Input, Select, Textarea } from "@xos/ui";
import { useFormatter, useTranslations } from "next-intl";
import { useActionState, useCallback, useEffect, useState, useTransition } from "react";
import { keepInputOnSubmit, useKeepInput } from "@/components/collection-kit/keep-input";
import {
  addPackItemAction,
  addRecipientAction,
  listPacksAction,
  loadPackAction,
  orderPackItemsAction,
  packItemChoicesAction,
  packSupplierChoicesAction,
  removePackItemAction,
  revokePackAction,
  savePackAction,
  savePackScheduleAction,
  sendPackAction,
  type PackEditorData,
  type ProjectKeyRef,
  type Revealed,
} from "@/lib/outside-access/actions";
import { dayInZone } from "@/lib/stakeholder-packs/expiry";
import type { PackSummary } from "@xos/data/stakeholder-packs";
import { refusalText } from "./refusal-text";
import { RevealLines, type HeldReveal } from "./reveal-panel";

type Translate = ((key: string, values?: Record<string, string | number>) => string) & {
  has?: (key: string) => boolean;
};

const STEPS = ["details", "items", "recipients", "delivery", "activity"] as const;
type Step = (typeof STEPS)[number];

function useLabels() {
  return useTranslations("projects.outsideAccess.pack") as unknown as Translate;
}

/** A refusal's copy; a rule with no sentence of its own names its code. */
function Refusal({ error }: { error: string | null }) {
  const t = useTranslations("projects.outsideAccess.errors") as unknown as Translate;
  if (!error) return null;
  return <InlineAlert tone="danger">{refusalText(t, error)}</InlineAlert>;
}

type FormState = { readonly error: string | null; readonly saved?: boolean };
const CLEAN: FormState = { error: null };
const SAVED: FormState = { error: null, saved: true };
const wasSaved = (state: FormState) => state.saved === true;

function DetailsStep({
  refs,
  timeZone,
  pack,
  onSaved,
}: {
  refs: ProjectKeyRef;
  timeZone: string;
  pack: PackSummary | null;
  onSaved: (id: string) => void;
}) {
  const t = useLabels();
  const [state, dispatch, pending] = useActionState(async (_s: FormState, data: FormData) => {
    const saved = await savePackAction(refs, pack?.id ?? null, {
      name: String(data.get("name") ?? ""),
      message: String(data.get("message") ?? ""),
      note: String(data.get("note") ?? ""),
      expiresOn: String(data.get("expiresOn") ?? ""),
    });
    if (!saved.ok) return { error: saved.error };
    onSaved(saved.data);
    return SAVED;
  }, CLEAN);
  const defaultExpiry = pack
    ? new Intl.DateTimeFormat("en-CA", { timeZone, dateStyle: "short" }).format(
        new Date(pack.expiresAt),
      )
    : dayInZone(30, timeZone);
  return (
    <form
      action={dispatch}
      onSubmit={keepInputOnSubmit(dispatch)}
      className="flex flex-col gap-8"
      key={pack?.id ?? "new"}
    >
      <Refusal error={state.error} />
      <Input
        id="pack-name"
        name="name"
        label={t("name")}
        defaultValue={pack?.name ?? ""}
        maxLength={120}
        required
        width="100%"
      />
      <Textarea
        id="pack-message"
        name="message"
        label={t("message")}
        help={t("messageHelp")}
        defaultValue={pack?.message ?? ""}
        maxLength={2000}
      />
      <Input
        id="pack-note"
        name="note"
        label={t("note")}
        help={t("noteHelp")}
        defaultValue={pack?.note ?? ""}
        maxLength={200}
        width="100%"
      />
      <Input
        id="pack-expires"
        name="expiresOn"
        type="date"
        label={t("expiresOn")}
        help={t("expiresHelp", { zone: timeZone })}
        defaultValue={defaultExpiry}
        min={dayInZone(0, timeZone)}
        max={dayInZone(89, timeZone)}
        required
      />
      <div className="flex flex-wrap items-center gap-8">
        <Button type="submit" variant="primary" loading={pending}>
          {t("saveDetails")}
        </Button>
        {wasSaved(state) ? (
          <span role="status" className="text-text-12 text-text-secondary">
            {t("savedDetails")}
          </span>
        ) : null}
      </div>
    </form>
  );
}

/** Adding one item at a time keeps the screen under seven fields; the list is read-only with Remove and order controls. */
function ItemsStep({
  refs,
  data,
  onChanged,
}: {
  refs: ProjectKeyRef;
  data: PackEditorData;
  onChanged: () => void;
}) {
  const t = useLabels();
  const [choices, setChoices] = useState<
    { value: string; label: string; expiresAt: string | null }[] | null
  >(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  useEffect(() => {
    void packItemChoicesAction(refs).then((result) => {
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setChoices([
        ...result.data.links.map((l) => ({
          value: `link:${l.id}`,
          label: t("linkChoice", {
            title: l.note ?? `${t(`linkKinds.${l.kind}`)} ${l.tokenHint}`,
          }),
          expiresAt: l.expiresAt,
        })),
        ...result.data.files.map((f) => ({
          value: `file:${f.id}`,
          label: t("fileChoice", { title: f.title }),
          expiresAt: null,
        })),
      ]);
    });
  }, [refs, t]);
  const [state, dispatch, adding] = useActionState(async (_s: FormState, form: FormData) => {
    const added = await addPackItemAction(refs, data.pack.id, {
      subject: String(form.get("subject") ?? ""),
      title: String(form.get("title") ?? ""),
      acknowledge: form.get("acknowledge") === "on",
    });
    if (!added.ok) return { error: added.error };
    onChanged();
    return SAVED;
  }, CLEAN);
  const keep = useKeepInput(state, dispatch, wasSaved);
  const move = (index: number, delta: number) => {
    const ids = data.items.map((i) => i.id);
    const [taken] = ids.splice(index, 1);
    if (!taken) return;
    ids.splice(index + delta, 0, taken);
    start(async () => {
      const result = await orderPackItemsAction(refs, data.pack.id, ids);
      if (!result.ok) setError(result.error);
      onChanged();
    });
  };
  const soon = data.items.some((item) => {
    const choice = choices?.find((c) => c.value === `link:${item.liveLinkId ?? ""}`);
    return choice?.expiresAt && Date.parse(choice.expiresAt) < Date.parse(data.pack.expiresAt);
  });
  return (
    <div className="flex flex-col gap-16">
      <Refusal error={error ?? state.error} />
      {soon ? <InlineAlert tone="warning">{t("linkExpiresFirst")}</InlineAlert> : null}
      <form action={dispatch} {...keep} className="flex flex-col gap-8">
        <Select
          key={choices === null ? "loading" : "loaded"}
          id="pack-item-subject"
          name="subject"
          label={t("itemSubject")}
          placeholder={choices === null ? t("loading") : t("itemPick")}
          options={(choices ?? []).map((c) => ({ value: c.value, label: c.label }))}
        />
        <Input
          id="pack-item-title"
          name="title"
          label={t("itemTitle")}
          maxLength={200}
          required
          width="100%"
        />
        <Checkbox id="pack-item-ack" name="acknowledge" label={t("acknowledge")} />
        <div>
          <Button type="submit" variant="primary" loading={adding}>
            {t("addItem")}
          </Button>
        </div>
      </form>
      {data.items.length === 0 ? (
        <p className="m-0 text-text-12 text-text-secondary">{t("noItems")}</p>
      ) : (
        <ul className="m-0 flex list-none flex-col divide-y divide-border-subtle p-0">
          {data.items.map((item, index) => (
            <li key={item.id} className="flex flex-wrap items-center justify-between gap-8 py-8">
              <span className="text-text-13">
                {item.title}
                {item.requiresAcknowledgement ? ` · ${t("asksAcknowledge")}` : ""}
              </span>
              <span className="flex gap-4">
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={index === 0 || pending}
                  onClick={() => move(index, -1)}
                >
                  {t("moveUp")}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={index === data.items.length - 1 || pending}
                  onClick={() => move(index, 1)}
                >
                  {t("moveDown")}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    start(async () => {
                      const result = await removePackItemAction(refs, item.id);
                      if (!result.ok) setError(result.error);
                      onChanged();
                    })
                  }
                >
                  {t("remove")}
                </Button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function RecipientsStep({
  refs,
  data,
  reveals,
  onChanged,
  onReveal,
  onDismiss,
}: {
  refs: ProjectKeyRef;
  data: PackEditorData;
  reveals: readonly HeldReveal[];
  onChanged: () => void;
  onReveal: (revealed: Revealed) => void;
  onDismiss: (key: number) => void;
}) {
  const t = useLabels();
  const [suppliers, setSuppliers] = useState<readonly { id: string; name: string }[]>([]);
  useEffect(() => {
    void packSupplierChoicesAction(refs).then((r) => {
      if (r.ok) setSuppliers(r.data);
    });
  }, [refs]);
  const [state, dispatch, pending] = useActionState(async (_s: FormState, form: FormData) => {
    const added = await addRecipientAction(refs, data.pack.id, {
      fullName: String(form.get("fullName") ?? ""),
      email: String(form.get("email") ?? ""),
      counterpartyId: String(form.get("counterpartyId") ?? ""),
      label: String(form.get("label") ?? ""),
    });
    if (!added.ok) return { error: added.error };
    onReveal(added.data);
    onChanged();
    return SAVED;
  }, CLEAN);
  const keep = useKeepInput(state, dispatch, wasSaved);
  return (
    <div className="flex flex-col gap-16">
      <Refusal error={state.error} />
      <RevealLines reveals={reveals} onDismiss={onDismiss} />
      <form action={dispatch} {...keep} className="flex flex-col gap-8">
        <Input
          id="pack-recipient-name"
          name="fullName"
          label={t("recipientName")}
          maxLength={200}
          required
          width="100%"
        />
        <Input
          id="pack-recipient-email"
          name="email"
          type="email"
          label={t("recipientEmail")}
          maxLength={320}
          required
          width="100%"
        />
        <Select
          key={suppliers.length}
          id="pack-recipient-supplier"
          name="counterpartyId"
          label={t("recipientSupplier")}
          help={t("recipientSupplierHelp")}
          value=""
          options={[
            { value: "", label: t("noSupplier") },
            ...suppliers.map((s) => ({ value: s.id, label: s.name })),
          ]}
        />
        <Input
          id="pack-recipient-label"
          name="label"
          label={t("recipientLabel")}
          help={t("recipientLabelHelp")}
          maxLength={80}
          width="100%"
        />
        <div>
          <Button type="submit" variant="primary" loading={pending}>
            {t("addRecipient")}
          </Button>
        </div>
      </form>
      {data.recipients.length === 0 ? (
        <p className="m-0 text-text-12 text-text-secondary">{t("noRecipients")}</p>
      ) : (
        <ul className="m-0 flex list-none flex-col divide-y divide-border-subtle p-0">
          {data.recipients.map((r) => (
            <li key={r.id} className="flex flex-wrap justify-between gap-8 py-8 text-text-13">
              <span>
                {r.fullName} · {r.email}
                {r.label ? ` · ${r.label}` : ""}
              </span>
              <span className="text-text-12 text-text-secondary">
                {r.revokedAt
                  ? t("recipientRevoked")
                  : r.unsubscribedAt
                    ? t("recipientStopped")
                    : r.failedAttempts >= 5
                      ? t("recipientLocked")
                      : ""}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function DeliveryStep({
  refs,
  data,
  timeZone,
  onChanged,
}: {
  refs: ProjectKeyRef;
  data: PackEditorData;
  timeZone: string;
  onChanged: () => void;
}) {
  const t = useLabels();
  const [cadence, setCadence] = useState<string>(data.schedule?.cadence ?? "Off");
  const [sent, setSent] = useState<{ count: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sending, start] = useTransition();
  const live = data.recipients.filter((r) => r.revokedAt === null);
  const send = (ids: readonly string[] | null, total: number) =>
    start(async () => {
      setError(null);
      setSent(null);
      const result = await sendPackAction(refs, data.pack.id, ids);
      if (result.ok) setSent({ count: result.data, total });
      else setError(result.error);
      onChanged();
    });
  const [state, dispatch, pending] = useActionState(async (_s: FormState, form: FormData) => {
    const saved = await savePackScheduleAction(refs, data.pack.id, {
      cadence: String(form.get("cadence") ?? "Off"),
      localHour: Number(form.get("localHour") ?? 9),
      weekday: form.get("weekday") ? Number(form.get("weekday")) : null,
      monthDay: form.get("monthDay") ? Number(form.get("monthDay")) : null,
    });
    if (!saved.ok) return { error: saved.error };
    onChanged();
    return SAVED;
  }, CLEAN);
  return (
    <div className="flex flex-col gap-16">
      <Refusal error={error ?? state.error} />
      <div className="flex flex-col gap-8">
        <p className="m-0 text-text-13 text-text-secondary">{t("sendHelp")}</p>
        <div className="flex flex-wrap items-center gap-8">
          <Button
            type="button"
            size="sm"
            variant="secondary"
            loading={sending}
            onClick={() => send(null, live.length)}
          >
            {t("send")}
          </Button>
          {sent === null ? null : (
            <span role="status" className="text-text-12 text-text-secondary">
              {sent.count === 0
                ? t("sentNone")
                : sent.count < sent.total
                  ? t("sentSome", { count: sent.count, total: sent.total })
                  : t("sent", { count: sent.count })}
            </span>
          )}
        </div>
        {live.length === 0 ? null : (
          <ul
            aria-label={t("sendOneHeading")}
            className="m-0 flex list-none flex-col divide-y divide-border-subtle p-0"
          >
            {live.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-8 py-4">
                <span className="text-text-13">
                  {r.fullName} · {r.email}
                  {r.unsubscribedAt ? ` · ${t("recipientStopped")}` : ""}
                </span>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={sending || r.unsubscribedAt !== null}
                  onClick={() => send([r.id], 1)}
                >
                  {t("sendOne", { name: r.fullName })}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <form
        action={dispatch}
        onSubmit={keepInputOnSubmit(dispatch)}
        className="flex flex-col gap-8"
      >
        <Select
          id="pack-cadence"
          name="cadence"
          label={t("cadence")}
          value={cadence}
          onChange={(event) => setCadence(event.target.value)}
          options={["Off", "Daily", "Weekly", "Monthly"].map((c) => ({
            value: c,
            label: t(`cadences.${c}`),
          }))}
        />
        {cadence === "Off" ? null : (
          <Select
            key={cadence}
            id="pack-hour"
            name="localHour"
            label={t("hour", { zone: data.schedule?.timeZone ?? timeZone })}
            value={String(data.schedule?.localHour ?? 9)}
            options={Array.from({ length: 24 }, (_, h) => ({
              value: String(h),
              label: `${String(h).padStart(2, "0")}:00`,
            }))}
          />
        )}
        {cadence === "Weekly" ? (
          <Select
            id="pack-weekday"
            name="weekday"
            label={t("weekday")}
            value={String(data.schedule?.weekday ?? 1)}
            options={[1, 2, 3, 4, 5, 6, 7].map((d) => ({
              value: String(d),
              label: t(`weekdays.${d}`),
            }))}
          />
        ) : null}
        {cadence === "Monthly" ? (
          <Select
            id="pack-month-day"
            name="monthDay"
            label={t("monthDay")}
            value={String(data.schedule?.monthDay ?? 1)}
            options={Array.from({ length: 28 }, (_, d) => ({
              value: String(d + 1),
              label: String(d + 1),
            }))}
          />
        ) : null}
  XX      </form>
    </div>
  );
}

function ActivityStep({ data, timeZone }: { data: PackEditorData; timeZone: string }) {
  const t = useLabels();
  const format = useFormatter();
  const date = (iso: string | null) =>
    iso
      ? format.dateTime(new Date(iso), { dateStyle: "medium", timeStyle: "short", timeZone })
      : "";
  const byId = new Map(data.activity.map((a) => [a.recipientId, a]));
  const itemTitle = new Map(data.items.map((i) => [i.id, i.title]));
  return (
    <div className="flex flex-col gap-16">
      <table role="grid" aria-label={t("activity")} className="w-full text-text-13">
        <thead>
          <tr className="text-start text-text-12 text-text-secondary">
            <th scope="col" className="text-start">
              {t("recipientName")}
            </th>
            <th scope="col" className="text-start">
              {t("opensColumn")}
            </th>
            <th scope="col" className="text-start">
              {t("lastOpenedColumn")}
            </th>
            <th scope="col" className="text-start">
              {t("viewedColumn")}
            </th>
            <th scope="col" className="text-start">
              {t("downloadsColumn")}
            </th>
          </tr>
        </thead>
        <tbody>
          {data.recipients.map((r) => {
            const a = byId.get(r.id);
            return (
              <tr key={r.id}>
                <td>{r.fullName}</td>
                <td>{a?.opens ?? 0}</td>
                <td>{date(a?.lastOpenedAt ?? null)}</td>
                <td>{a?.itemsViewed ?? 0}</td>
                <td>{a?.downloads ?? 0}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {data.signatures.length === 0 ? null : (
        <div className="flex flex-col gap-4">
          <h4 className="m-0 text-label-13 font-medium">{t("signatures")}</h4>
          <ul className="m-0 flex list-none flex-col gap-4 p-0 text-text-13">
            {data.signatures.map((s) => (
              <li key={`${s.recipientId}-${s.itemId}`}>
                {t("signatureLine", {
                  name: s.signerName,
                  item: itemTitle.get(s.itemId) ?? "",
                  date: date(s.occurredAt),
                })}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/**
 * The stakeholder pack editor (B2, ADR 0141): one screen per concern, each under seven fields with its own primary, so
 * only the current step is mounted. A code from Add recipient shows on the Recipients step at once, and stays in the
 * section's reveal panels after this dialog closes, each until dismissed. Loaded on first click.
 */
export function PackEditorDialog({
  refs,
  timeZone,
  startNew,
  reveals,
  onReveal,
  onDismiss,
  onClose,
}: {
  refs: ProjectKeyRef;
  timeZone: string;
  startNew: boolean;
  reveals: readonly HeldReveal[];
  onReveal: (revealed: Revealed) => void;
  onDismiss: (key: number) => void;
  onClose: () => void;
}) {
  const t = useLabels();
  const [packs, setPacks] = useState<readonly PackSummary[] | null>(null);
  const [packId, setPackId] = useState<string | null>(null);
  const [creating, setCreating] = useState(startNew);
  const [step, setStep] = useState<Step>("details");
  const [data, setData] = useState<PackEditorData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const [pending, start] = useTransition();

  const reload = useCallback(() => {
    if (packId === null) {
      void listPacksAction(refs).then((r) => (r.ok ? setPacks(r.data) : setError(r.error)));
      return;
    }
    void loadPackAction(refs, packId).then((r) => (r.ok ? setData(r.data) : setError(r.error)));
  }, [refs, packId]);
  useEffect(reload, [reload]);

  const body = () => {
    if (creating) {
      return (
        <DetailsStep
          refs={refs}
          timeZone={timeZone}
          pack={null}
          onSaved={(id) => {
            setCreating(false);
            setPackId(id);
            setStep("items");
          }}
        />
      );
    }
    if (packId === null) {
      return packs === null ? (
        <p className="m-0 text-text-13 text-text-secondary">{t("loading")}</p>
      ) : packs.length === 0 ? (
        <p className="m-0 text-text-13 text-text-secondary">{t("noPacks")}</p>
      ) : (
        <ul className="m-0 flex list-none flex-col divide-y divide-border-subtle p-0">
          {packs.map((p) => (
            <li key={p.id} className="flex flex-wrap items-center justify-between gap-8 py-8">
              <span className="text-text-13">
                {p.name}
                {p.revokedAt ? ` · ${t("revoked")}` : ""}
              </span>
              <Button type="button" size="sm" variant="secondary" onClick={() => setPackId(p.id)}>
                {t("open")}
              </Button>
            </li>
          ))}
        </ul>
      );
    }
    if (data === null)
      return <p className="m-0 text-text-13 text-text-secondary">{t("loading")}</p>;
    return (
      <div className="flex flex-col gap-16">
        <nav aria-label={t("steps")} className="flex flex-wrap gap-4">
          {STEPS.map((s) => (
            <Button
              key={s}
              type="button"
              size="sm"
              variant={s === step ? "secondary" : "ghost"}
              aria-current={s === step ? "step" : undefined}
              onClick={() => setStep(s)}
            >
              {t(`stepNames.${s}`)}
            </Button>
          ))}
        </nav>
        {step === "details" ? (
          <DetailsStep refs={refs} timeZone={timeZone} pack={data.pack} onSaved={() => reload()} />
        ) : step === "items" ? (
          <ItemsStep refs={refs} data={data} onChanged={reload} />
        ) : step === "recipients" ? (
          <RecipientsStep
            refs={refs}
            data={data}
            reveals={reveals}
            onChanged={reload}
            onReveal={onReveal}
            onDismiss={onDismiss}
          />
        ) : step === "delivery" ? (
          <DeliveryStep refs={refs} data={data} timeZone={timeZone} onChanged={reload} />
        ) : (
          <ActivityStep data={data} timeZone={timeZone} />
        )}
        {data.pack.revokedAt ? null : confirmRevoke ? (
          <span className="flex flex-col gap-8">
            <span className="text-text-12">{t("revokeConfirm")}</span>
            <span className="flex gap-8">
              <Button
                type="button"
                size="sm"
                variant="secondary"
                onClick={() => setConfirmRevoke(false)}
              >
                {t("cancel")}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="danger"
                loading={pending}
                onClick={() =>
                  start(async () => {
                    const result = await revokePackAction(refs, data.pack.id);
                    if (!result.ok) setError(result.error);
                    setConfirmRevoke(false);
                    reload();
                  })
                }
              >
                {t("revokePack")}
              </Button>
            </span>
          </span>
        ) : (
          <div>
            <Button type="button" size="sm" variant="ghost" onClick={() => setConfirmRevoke(true)}>
              {t("revokePack")}
            </Button>
          </div>
        )}
      </div>
    );
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={data?.pack.name ?? t("title")}
      description={t("description")}
      actions={
        <Button type="button" variant="secondary" onClick={onClose}>
          {t("close")}
        </Button>
      }
    >
      <div className="flex flex-col gap-16">
        <Refusal error={error} />
        {body()}
      </div>
    </Dialog>
  );
}

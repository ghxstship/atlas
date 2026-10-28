"use client";

import type { AccessPath } from "@xos/data/access";
import type { CustomDataType } from "@xos/data/custom-objects";
import { Checkbox, Drawer, Input, PropertyList, Select, Textarea } from "@xos/ui";
import type { Route } from "next";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useTranslations } from "next-intl";
import { createRecordAction, setChoiceAction } from "@/app/[org]/objects/actions";
import { WhyCanISeeThis } from "@/components/access/why-can-i-see-this";
import { FieldHistoryList, type HistoryItem } from "@/components/history/field-history-list";
import { ActionForm, usePlatformT } from "@/components/platform/kit";
import { Region } from "@/components/shell/region";
import { CollabPanels } from "@/components/work/collab";
import type { Conversation } from "@/components/work/record-sections";

/** Money fields are entered in US dollars, shown beside the amount. */
const MONEY_CURRENCY = "USD";

export interface CreateField {
  readonly id: string;
  readonly label: string;
  readonly dataType: CustomDataType;
  readonly required: boolean;
  readonly choices: readonly { value: string; label: string }[];
}

export interface PeekField {
  readonly id: string;
  readonly label: string;
  readonly value: string | null;
  readonly choices: readonly { value: string; label: string }[] | null;
  readonly current: string | null;
}

/** Creates a record from the object's typed fields; each input matches its field's data type. */
export function CreateRecordDrawer({
  org,
  objectKey,
  label,
  fields,
  closeHref,
}: {
  org: string;
  objectKey: string;
  label: string;
  fields: readonly CreateField[];
  closeHref: string;
}) {
  const t = usePlatformT();
  const router = useRouter();
  const [choices, setChoices] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      fields.filter((f) => f.dataType === "Choice").map((f) => [f.id, f.choices[0]?.value ?? ""]),
    ),
  );
  const close = () => router.push(closeHref as Route, { scroll: false });
  return (
    <Drawer
      title={t("objects.createTitle", { object: label })}
      open
      onOpenChange={(open) => (open ? null : close())}
    >
      <ActionForm
        action={createRecordAction}
        hidden={{
          org,
          objectKey,
          ...Object.fromEntries(Object.entries(choices).map(([id, v]) => [`field:${id}`, v])),
        }}
        label={t("objects.createTitle", { object: label })}
        submitLabel={t("objects.createSubmit")}
      >
        <Input
          id="record-title"
          name="title"
          label={t("objects.titleColumn")}
          required
          maxLength={300}
          width="100%"
        />
        {fields.map((f) => {
          const id = `record-field-${f.id}`;
          const name = `field:${f.id}`;
          const fieldLabel = f.required ? t("objects.requiredLabel", { label: f.label }) : f.label;
          switch (f.dataType) {
            case "Choice":
              return (
                <Select
                  key={f.id}
                  label={fieldLabel}
                  value={choices[f.id] ?? ""}
                  options={[
                    ...(f.required ? [] : [{ value: "", label: t("objects.noValue") }]),
                    ...f.choices,
                  ]}
                  onChange={(e) => setChoices((prev) => ({ ...prev, [f.id]: e.target.value }))}
                />
              );
            case "Boolean":
              return <Checkbox key={f.id} id={id} name={name} label={fieldLabel} value="true" />;
            case "Text":
              return (
                <Textarea
                  key={f.id}
                  id={id}
                  name={name}
                  label={fieldLabel}
                  required={f.required}
                  rows={2}
                  width="100%"
                />
              );
            case "Money":
              return (
                <div key={f.id} className="flex flex-wrap items-end gap-8">
                  <Input
                    id={id}
                    name={name}
                    label={fieldLabel}
                    inputMode="decimal"
                    pattern="\d+(\.\d{1,2})?"
                    required={f.required}
                    width={160}
                  />
                  <input type="hidden" name={`currency:${f.id}`} value={MONEY_CURRENCY} />
                  <span className="pb-8 text-text-13 text-text-secondary">{MONEY_CURRENCY}</span>
                </div>
              );
            default:
              return (
                <Input
                  key={f.id}
                  id={id}
                  name={name}
                  label={fieldLabel}
                  required={f.required}
                  width="100%"
                  type={
                    f.dataType === "Date"
                      ? "date"
                      : f.dataType === "Timestamp"
                        ? "datetime-local"
                        : f.dataType === "Number"
                          ? "number"
                          : f.dataType === "Email"
                            ? "email"
                            : f.dataType === "URL"
                              ? "url"
                              : "text"
                  }
                />
              );
          }
        })}
      </ActionForm>
    </Drawer>
  );
}

/**
 * A record in the side peek: its values, moving it to another board column, its activity (the field
 * history 2100 records), its comments and files through the same panels as every record's (Section
 * 4.6.3), and Why can I see this. The activity and the comments and files each fail alone (A143).
 */
export function RecordPeek({
  org,
  objectKey,
  recordId,
  recordKey,
  title,
  fields,
  paths,
  canWrite,
  closeHref,
  activity,
  conversation,
  me,
}: {
  org: string;
  objectKey: string;
  recordId: string;
  recordKey: string;
  title: string;
  fields: readonly PeekField[];
  paths: readonly AccessPath[] | null;
  canWrite: boolean;
  closeHref: string;
  /** The record's field history, worded; null when it could not be read. */
  activity: readonly HistoryItem[] | null;
  conversation: Conversation;
  /** The viewer's person id, to offer deleting their own comments and files. */
  me: string | null;
}) {
  const t = usePlatformT();
  const c = useTranslations("collab");
  const router = useRouter();
  const board = fields.find((f) => f.choices !== null);
  const [choice, setChoice] = useState(board?.current ?? board?.choices?.[0]?.value ?? "");
  return (
    <Drawer
      title={`${recordKey} ${title}`}
      open
      onOpenChange={(open) => (open ? null : router.push(closeHref as Route, { scroll: false }))}
    >
      <PropertyList
        items={fields.map((f) => ({ label: f.label, value: f.value ?? t("objects.noValue") }))}
      />
      {canWrite && board && board.choices ? (
        <ActionForm
          action={setChoiceAction}
          hidden={{ org, objectKey, record: recordId, field: board.id, choice }}
          label={t("objects.moveForm", { field: board.label })}
          submitLabel={t("objects.moveSubmit")}
          success={t("objects.moved")}
          inline
          onDone={() => router.refresh()}
        >
          <Select
            label={t("objects.move", { field: board.label })}
            value={choice}
            options={[...board.choices]}
            onChange={(e) => setChoice(e.target.value)}
          />
        </ActionForm>
      ) : null}
      <Region>
        {activity ? (
          <FieldHistoryList
            id={recordId}
            title={c("history.title")}
            empty={c("history.empty")}
            items={activity}
          />
        ) : (
          <p className="m-0 text-text-13 text-text-secondary">{c("history.unavailable")}</p>
        )}
      </Region>
      <Region>
        <CollabPanels
          org={org}
          subject={{ table: "app.custom_object_records", id: recordId }}
          threads={conversation.threads}
          attachments={conversation.attachments}
          names={conversation.names}
          me={me}
          canPost
        />
      </Region>
      <WhyCanISeeThis paths={paths} />
    </Drawer>
  );
}

"use client";

import {
  AUTOMATION_ACTION_TYPES,
  AutomationConditions,
  explainConditions,
  renderTemplate,
  type AutomationActionType,
  type FilterOperator,
} from "@xos/schemas/automations";
import {
  Button,
  Drawer,
  IconButton,
  InlineAlert,
  Input,
  Radio,
  Select,
  Switch,
  Textarea,
} from "@xos/ui";
import { useAutomationCopy } from "./copy";
import { useEffect, useId, useMemo, useState, useTransition } from "react";
import {
  loadAutomationEditorAction,
  sampleEventAction,
  saveAutomationAction,
  type EditorData,
} from "@/app/[org]/settings/automation-actions";

/**
 * The automation editor (A91, ADR 0047), loaded when a person opens it: the trigger from the event catalog, conditions
 * in the API filter grammar (all or any, one level of groups), the actions in run order, and a test against a sample
 * event that runs nothing. The test evaluates here with @xos/schemas, the twin of the database's evaluator.
 */

const OPERATORS: readonly FilterOperator[] = [
  "eq",
  "ne",
  "lt",
  "lte",
  "gt",
  "gte",
  "in",
  "is_null",
  "contains",
];
const RECORD_STATES = [
  "Proposed",
  "Ready",
  "Scheduled",
  "Active",
  "Blocked",
  "In Review",
  "Complete",
  "Deferred",
  "Canceled",
];
const BASE_PATHS = ["type", "project_id", "subject.table", "subject.id", "occurred_at"];

interface ConditionDraft {
  readonly key: string;
  readonly field: string;
  readonly operator: FilterOperator;
  readonly value: string;
}

type ItemDraft =
  | { readonly kind: "condition"; readonly key: string; readonly condition: ConditionDraft }
  | {
      readonly kind: "group";
      readonly key: string;
      readonly match: "all" | "any";
      readonly conditions: readonly ConditionDraft[];
    };

interface ActionDraft {
  readonly key: string;
  readonly type: AutomationActionType;
  readonly title: string;
  readonly body: string;
  readonly projectId: string;
  readonly phaseCode: string;
  readonly xyz: string;
  readonly dueInDays: string;
  readonly toState: string;
  readonly personId: string;
  readonly webhookEndpointId: string;
}

let sequence = 0;
const nextKey = () => {
  sequence += 1;
  return `k${sequence}`;
};

const newCondition = (): ConditionDraft => ({
  key: nextKey(),
  field: "",
  operator: "eq",
  value: "",
});

function newAction(type: AutomationActionType = "add_comment"): ActionDraft {
  return {
    key: nextKey(),
    type,
    title: "",
    body: "",
    projectId: "",
    phaseCode: "SCP",
    xyz: "Y",
    dueInDays: "",
    toState: "Complete",
    personId: "",
    webhookEndpointId: "",
  };
}

type Json = Record<string, unknown>;

function conditionFrom(raw: Json): ConditionDraft {
  const operator = (OPERATORS as readonly string[]).includes(String(raw["operator"]))
    ? (raw["operator"] as FilterOperator)
    : "eq";
  const value =
    typeof raw["value"] === "string" ? raw["value"] : operator === "is_null" ? "true" : "";
  return { key: nextKey(), field: String(raw["field"] ?? ""), operator, value };
}

function itemsFrom(doc: unknown): { match: "all" | "any"; items: ItemDraft[] } {
  const root = (doc ?? {}) as Json;
  const match = Array.isArray(root["any"]) ? "any" : "all";
  const list = (Array.isArray(root[match]) ? root[match] : []) as Json[];
  return {
    match,
    items: list.map((entry) => {
      const inner = Array.isArray(entry["all"])
        ? "all"
        : Array.isArray(entry["any"])
          ? "any"
          : null;
      return inner === null
        ? { kind: "condition", key: nextKey(), condition: conditionFrom(entry) }
        : {
            kind: "group",
            key: nextKey(),
            match: inner,
            conditions: (entry[inner] as Json[]).map(conditionFrom),
          };
    }),
  };
}

function actionsFrom(doc: unknown): ActionDraft[] {
  const list = (Array.isArray(doc) ? doc : []) as Json[];
  return list.map((a) => ({
    ...newAction(
      (AUTOMATION_ACTION_TYPES as readonly string[]).includes(String(a["type"]))
        ? (a["type"] as AutomationActionType)
        : "add_comment",
    ),
    title: String(a["title"] ?? ""),
    body: String(a["body"] ?? a["note"] ?? ""),
    projectId: String(a["project_id"] ?? ""),
    phaseCode: String(a["phase_code"] ?? "SCP"),
    xyz: String(a["xyz"] ?? "Y"),
    dueInDays:
      a["due_in_days"] === undefined || a["due_in_days"] === null ? "" : String(a["due_in_days"]),
    toState: String(a["to_state"] ?? "Complete"),
    personId: String(a["assignee_person_id"] ?? a["recipient_person_id"] ?? ""),
    webhookEndpointId: String(a["webhook_endpoint_id"] ?? ""),
  }));
}

function conditionDoc(c: ConditionDraft): Json {
  if (c.operator === "is_null")
    return {
      field: c.field.trim(),
      operator: c.operator,
      value: c.value === "false" ? "false" : "true",
    };
  return { field: c.field.trim(), operator: c.operator, value: c.value };
}

function conditionsDoc(match: "all" | "any", items: readonly ItemDraft[]): Json {
  return {
    [match]: items.map((i) =>
      i.kind === "condition"
        ? conditionDoc(i.condition)
        : { [i.match]: i.conditions.map(conditionDoc) },
    ),
  };
}

function actionDoc(a: ActionDraft): Json {
  switch (a.type) {
    case "create_task":
      return {
        type: a.type,
        title: a.title,
        project_id: a.projectId === "" ? null : a.projectId,
        phase_code: a.phaseCode,
        xyz: a.xyz,
        due_in_days: a.dueInDays.trim() === "" ? null : Number(a.dueInDays),
      };
    case "update_status":
      return {
        type: a.type,
        to_state: a.toState,
        ...(a.body.trim() === "" ? {} : { note: a.body }),
      };
    case "assign":
      return { type: a.type, assignee_person_id: a.personId };
    case "add_comment":
      return { type: a.type, body: a.body };
    case "notify":
      return {
        type: a.type,
        recipient_person_id: a.personId,
        title: a.title,
        ...(a.body.trim() === "" ? {} : { body: a.body }),
      };
    default:
      return { type: a.type, webhook_endpoint_id: a.webhookEndpointId };
  }
}

/** Paths of a sample event, for the field suggestions. */
function pathsOf(value: unknown, prefix = "", depth = 0): string[] {
  if (depth > 3 || typeof value !== "object" || value === null || Array.isArray(value)) return [];
  return Object.entries(value as Json).flatMap(([k, v]) => {
    const path = prefix === "" ? k : `${prefix}.${k}`;
    return /^[a-z0-9_]+$/.test(k) ? [path, ...pathsOf(v, path, depth + 1)] : [];
  });
}

export function AutomationEditor({
  org,
  automationId,
  onClose,
  onSaved,
}: {
  org: string;
  automationId: string | null;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const t = useAutomationCopy();
  const formId = useId();
  const listId = useId();
  const [data, setData] = useState<EditorData | null | undefined>(undefined);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [trigger, setTrigger] = useState("record.created");
  const [match, setMatch] = useState<"all" | "any">("all");
  const [items, setItems] = useState<ItemDraft[]>([]);
  const [actions, setActions] = useState<ActionDraft[]>([newAction()]);
  const [enabled, setEnabled] = useState(true);
  const [sample, setSample] = useState("");
  const [testOutcome, setTestOutcome] = useState<ReturnType<typeof explainConditions> | null>(null);
  const [testError, setTestError] = useState("");
  const [error, setError] = useState("");
  const [saving, startSaving] = useTransition();
  const [loadingSample, startSample] = useTransition();

  useEffect(() => {
    let live = true;
    void loadAutomationEditorAction(org, automationId).then((loaded) => {
      if (!live) return;
      setData(loaded);
      const a = loaded?.automation;
      if (a) {
        setName(a.name);
        setDescription(a.description ?? "");
        setTrigger(a.triggerEventType);
        const parsed = itemsFrom(a.conditions);
        setMatch(parsed.match);
        setItems(parsed.items);
        setActions(actionsFrom(a.actions));
        setEnabled(a.enabled);
      } else if (loaded && !loaded.options.eventTypes.some((e) => e.code === "record.created")) {
        setTrigger(loaded.options.eventTypes[0]?.code ?? "");
      }
    });
    return () => {
      live = false;
    };
  }, [org, automationId]);

  const sampleEvent = useMemo(() => {
    try {
      return sample.trim() === "" ? null : (JSON.parse(sample) as unknown);
    } catch {
      return undefined;
    }
  }, [sample]);
  const fieldPaths = useMemo(
    () => [...new Set([...BASE_PATHS, ...pathsOf(sampleEvent)])].sort(),
    [sampleEvent],
  );

  const options = data?.options;
  const eventType = options?.eventTypes.find((e) => e.code === trigger);
  const people = [{ value: "", label: t("editor.fields.choose") }, ...(options?.people ?? [])];
  const operatorOptions = OPERATORS.map((o) => ({ value: o, label: t(`editor.operators.${o}`) }));

  const updateItem = (key: string, next: (item: ItemDraft) => ItemDraft) =>
    setItems((list) => list.map((i) => (i.key === key ? next(i) : i)));
  const updateAction = (key: string, patch: Partial<ActionDraft>) =>
    setActions((list) => list.map((a) => (a.key === key ? { ...a, ...patch } : a)));
  const moveAction = (index: number, by: number) =>
    setActions((list) => {
      const next = [...list];
      const [moved] = next.splice(index, 1);
      if (moved) next.splice(index + by, 0, moved);
      return next;
    });

  const save = () =>
    startSaving(async () => {
      const result = await saveAutomationAction(org, {
        id: automationId,
        name,
        description,
        triggerEventType: trigger,
        conditions: conditionsDoc(match, items),
        actions: actions.map(actionDoc),
        enabled,
        expectedUpdatedAt: data?.automation?.updatedAt ?? null,
      });
      if (result.ok) onSaved(t("editor.saved"));
      else setError(result.error ?? t("errors.unexpected"));
    });

  const test = () => {
    setTestOutcome(null);
    if (sampleEvent === undefined) {
      setTestError(t("editor.test.invalidJson"));
      return;
    }
    const parsed = AutomationConditions.safeParse(conditionsDoc(match, items));
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      setTestError(
        t("errors.automation_conditions_invalid", {
          detail: `${issue?.path.join(".") ?? ""} ${issue?.message ?? ""}`,
        }),
      );
      return;
    }
    setTestError("");
    setTestOutcome(explainConditions(parsed.data, sampleEvent ?? {}));
  };

  const conditionRow = (
    c: ConditionDraft,
    change: (patch: Partial<ConditionDraft>) => void,
    remove: () => void,
  ) => (
    <div key={c.key} className="flex flex-wrap items-end gap-8">
      <Input
        label={t("editor.field")}
        value={c.field}
        list={listId}
        width={200}
        placeholder="data.record_kind"
        onChange={(e) => change({ field: e.currentTarget.value })}
      />
      <Select
        label={t("editor.operator")}
        value={c.operator}
        options={operatorOptions}
        onChange={(e) => {
          const operator = e.currentTarget.value as FilterOperator;
          change({
            operator,
            value: operator === "is_null" ? "true" : c.operator === "is_null" ? "" : c.value,
          });
        }}
      />
      {c.operator === "is_null" ? (
        <Select
          key={`${c.key}-null`}
          label={t("editor.value")}
          value={c.value === "false" ? "false" : "true"}
          options={[
            { value: "true", label: t("editor.isNull.true") },
            { value: "false", label: t("editor.isNull.false") },
          ]}
          onChange={(e) => change({ value: e.currentTarget.value })}
        />
      ) : (
        <Input
          label={t("editor.value")}
          value={c.value}
          width={200}
          {...(c.operator === "in" ? { help: t("editor.valueHelpIn") } : {})}
          onChange={(e) => change({ value: e.currentTarget.value })}
        />
      )}
      <IconButton icon="X" label={t("editor.removeCondition")} onClick={remove} />
    </div>
  );

  const actionFields = (a: ActionDraft) => {
    const textHelp = t("editor.templateHelp", { example: "{{data.title}}" });
    switch (a.type) {
      case "create_task":
        return (
          <>
            <Input
              label={t("editor.fields.title")}
              value={a.title}
              width="100%"
              help={t("editor.fields.taskTitleHelp", { example: "{{data.title}}" })}
              onChange={(e) => updateAction(a.key, { title: e.currentTarget.value })}
            />
            <Select
              label={t("editor.fields.project")}
              value={a.projectId}
              options={[
                { value: "", label: t("editor.fields.eventProject") },
                ...(options?.projects ?? []),
              ]}
              onChange={(e) => updateAction(a.key, { projectId: e.currentTarget.value })}
            />
            <div className="flex flex-wrap gap-8">
              <Select
                label={t("editor.fields.phase")}
                value={a.phaseCode}
                options={[...(options?.phases ?? [])]}
                onChange={(e) => updateAction(a.key, { phaseCode: e.currentTarget.value })}
              />
              <Select
                label={t("editor.fields.xyz")}
                value={a.xyz}
                options={["X", "Y", "Z"].map((x) => ({
                  value: x,
                  label: t(`editor.fields.xyzOptions.${x}`),
                }))}
                onChange={(e) => updateAction(a.key, { xyz: e.currentTarget.value })}
              />
              <Input
                label={t("editor.fields.dueInDays")}
                type="number"
                min={0}
                max={365}
                width={140}
                value={a.dueInDays}
                help={t("editor.fields.dueHelp")}
                onChange={(e) => updateAction(a.key, { dueInDays: e.currentTarget.value })}
              />
            </div>
          </>
        );
      case "update_status":
        return (
          <>
            <Select
              label={t("editor.fields.toState")}
              value={a.toState}
              options={RECORD_STATES.map((s) => ({ value: s, label: s }))}
              onChange={(e) => updateAction(a.key, { toState: e.currentTarget.value })}
            />
            <Textarea
              label={t("editor.fields.note")}
              value={a.body}
              help={t("editor.fields.noteHelp")}
              rows={2}
              width="100%"
              onChange={(e) => updateAction(a.key, { body: e.currentTarget.value })}
            />
          </>
        );
      case "assign":
        return (
          <Select
            label={t("editor.fields.assignee")}
            value={a.personId}
            options={people}
            onChange={(e) => updateAction(a.key, { personId: e.currentTarget.value })}
          />
        );
      case "add_comment":
        return (
          <Textarea
            label={t("editor.fields.comment")}
            value={a.body}
            help={textHelp}
            rows={3}
            width="100%"
            onChange={(e) => updateAction(a.key, { body: e.currentTarget.value })}
          />
        );
      case "notify":
        return (
          <>
            <Select
              label={t("editor.fields.recipient")}
              value={a.personId}
              options={people}
              onChange={(e) => updateAction(a.key, { personId: e.currentTarget.value })}
            />
            <Input
              label={t("editor.fields.title")}
              value={a.title}
              width="100%"
              help={textHelp}
              onChange={(e) => updateAction(a.key, { title: e.currentTarget.value })}
            />
            <Textarea
              label={t("editor.fields.message")}
              value={a.body}
              rows={2}
              width="100%"
              onChange={(e) => updateAction(a.key, { body: e.currentTarget.value })}
            />
          </>
        );
      default:
        return (options?.webhooks.length ?? 0) === 0 ? (
          <InlineAlert tone="info">{t("editor.fields.noEndpoints")}</InlineAlert>
        ) : (
          <Select
            label={t("editor.fields.endpoint")}
            value={a.webhookEndpointId}
            options={[
              { value: "", label: t("editor.fields.choose") },
              ...(options?.webhooks ?? []).map((w) => ({
                value: w.id,
                label: w.description ? `${w.description} (${w.url})` : w.url,
              })),
            ]}
            onChange={(e) => updateAction(a.key, { webhookEndpointId: e.currentTarget.value })}
          />
        );
    }
  };

  return (
    <Drawer
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={automationId === null ? t("editor.titleNew") : t("editor.titleEdit")}
      footer={
        <>
          <Button type="button" variant="ghost" onClick={onClose}>
            {t("editor.cancel")}
          </Button>
          <Button type="submit" form={formId} variant="primary" loading={saving} disabled={!data}>
            {t("editor.save")}
          </Button>
        </>
      }
    >
      {data === undefined ? (
        <p role="status" className="m-0 text-text-13 text-text-secondary">
          {t("editor.loading")}
        </p>
      ) : data === null ? (
        <InlineAlert tone="danger">{t("editor.loadFailed")}</InlineAlert>
      ) : (
        <form
          id={formId}
          className="flex flex-col gap-20"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            save();
          }}
        >
          {error ? <InlineAlert tone="danger">{error}</InlineAlert> : null}
          <datalist id={listId}>
            {fieldPaths.map((p) => (
              <option key={p} value={p} />
            ))}
          </datalist>
          <Input
            label={t("editor.name")}
            value={name}
            width="100%"
            required
            maxLength={120}
            onChange={(e) => setName(e.currentTarget.value)}
          />
          <Textarea
            label={t("editor.description")}
            value={description}
            rows={2}
            width="100%"
            maxLength={500}
            onChange={(e) => setDescription(e.currentTarget.value)}
          />
          <Select
            label={t("editor.trigger")}
            value={trigger}
            help={
              eventType
                ? `${t("editor.triggerHelp")} ${eventType.description}`
                : t("editor.triggerHelp")
            }
            options={options?.eventTypes.map((e) => ({ value: e.code, label: e.code })) ?? []}
            onChange={(e) => setTrigger(e.currentTarget.value)}
          />

          <fieldset className="m-0 flex flex-col gap-12 border-0 p-0">
            <legend className="mb-8 text-text-14 font-semibold">{t("editor.conditions")}</legend>
            <Radio
              label={t("editor.matchLabel")}
              name={`${formId}-match`}
              value={match}
              options={[
                { value: "all", label: t("editor.match.all") },
                { value: "any", label: t("editor.match.any") },
              ]}
              onChange={(e) => setMatch(e.currentTarget.value === "any" ? "any" : "all")}
            />
            {items.length === 0 ? (
              <p className="m-0 text-text-13 text-text-secondary">{t("editor.noConditions")}</p>
            ) : null}
            {items.map((item, index) =>
              item.kind === "condition" ? (
                conditionRow(
                  item.condition,
                  (patch) =>
                    updateItem(item.key, (i) =>
                      i.kind === "condition"
                        ? { ...i, condition: { ...i.condition, ...patch } }
                        : i,
                    ),
                  () => setItems((list) => list.filter((i) => i.key !== item.key)),
                )
              ) : (
                <fieldset
                  key={item.key}
                  className="m-0 flex flex-col gap-8 rounded-8 border border-border-subtle p-12"
                >
                  <legend className="px-4 text-text-13 font-medium">
                    {t("editor.group", { number: index + 1 })}
                  </legend>
                  <div className="flex flex-wrap items-end gap-8">
                    <Select
                      label={t("editor.matchLabel")}
                      value={item.match}
                      options={[
                        { value: "all", label: t("editor.groupMatch.all") },
                        { value: "any", label: t("editor.groupMatch.any") },
                      ]}
                      onChange={(e) =>
                        updateItem(item.key, (i) =>
                          i.kind === "group"
                            ? { ...i, match: e.currentTarget.value === "any" ? "any" : "all" }
                            : i,
                        )
                      }
                    />
                    <IconButton
                      icon="Trash2"
                      label={t("editor.removeGroup")}
                      onClick={() => setItems((list) => list.filter((i) => i.key !== item.key))}
                    />
                  </div>
                  {item.conditions.map((c) =>
                    conditionRow(
                      c,
                      (patch) =>
                        updateItem(item.key, (i) =>
                          i.kind === "group"
                            ? {
                                ...i,
                                conditions: i.conditions.map((x) =>
                                  x.key === c.key ? { ...x, ...patch } : x,
                                ),
                              }
                            : i,
                        ),
                      () =>
                        updateItem(item.key, (i) =>
                          i.kind === "group"
                            ? { ...i, conditions: i.conditions.filter((x) => x.key !== c.key) }
                            : i,
                        ),
                    ),
                  )}
                  <div>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      icon="Plus"
                      onClick={() =>
                        updateItem(item.key, (i) =>
                          i.kind === "group"
                            ? { ...i, conditions: [...i.conditions, newCondition()] }
                            : i,
                        )
                      }
                    >
                      {t("editor.addCondition")}
                    </Button>
                  </div>
                </fieldset>
              ),
            )}
            <div className="flex flex-wrap gap-8">
              <Button
                type="button"
                size="sm"
                variant="secondary"
                icon="Plus"
                onClick={() =>
                  setItems((list) => [
                    ...list,
                    { kind: "condition", key: nextKey(), condition: newCondition() },
                  ])
                }
              >
                {t("editor.addCondition")}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                icon="Plus"
                onClick={() =>
                  setItems((list) => [
                    ...list,
                    { kind: "group", key: nextKey(), match: "any", conditions: [newCondition()] },
                  ])
                }
              >
                {t("editor.addGroup")}
              </Button>
            </div>
          </fieldset>

          <fieldset className="m-0 flex flex-col gap-12 border-0 p-0">
            <legend className="mb-8 text-text-14 font-semibold">{t("editor.actions")}</legend>
            {actions.map((a, index) => (
              <fieldset
                key={a.key}
                className="m-0 flex flex-col gap-8 rounded-8 border border-border-subtle p-12"
              >
                <legend className="px-4 text-text-13 font-medium">
                  {t("editor.action", { number: index + 1 })}
                </legend>
                <div className="flex flex-wrap items-end gap-8">
                  <Select
                    label={t("editor.actionType")}
                    value={a.type}
                    options={AUTOMATION_ACTION_TYPES.map((type) => ({
                      value: type,
                      label: t(`editor.actionTypes.${type}`),
                    }))}
                    onChange={(e) =>
                      updateAction(a.key, { type: e.currentTarget.value as AutomationActionType })
                    }
                  />
                  <IconButton
                    icon="ArrowUp"
                    label={t("editor.moveUp")}
                    disabled={index === 0}
                    onClick={() => moveAction(index, -1)}
                  />
                  <IconButton
                    icon="ArrowDown"
                    label={t("editor.moveDown")}
                    disabled={index === actions.length - 1}
                    onClick={() => moveAction(index, 1)}
                  />
                  <IconButton
                    icon="Trash2"
                    label={t("editor.removeAction")}
                    disabled={actions.length === 1}
                    onClick={() => setActions((list) => list.filter((x) => x.key !== a.key))}
                  />
                </div>
                <div key={a.type} className="flex flex-col gap-8">
                  {actionFields(a)}
                </div>
              </fieldset>
            ))}
            <div>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                icon="Plus"
                disabled={actions.length >= 10}
                onClick={() => setActions((list) => [...list, newAction()])}
              >
                {t("editor.addAction")}
              </Button>
            </div>
          </fieldset>

          <Switch
            label={t("editor.enabled")}
            checked={enabled}
            onChange={(e) => setEnabled(e.currentTarget.checked)}
          />
          <p className="-mt-12 m-0 text-text-12 text-text-secondary">{t("editor.enabledHelp")}</p>

          <section
            aria-labelledby={`${formId}-test`}
            className="flex flex-col gap-8 rounded-8 border border-border-subtle p-12"
          >
            <h3 id={`${formId}-test`} className="m-0 text-text-14 font-semibold">
              {t("editor.test.title")}
            </h3>
            <p className="m-0 text-text-12 text-text-secondary">{t("editor.test.help")}</p>
            <Textarea
              label={t("editor.test.event")}
              value={sample}
              rows={6}
              width="100%"
              spellCheck={false}
              className="font-mono text-text-12"
              onChange={(e) => setSample(e.currentTarget.value)}
            />
            <div className="flex flex-wrap gap-8">
              <Button
                type="button"
                size="sm"
                variant="secondary"
                loading={loadingSample}
                onClick={() =>
                  startSample(async () => {
                    const event = await sampleEventAction(org, trigger);
                    setSample(JSON.stringify(event ?? {}, null, 2));
                  })
                }
              >
                {t("editor.test.loadLatest")}
              </Button>
              <Button type="button" size="sm" variant="primary" icon="Play" onClick={test}>
                {t("editor.test.run")}
              </Button>
            </div>
            {testError ? <InlineAlert tone="danger">{testError}</InlineAlert> : null}
            {testOutcome ? (
              <div role="status" className="flex flex-col gap-8">
                <InlineAlert tone={testOutcome.matched ? "success" : "warning"}>
                  {testOutcome.matched ? t("editor.test.matched") : t("editor.test.notMatched")}
                </InlineAlert>
                <ul className="m-0 flex list-none flex-col gap-4 p-0 text-text-12">
                  {testOutcome.conditions.map((c, i) => (
                    <li key={`${c.field}-${i}`}>
                      <code>{c.field}</code> {t(`editor.operators.${c.operator}`)} {c.value ?? ""}:{" "}
                      {c.matched ? t("editor.test.held") : t("editor.test.failed")} ·{" "}
                      {c.actual === null
                        ? t("editor.test.missing")
                        : t("editor.test.found", { value: JSON.stringify(c.actual) })}
                    </li>
                  ))}
                </ul>
                <h4 className="m-0 text-text-13 font-medium">{t("editor.test.preview")}</h4>
                <ul className="m-0 flex list-none flex-col gap-4 p-0 text-text-12">
                  {actions.map((a, i) => (
                    <li key={a.key}>
                      {t("editor.action", { number: i + 1 })}: {t(`editor.actionTypes.${a.type}`)}
                      {a.title ? <> · {renderTemplate(a.title, sampleEvent ?? {})}</> : null}
                      {a.body ? <> · {renderTemplate(a.body, sampleEvent ?? {})}</> : null}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </section>
        </form>
      )}
    </Drawer>
  );
}

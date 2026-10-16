"use client";

import {
  Board,
  Button,
  DataTable,
  Dialog,
  Drawer,
  IconButton,
  InlineAlert,
  Input,
  PropertyList,
  RecordList,
  RecordRow,
  RefusalNotice,
  Select,
  StateChip,
  Textarea,
  type DataTableColumn,
  type RecordState,
} from "@xos/ui";
import type { Route } from "next";
import { useTranslations } from "next-intl";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Dialog as RDialog } from "radix-ui";
import { useActionState, useEffect, useMemo, useState, useTransition, type ReactNode } from "react";
import { transitionAction, type ActionState } from "@/app/[org]/finance/actions";
import { CollectionViews } from "@/components/views/collection-views";

import { keepInputOnSubmit } from "@/components/collection-kit/keep-input";
/**
 * Client building blocks the Finance and Reports pages share (A15): the view switcher and filter bar
 * that keep view state in the query string (Section 4.5.3), the table, list and board views, the
 * record peek (Section 11.2 rule 4), the create and edit sheet, lifecycle transition buttons, and
 * the feedback that turns database refusals into catalog copy naming their rule (Sections 8.1, 8.2).
 */

export type Translate = ((key: string, values?: Record<string, string | number>) => string) & {
  has: (key: string) => boolean;
};

/** A translator for one of A15's namespaces, with `has` for keys computed at runtime. */
export function useNamespaceT(namespace: "finance" | "reports"): Translate {
  const t = useTranslations(namespace);
  return useMemo(() => {
    const call = t as unknown as (k: string, v?: Record<string, string | number>) => string;
    const has = (t as unknown as { has: (k: string) => boolean }).has;
    return Object.assign(
      (key: string, values?: Record<string, string | number>) => call(key, values),
      { has: (key: string) => has(key) },
    );
  }, [t]);
}

export function useFinanceT(): Translate {
  return useNamespaceT("finance");
}

/** Returns a function that navigates to the current page with some query values changed. */
export function useQueryNav() {
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  return (changes: Readonly<Record<string, string | null>>, replace = false) => {
    const next = new URLSearchParams(search.toString());
    for (const [k, v] of Object.entries(changes)) {
      if (v === null) next.delete(k);
      else next.set(k, v);
    }
    const s = next.toString();
    const href = (s ? `${pathname}?${s}` : pathname) as Route;
    if (replace) router.replace(href, { scroll: false });
    else router.push(href, { scroll: false });
  };
}

// View switcher and filters ------------------------------------------------------------------------

export function ViewSwitcher({ views, value }: { views: readonly string[]; value: string }) {
  const t = useFinanceT();
  const go = useQueryNav();
  if (views.length < 2) return null;
  return (
    <CollectionViews
      label={t("common.viewLabel")}
      value={value}
      options={views.map((v) => ({ value: v, label: t(`views.${v}`) }))}
      onChange={(v) => go({ view: v }, true)}
    />
  );
}

export interface Option {
  readonly value: string;
  readonly label: string;
}

/**
 * Project, state and text filters. Each change rewrites the query string, so the filters survive a
 * view switch and a reload (Section 11.15).
 */
export function FilterBar({
  projects,
  project,
  states,
  state,
  q,
  showSearch = true,
}: {
  projects?: readonly Option[] | undefined;
  project?: string | null;
  states?: readonly Option[] | undefined;
  state?: string | null;
  q?: string | null;
  showSearch?: boolean;
}) {
  const t = useFinanceT();
  const go = useQueryNav();
  const [text, setText] = useState(q ?? "");
  return (
    <form
      role="search"
      aria-label={t("common.filters")}
      className="flex flex-wrap items-end gap-12"
      onSubmit={(e) => {
        e.preventDefault();
        go({ q: text.trim() === "" ? null : text.trim(), peek: null }, true);
      }}
    >
      {projects ? (
        <Select
          key={`project-${project ?? ""}`}
          id="filter-project"
          label={t("common.project")}
          value={project ?? ""}
          options={[{ value: "", label: t("common.allProjects") }, ...projects]}
          onChange={(e) => go({ project: e.target.value || null, peek: null }, true)}
        />
      ) : null}
      {states ? (
        <Select
          key={`state-${state ?? ""}`}
          id="filter-state"
          label={t("common.state")}
          value={state ?? ""}
          options={[{ value: "", label: t("common.allStates") }, ...states]}
          onChange={(e) => go({ state: e.target.value || null, peek: null }, true)}
        />
      ) : null}
      {showSearch ? (
        <Input
          id="filter-search"
          type="search"
          label={t("common.search")}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={() => go({ q: text.trim() === "" ? null : text.trim(), peek: null }, true)}
        />
      ) : null}
    </form>
  );
}

// Views ----------------------------------------------------------------------------------------------

export type Row = Record<string, unknown> & { readonly id: string };

/** The table view: Enter or a double click on a row opens its peek. */
export function CollectionTable({
  label,
  columns,
  rows,
  totals,
}: {
  label: string;
  columns: DataTableColumn[];
  rows: readonly Row[];
  totals?: Record<string, unknown>;
}) {
  const go = useQueryNav();
  const t = useFinanceT();
  return (
    <div className="flex flex-col gap-6">
      <DataTable
        caption={label}
        label={label}
        columns={columns}
        rows={[...rows]}
        {...(totals ? { totals, totalsLabel: t("common.total") } : {})}
        onRowActivate={(row) => go({ peek: String(row["id"]) })}
      />
      <p className="m-0 text-text-11 text-text-secondary">{t("common.tableHint")}</p>
    </div>
  );
}

export interface ListItem {
  readonly id: string;
  readonly recordKey: string;
  readonly title: string;
  readonly state: RecordState;
  readonly stateLabel: string;
  readonly next?: string;
  readonly owner?: string;
}

/** The list view: rows answer what now, and Enter or a click opens the peek (Section 11.10 rule 4). */
export function CollectionList({ label, items }: { label: string; items: readonly ListItem[] }) {
  const go = useQueryNav();
  const t = useFinanceT();
  return (
    <RecordList label={label}>
      {items.map((item) => (
        <RecordRow
          key={item.id}
          recordKey={item.recordKey}
          title={item.title}
          state={item.state}
          stateLabel={item.stateLabel}
          {...(item.next ? { next: item.next } : {})}
          {...(item.owner ? { owner: item.owner } : {})}
          actionLabel={t("common.open")}
          onAction={() => go({ peek: item.id })}
          onOpen={() => go({ peek: item.id })}
        />
      ))}
    </RecordList>
  );
}

export interface BoardColumn {
  readonly state: RecordState;
  readonly label: string;
  readonly cards: readonly { key: string; title: string; meta?: string }[];
}

/**
 * The board view by state. Cards open their peek; moving between states happens through the
 * lifecycle actions, which carry the reason and the spend checks a drag cannot.
 */
export function CollectionBoard({ columns }: { columns: readonly BoardColumn[] }) {
  const go = useQueryNav();
  return (
    <Board
      readOnly
      columns={columns.map((c) => ({ ...c, cards: [...c.cards] }))}
      onOpen={(key) => go({ peek: key })}
    />
  );
}

// Peek -----------------------------------------------------------------------------------------------

/**
 * The record peek beside the list: non-modal, Esc closes, and the full page opens the same anatomy
 * at `&full=1` (broadcast 1, item 4). The kind label is catalog copy because finance documents are
 * not one of the 26 record kinds.
 */
export function RecordPeek({
  kindLabel,
  recordKey,
  title,
  state,
  stateLabel,
  properties,
  children,
}: {
  kindLabel: string;
  recordKey: string;
  title: string;
  state: RecordState;
  stateLabel: string;
  properties: { label: string; value: ReactNode }[];
  children?: ReactNode;
}) {
  const t = useFinanceT();
  const go = useQueryNav();
  return (
    <RDialog.Root
      open
      onOpenChange={(open) => (open ? null : go({ peek: null, full: null }))}
      modal={false}
    >
      <RDialog.Portal>
        <RDialog.Content
          aria-describedby={undefined}
          onInteractOutside={(e) => e.preventDefault()}
          className="xos-anim-peek fixed inset-y-0 end-0 z-peek flex w-(--layout-peek) max-w-full flex-col overflow-y-auto border-s border-border-subtle bg-bg-raised text-text-primary shadow-dialog max-md:w-full forced-colors:border print:hidden"
        >
          <header className="flex items-center justify-between border-b border-border-subtle py-8 ps-20 pe-12">
            <span className="flex items-center gap-6 text-text-secondary">
              <span>{kindLabel}</span>
              <span className="font-mono text-text-12">{recordKey}</span>
            </span>
            <span className="flex items-center gap-2">
              <IconButton
                icon="Maximize2"
                label={t("common.openFull")}
                onClick={() => go({ full: "1" })}
              />
              <RDialog.Close asChild>
                <IconButton icon="X" label={t("common.close")} shortcut="Esc" />
              </RDialog.Close>
            </span>
          </header>
          <div className="flex flex-col gap-16 p-20">
            <RDialog.Title className="m-0 text-heading-20 font-semibold">{title}</RDialog.Title>
            <div className="flex flex-wrap items-center gap-8">
              <StateChip state={state} label={stateLabel} />
            </div>
            <PropertyList items={properties} />
            {children}
          </div>
        </RDialog.Content>
      </RDialog.Portal>
    </RDialog.Root>
  );
}

/** The full page header's way back to the list, keeping filters. */
export function BackToList() {
  const t = useFinanceT();
  const go = useQueryNav();
  return (
    <Button variant="ghost" icon="ArrowLeft" onClick={() => go({ peek: null, full: null })}>
      {t("common.back")}
    </Button>
  );
}

// Create and edit sheet ------------------------------------------------------------------------------

/** A sheet opened by `?create=1` or `?edit=1` (ADR 0017 item 4); closing clears the flag. */
export function FormSheet({
  title,
  flag,
  children,
}: {
  title: string;
  flag: string;
  children: ReactNode;
}) {
  const go = useQueryNav();
  return (
    <Drawer
      title={title}
      open
      onOpenChange={(open) => {
        if (!open) go({ [flag]: null }, true);
      }}
    >
      {children}
    </Drawer>
  );
}

/** Opens the create sheet: the page's one primary action (Section 11.10). */
export function CreateButton({ label }: { label: string }) {
  const go = useQueryNav();
  return (
    <Button variant="primary" icon="Plus" shortcut="C" onClick={() => go({ create: "1" })}>
      {label}
    </Button>
  );
}

export function EditButton({ label }: { label: string }) {
  const go = useQueryNav();
  return (
    <Button icon="Pencil" onClick={() => go({ edit: "1" })}>
      {label}
    </Button>
  );
}

/** Closes the sheet and opens the new record's peek after a successful create. */
export function useAfterSave(state: ActionState, flag: string) {
  const go = useQueryNav();
  useEffect(() => {
    if (state.ok) go({ [flag]: null, ...(state.id ? { peek: state.id } : {}) }, true);
    // Runs once per completed submit; `at` changes on every submit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.at]);
}

// Feedback -------------------------------------------------------------------------------------------

/**
 * Turns an action result into copy: a refusal names its rule from `finance.refusals` (falling back to
 * the rule code itself when the catalog has no sentence for it), a pending approval says a second
 * approver is needed, and other failures say what to do next.
 */
export function ActionFeedback({ state, success }: { state: ActionState; success?: string }) {
  const t = useFinanceT();
  if (state.error) {
    const error = state.error;
    if (error.kind === "refusal") {
      const key = `refusals.${error.rule}`;
      return (
        <RefusalNotice
          outcome="REFUSE"
          title={t("common.refusedTitle")}
          reason={t.has(key) ? t(key) : t("refusals.unknown", { rule: error.rule })}
        />
      );
    }
    if (error.kind === "input") return null;
    return <InlineAlert tone="danger">{t(`errors.${error.kind}`)}</InlineAlert>;
  }
  if (state.pending) {
    return (
      <p role="status" className="m-0 text-text-13 text-warning-text">
        {t("common.approvalPending")}
      </p>
    );
  }
  if (state.ok && success) {
    return (
      <p role="status" className="m-0 text-text-13 text-success-text">
        {success}
      </p>
    );
  }
  return null;
}

/** The catalog message for a field error, or the empty string. */
export function fieldError(t: Translate, state: ActionState, field: string): string {
  const key = state.fieldErrors?.[field];
  return key ? t(`errors.fields.${key}`) : "";
}

// Lifecycle transitions ---------------------------------------------------------------------------------

export type Lifecycle =
  | "expense"
  | "change_order"
  | "invoice"
  | "payment"
  | "journal"
  | "accounting_period"
  | "settlement";

/**
 * One lifecycle move: asks for the reason every transition ledger records, then calls the RPC. The
 * button label comes from `finance.transitions.<lifecycle>.<next>`.
 */
export function TransitionButton({
  org,
  lifecycle,
  id,
  expected,
  next,
  variant = "secondary",
}: {
  org: string;
  lifecycle: Lifecycle;
  id: string;
  expected: string;
  next: string;
  variant?: "primary" | "secondary" | "danger" | "ghost";
}) {
  const t = useFinanceT();
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useActionState(transitionAction, {});
  const nextKey = next.replace(/\s+/g, "");
  const label = t(`transitions.${lifecycle}.${nextKey}`);
  // Close once per completed submit; `at` changes on every submit (state from the previous render).
  const [seenAt, setSeenAt] = useState(state.at);
  if (state.at !== seenAt) {
    setSeenAt(state.at);
    if (state.ok) setOpen(false);
  }
  return (
    <>
      <Button variant={variant} onClick={() => setOpen(true)}>
        {label}
      </Button>
      {open ? (
        <Dialog
          open
          onOpenChange={setOpen}
          title={label}
          description={t("common.reasonHelp")}
          actions={
            <>
              <Button onClick={() => setOpen(false)}>{t("common.cancel")}</Button>
              <Button
                type="submit"
                form={`transition-${id}-${nextKey}`}
                variant={variant === "danger" ? "danger" : "primary"}
                loading={pending}
              >
                {label}
              </Button>
            </>
          }
        >
          <form
            id={`transition-${id}-${nextKey}`}
            action={action}
            onSubmit={keepInputOnSubmit(action)}
            className="flex flex-col gap-12"
          >
            <input type="hidden" name="org" value={org} />
            <input type="hidden" name="lifecycle" value={lifecycle} />
            <input type="hidden" name="id" value={id} />
            <input type="hidden" name="expected" value={expected} />
            <input type="hidden" name="next" value={next} />
            <Textarea
              id={`transition-reason-${id}-${nextKey}`}
              name="reason"
              required
              width="100%"
              label={t("common.reason")}
              defaultValue={
                t.has(`transitions.${lifecycle}.reason.${nextKey}`)
                  ? t(`transitions.${lifecycle}.reason.${nextKey}`)
                  : ""
              }
              error={state.fieldErrors?.["reason"] ? t("errors.fields.reason") : ""}
            />
            <ActionFeedback state={state} />
          </form>
        </Dialog>
      ) : null}
      {!open && state.pending ? <ActionFeedback state={state} /> : null}
    </>
  );
}

/** The transitions a state allows, as buttons; approvals lead as the primary action. */
export function TransitionBar({
  org,
  lifecycle,
  id,
  state,
  allowed,
}: {
  org: string;
  lifecycle: Lifecycle;
  id: string;
  state: string;
  allowed: readonly string[];
}) {
  const t = useFinanceT();
  if (allowed.length === 0) return null;
  const tone = (next: string) =>
    ["Approved", "Posted", "Priced", "Issued", "Closed"].includes(next)
      ? "primary"
      : ["Rejected", "Canceled", "Disputed"].includes(next)
        ? "danger"
        : "secondary";
  return (
    <div role="group" aria-label={t("common.actions")} className="flex flex-wrap gap-8">
      {allowed.map((next) => (
        <TransitionButton
          key={next}
          org={org}
          lifecycle={lifecycle}
          id={id}
          expected={state}
          next={next}
          variant={tone(next)}
        />
      ))}
    </div>
  );
}

/** Submits a server action with no fields beyond those given, for small inline actions. */
export function InlineActionButton({
  action,
  fields,
  label,
  variant = "ghost",
  icon,
}: {
  action: (state: ActionState, form: FormData) => Promise<ActionState>;
  fields: Readonly<Record<string, string>>;
  label: string;
  variant?: "primary" | "secondary" | "danger" | "ghost";
  icon?: "Trash2" | "X" | "Undo2";
}) {
  const [state, run, pending] = useActionState(action, {});
  const [, start] = useTransition();
  return (
    <span className="inline-flex flex-col gap-4">
      <Button
        variant={variant}
        size="sm"
        loading={pending}
        {...(icon ? { icon } : {})}
        onClick={() => {
          const form = new FormData();
          for (const [k, v] of Object.entries(fields)) form.set(k, v);
          start(() => run(form));
        }}
      >
        {label}
      </Button>
      <ActionFeedback state={state} />
    </span>
  );
}

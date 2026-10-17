"use client";

import type { CodeLabel, ScopeNode } from "@xos/data/projects";
import {
  Button,
  CoordinateMatrix,
  DataTable,
  Dialog,
  InlineAlert,
  Input,
  PropertyList,
  Select,
  TreeView,
  type DepartmentCode,
  type PhaseCode,
  type TreeNode,
} from "@xos/ui";
import type { Route } from "next";
import { useTranslations } from "next-intl";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import {
  createScopeNodeAction,
  removeScopeNodeAction,
  updateScopeNodeAction,
} from "@/lib/projects/actions";
import { enumKey, phaseCode } from "@/lib/projects/format";
import { ActionError, echoed, fieldError, useClosingAction } from "./action-error";
import { CollectionViews } from "@/components/views/collection-views";

import { keepInputOnSubmit } from "@/components/collection-kit/keep-input";
type ScopeViewType = "tree" | "list" | "matrix";

interface Base {
  readonly org: string;
  readonly projectKey: string;
}

/**
 * The Scope tab (Section 4.5.4): the project's scope tree (engagement root, standing venues and
 * shows) as a tree, a list and the coordinate matrix of its records. Selecting a node offers adding
 * beneath it, renaming and removal; the database keeps codes, parents and kinds immutable and
 * refuses removing the root or a node with children.
 */
export function ScopeView({
  org,
  projectKey,
  nodes,
  venues,
  canWrite,
  views,
  view,
  departments,
  phases,
  cells,
}: Base & {
  nodes: readonly ScopeNode[];
  venues: readonly { readonly value: string; readonly label: string }[];
  canWrite: boolean;
  views: readonly ScopeViewType[];
  view: ScopeViewType;
  departments: readonly CodeLabel[];
  phases: readonly { readonly code: string; readonly gate: number }[];
  cells: Readonly<Record<string, number>>;
}) {
  const t = useTranslations("projects");
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const scopeFilter = params.get("scope");
  const initial =
    nodes.find((n) => n.code === scopeFilter)?.id ?? nodes.find((n) => n.parentId === null)?.id;
  const [selectedId, setSelectedId] = useState<string | undefined>(initial);
  const selected = nodes.find((n) => n.id === selectedId);
  const kind = (k: string) => t(`scopeKinds.${enumKey(k)}` as "scopeKinds.show");
  const children = (id: string) => nodes.filter((n) => n.parentId === id);

  const toTree = (n: ScopeNode): TreeNode => ({
    id: n.id,
    label: `${n.name}`,
    meta: n.code,
    icon:
      n.kind === "Engagement Root"
        ? "Briefcase"
        : n.kind === "Standing Venue"
          ? "Building2"
          : "Ticket",
    expanded: true,
    selected: n.id === selectedId,
    children: children(n.id).map(toTree),
  });

  const setView = (v: string) => {
    const q = new URLSearchParams(params.toString());
    q.set("view", v);
    router.replace(`${pathname}?${q.toString()}` as Route);
  };

  return (
    <div className="flex flex-col gap-16">
      {views.length > 1 ? (
        <CollectionViews
          label={t("views.label")}
          value={view}
          options={views.map((v) => ({ value: v, label: t(`views.${v}`) }))}
          onChange={setView}
        />
      ) : null}
      {!canWrite ? <InlineAlert tone="info">{t("scope.readOnly")}</InlineAlert> : null}

      {view === "matrix" ? (
        <div className="flex flex-col gap-8">
          <CoordinateMatrix
            label={t("scope.matrixLabel", { key: projectKey })}
            corner={t("scope.matrixCorner")}
            rows={departments.map((d) => ({ code: d.code as DepartmentCode, name: d.label }))}
            cols={phases.map((p) => ({
              gate: p.gate,
              code: phaseCode(p.code) as PhaseCode,
              name: t(`phases.${phaseCode(p.code)}`),
            }))}
            cells={{ ...cells }}
          />
          <p className="m-0 text-text-12 text-text-secondary">{t("scope.matrixNote")}</p>
        </div>
      ) : view === "list" ? (
        <DataTable
          caption={t("scope.treeLabel", { key: projectKey })}
          columns={[
            { key: "code", label: t("scope.columns.code"), type: "code", width: 120 },
            { key: "name", label: t("scope.columns.name"), wrap: true },
            { key: "kind", label: t("scope.columns.kind"), width: 160 },
            { key: "parent", label: t("scope.columns.parent"), type: "code", width: 120 },
            { key: "venue", label: t("scope.columns.venue"), width: 180 },
          ]}
          rows={nodes.map((n) => ({
            id: n.id,
            code: n.code,
            name: n.name,
            kind: kind(n.kind),
            parent: nodes.find((p) => p.id === n.parentId)?.code ?? "",
            venue: n.venueName ?? t("scope.noVenue"),
          }))}
          onRowActivate={(row) => {
            setSelectedId(String(row["id"]));
            setView("tree");
          }}
        />
      ) : (
        <div className="grid grid-cols-1 gap-24 lg:grid-cols-[minmax(0,1fr)_var(--layout-property-column)]">
          <TreeView
            label={t("scope.treeLabel", { key: projectKey })}
            nodes={nodes.filter((n) => n.parentId === null).map(toTree)}
            onSelect={(node) => setSelectedId(node.id)}
          />
          <aside aria-label={t("scope.selected")} className="flex flex-col gap-12">
            {selected ? (
              <>
                <h2 className="m-0 text-heading-16 font-semibold">{selected.name}</h2>
                <PropertyList
                  items={[
                    {
                      label: t("scope.code"),
                      value: <span className="font-mono">{selected.code}</span>,
                    },
                    { label: t("scope.kind"), value: kind(selected.kind) },
                    { label: t("scope.venue"), value: selected.venueName ?? t("scope.noVenue") },
                  ]}
                />
                {children(selected.id).length === 0 && selected.kind !== "Show" ? (
                  <p className="m-0 text-text-13 text-text-secondary">{t("scope.emptyChildren")}</p>
                ) : null}
                {canWrite ? (
                  <div className="flex flex-wrap gap-8">
                    {selected.kind !== "Show" ? (
                      <AddNodeDialog
                        org={org}
                        projectKey={projectKey}
                        parent={selected}
                        venues={venues}
                        allowVenue={selected.kind === "Engagement Root"}
                      />
                    ) : null}
                    <RenameNodeDialog
                      org={org}
                      projectKey={projectKey}
                      node={selected}
                      venues={venues}
                    />
                    {selected.parentId !== null ? (
                      <RemoveNodeDialog org={org} projectKey={projectKey} node={selected} />
                    ) : null}
                  </div>
                ) : null}
              </>
            ) : (
              <p className="m-0 text-text-13 text-text-secondary">{t("scope.selectHint")}</p>
            )}
          </aside>
        </div>
      )}
    </div>
  );
}

function Hidden({ org, projectKey }: Base) {
  return (
    <>
      <input type="hidden" name="org" value={org} />
      <input type="hidden" name="projectKey" value={projectKey} />
    </>
  );
}

function AddNodeDialog({
  org,
  projectKey,
  parent,
  venues,
  allowVenue,
}: Base & {
  parent: ScopeNode;
  venues: readonly { readonly value: string; readonly label: string }[];
  allowVenue: boolean;
}) {
  const t = useTranslations("projects");
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useClosingAction(createScopeNodeAction, () => setOpen(false));
  const kinds = allowVenue ? ["Standing Venue", "Show"] : ["Show"];
  const example = `${projectKey}-S01`;
  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      trigger={
        <Button size="sm" variant="primary" icon="Plus">
          {t("scope.add")}
        </Button>
      }
      title={t("scope.addUnder", { name: parent.name })}
      actions={
        <>
          <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
            {t("scope.cancel")}
          </Button>
          <Button type="submit" form="add-scope-node" variant="primary" loading={pending}>
            {t("scope.addSubmit")}
          </Button>
        </>
      }
    >
      <form
        id="add-scope-node"
        action={action}
        onSubmit={keepInputOnSubmit(action)}
        className="flex flex-col gap-12"
        noValidate
      >
        <Hidden org={org} projectKey={projectKey} />
        <input type="hidden" name="parentId" value={parent.id} />
        <ActionError state={state} />
        <Select
          id="scope-kind"
          name="kind"
          label={t("scope.kind")}
          help={t("scope.kindHelp")}
          value={echoed(state, "kind", kinds[0])}
          options={kinds.map((k) => ({
            value: k,
            label: t(`scopeKinds.${enumKey(k)}` as "scopeKinds.show"),
          }))}
        />
        <Input
          id="scope-code"
          name="code"
          required
          maxLength={32}
          width={200}
          autoComplete="off"
          label={t("scope.code")}
          help={t("scope.codeHelp", { example })}
          defaultValue={echoed(state, "code")}
          error={fieldError(t, state, "code")}
        />
        <Input
          id="scope-name"
          name="name"
          required
          maxLength={200}
          width="100%"
          label={t("scope.name")}
          defaultValue={echoed(state, "name")}
          error={fieldError(t, state, "name")}
        />
        <VenueSelect id="scope-venue" venues={venues} value={echoed(state, "venueId")} />
      </form>
    </Dialog>
  );
}

function VenueSelect({
  id,
  venues,
  value,
}: {
  id: string;
  venues: readonly { readonly value: string; readonly label: string }[];
  value: string;
}) {
  const t = useTranslations("projects");
  if (venues.length === 0) return <input type="hidden" name="venueId" value="" />;
  return (
    <Select
      id={id}
      name="venueId"
      label={t("scope.venue")}
      value={value}
      options={[{ value: "", label: t("scope.noVenue") }, ...venues]}
    />
  );
}

function RenameNodeDialog({
  org,
  projectKey,
  node,
  venues,
}: Base & {
  node: ScopeNode;
  venues: readonly { readonly value: string; readonly label: string }[];
}) {
  const t = useTranslations("projects");
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useClosingAction(updateScopeNodeAction, () => setOpen(false));
  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      trigger={
        <Button size="sm" variant="secondary">
          {t("scope.rename")}
        </Button>
      }
      title={t("scope.renameTitle", { code: node.code })}
      actions={
        <>
          <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
            {t("scope.cancel")}
          </Button>
          <Button type="submit" form="rename-scope-node" variant="primary" loading={pending}>
            {t("scope.renameSubmit")}
          </Button>
        </>
      }
    >
      <form
        id="rename-scope-node"
        action={action}
        onSubmit={keepInputOnSubmit(action)}
        className="flex flex-col gap-12"
        noValidate
      >
        <Hidden org={org} projectKey={projectKey} />
        <input type="hidden" name="nodeId" value={node.id} />
        <ActionError state={state} />
        <Input
          id="rename-scope-name"
          name="name"
          required
          maxLength={200}
          width="100%"
          label={t("scope.name")}
          defaultValue={echoed(state, "name", node.name)}
          error={fieldError(t, state, "name")}
        />
        <VenueSelect
          id="rename-scope-venue"
          venues={venues}
          value={echoed(state, "venueId", node.venueId ?? "")}
        />
      </form>
    </Dialog>
  );
}

function RemoveNodeDialog({ org, projectKey, node }: Base & { node: ScopeNode }) {
  const t = useTranslations("projects");
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useClosingAction(removeScopeNodeAction, () => setOpen(false));
  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      trigger={
        <Button size="sm" variant="ghost">
          {t("scope.remove")}
        </Button>
      }
      title={t("scope.removeAction")}
      description={t("scope.removeConfirm", { name: node.name, code: node.code })}
      actions={
        <>
          <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
            {t("scope.cancel")}
          </Button>
          <Button type="submit" form="remove-scope-node" variant="danger" loading={pending}>
            {t("scope.removeAction")}
          </Button>
        </>
      }
    >
      <form id="remove-scope-node" action={action} onSubmit={keepInputOnSubmit(action)}>
        <Hidden org={org} projectKey={projectKey} />
        <input type="hidden" name="nodeId" value={node.id} />
        <ActionError state={state} />
      </form>
    </Dialog>
  );
}

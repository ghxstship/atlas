"use client";

import { Button } from "@xos/ui";
import dynamic from "next/dynamic";
import { useTranslations } from "next-intl";
import { useActionState, useState } from "react";
import { createProjectAction } from "@/lib/projects/actions";
import { DeferredDrawer } from "@/components/lazy-ui/deferred";
import { ActionError } from "./action-error";

import type { ProjectFormOptions } from "./project-fields";

export type { ProjectFormOptions, ProjectFormValues } from "./project-fields";

/** The form's fields load when the drawer first opens, not with the Projects page (A24-009). */
const DrawerFields = dynamic(() =>
  import("./create-project-fields").then((m) => m.CreateProjectFields),
);

/**
 * New project, in a drawer whose body scrolls, so every field and the submit button stay reachable
 * at any viewport height. Opened from the primary action or by `?create=1` (ADR 0017 item 4).
 */
export function CreateProjectDialog({
  org,
  options,
  defaultOpen,
}: {
  org: string;
  options: ProjectFormOptions;
  defaultOpen: boolean;
}) {
  const t = useTranslations("projects");
  const [open, setOpen] = useState(defaultOpen);
  const [state, action, pending] = useActionState(createProjectAction, {});
  return (
    <DeferredDrawer
      open={open}
      onOpenChange={setOpen}
      trigger={
        <Button variant="primary" icon="Plus">
          {t("list.newProject")}
        </Button>
      }
      title={t("create.title")}
      footer={
        <>
          <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
            {t("create.cancel")}
          </Button>
          <Button type="submit" form="create-project" variant="primary" loading={pending}>
            {t("create.submit")}
          </Button>
        </>
      }
    >
      <p className="m-0 text-text-13 text-text-secondary">{t("create.description")}</p>
      <form id="create-project" action={action} className="flex flex-col gap-12" noValidate>
        <input type="hidden" name="org" value={org} />
        <ActionError state={state} />
        <DrawerFields idPrefix="create" options={options} state={state} />
      </form>
    </DeferredDrawer>
  );
}

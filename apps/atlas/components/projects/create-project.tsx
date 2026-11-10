"use client";

import { Button } from "@xos/ui";
import dynamic from "next/dynamic";
import { useTranslations } from "next-intl";
import { useActionState, useState } from "react";
import { createProjectFromIntakeAction } from "@/lib/projects/actions";
import { DeferredDrawer } from "@/components/lazy-ui/deferred";

import type { ProjectFormOptions } from "./project-fields";

export type { ProjectFormOptions, ProjectFormValues } from "./project-fields";

/**
 * The staged intake (B14) loads when the drawer first opens, not with the Projects page (A24-009); its own Back, Next
 * and Create buttons come with it.
 */
const Wizard = dynamic(() => import("./create-project-wizard").then((m) => m.CreateProjectWizard));

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
  const [state, action, pending] = useActionState(createProjectFromIntakeAction, {});
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
    >
      <Wizard
        org={org}
        options={options}
        state={state}
        action={action}
        pending={pending}
        onCancel={() => setOpen(false)}
      />
    </DeferredDrawer>
  );
}

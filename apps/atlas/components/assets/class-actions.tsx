"use client";

import { Input } from "@xos/ui";
import type { Route } from "next";
import { useRouter } from "next/navigation";
import { archiveClassAction, renameClassAction } from "@/app/[org]/assets/actions";
import { useAssetsCopy } from "./copy";
import { ActionButton } from "./dialog";

/** Rename and archive an asset class. Archiving is offered only for a class with no units or lots. */
export function ClassActions({
  org,
  classId,
  name,
  empty,
}: {
  org: string;
  classId: string;
  name: string;
  empty: boolean;
}) {
  const t = useAssetsCopy();
  const router = useRouter();
  return (
    <div className="flex flex-wrap gap-8">
      <ActionButton
        label={t("classes.rename.open")}
        icon="Pencil"
        title={t("classes.rename.title", { name })}
        submitLabel={t("common.save")}
        action={renameClassAction}
        org={org}
        hidden={{ classId }}
      >
        <Input
          id="class-rename"
          name="name"
          required
          width="100%"
          defaultValue={name}
          label={t("fields.name")}
        />
      </ActionButton>
      {empty ? (
        <ActionButton
          label={t("classes.archive.open")}
          icon="Archive"
          variant="ghost"
          title={t("classes.archive.title", { name })}
          description={t("classes.archive.description")}
          submitLabel={t("classes.archive.submit")}
          action={archiveClassAction}
          org={org}
          hidden={{ classId }}
          danger
          onSuccess={() => router.replace(`/${org}/assets/asset-classes` as Route)}
        />
      ) : null}
    </div>
  );
}

import type { ReactElement } from "react";
import { Icon } from "../Icon/Icon.tsx";
import { Button } from "../Button/Button.tsx";
import { type TemplateSystemProps } from "./Templates.types.ts";

/** 404, 500, maintenance, offline and archived org: a centered message and one primary action. */
export function TemplateSystem({
  icon,
  title,
  sentence,
  actionLabel,
  onAction,
  reference,
}: TemplateSystemProps): ReactElement {
  return (
    <div
      data-template="system"
      className="flex flex-col items-center gap-12 py-48 px-16 text-center"
    >
      <span className="text-text-secondary">
        <Icon name={icon} size={28} />
      </span>
      <h1 className="m-0 text-heading-20 font-semibold">{title}</h1>
      <p className="m-0 max-w-(--layout-auth) text-text-secondary">{sentence}</p>
      <Button variant="primary" onClick={onAction}>
        {actionLabel}
      </Button>
      {reference ? (
        <span className="font-mono text-text-12 text-text-secondary">{reference}</span>
      ) : null}
    </div>
  );
}

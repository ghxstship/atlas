import type { ReactElement } from "react";
import { Button } from "../Button/Button.tsx";
import { SystemMessage } from "./TemplateSystemLink.tsx";
import { type TemplateSystemProps } from "./Templates.types.ts";

/** 404, 500, maintenance, offline and archived org: a centered message and one primary action. */
export function TemplateSystem({
  actionLabel,
  onAction,
  ...message
}: TemplateSystemProps): ReactElement {
  return (
    <SystemMessage {...message}>
      <Button variant="primary" onClick={onAction}>
        {actionLabel}
      </Button>
    </SystemMessage>
  );
}

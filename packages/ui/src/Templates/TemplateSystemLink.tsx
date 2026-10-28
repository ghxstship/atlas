import type { ReactElement, ReactNode } from "react";
import { Icon } from "../Icon/Icon.tsx";
import { buttonClass } from "../Button/button-class.ts";
import { type TemplateSystemLinkProps } from "./Templates.types.ts";

/** The System template's centered message, around whatever its one action is. */
export function SystemMessage({
  icon,
  title,
  sentence,
  reference,
  children,
}: {
  icon: string;
  title: string;
  sentence: string;
  reference?: string | undefined;
  children: ReactNode;
}): ReactElement {
  return (
    <div className="flex flex-col items-center gap-12 py-48 px-16 text-center">
      <span className="text-text-secondary">
        <Icon name={icon} size={28} />
      </span>
      <h1 className="m-0 text-heading-20 font-semibold">{title}</h1>
      <p className="m-0 max-w-(--layout-auth) text-text-secondary">{sentence}</p>
      {children}
      {reference ? (
        <span className="font-mono text-text-12 text-text-secondary">{reference}</span>
      ) : null}
    </div>
  );
}

/**
 * The System template whose action is a link styled as the primary Button. It uses no hooks or
 * context, so a server component renders it whole: a not-found boundary built on it sends no
 * JavaScript, where TemplateSystem's click handler needs a client module (ADR 0027).
 */
export function TemplateSystemLink({
  href,
  actionLabel,
  ...message
}: TemplateSystemLinkProps): ReactElement {
  return (
    <SystemMessage {...message}>
      <a href={href} className={buttonClass("primary")}>
        {actionLabel}
      </a>
    </SystemMessage>
  );
}

import { type ReactElement } from "react";
import { Icon } from "../Icon/Icon.tsx";
import { linkClass } from "../Link/link-class.ts";
import { marketingCopy } from "./marketing-copy.ts";
import { type AIDisclosureBadgeProps } from "./Marketing.types.ts";

/** Marks a feature as AI, names the provider and links the notice. */
export function AIDisclosureBadge({
  label,
  provider,
  href,
  linkLabel,
  locale,
  messages,
}: AIDisclosureBadgeProps): ReactElement {
  const { t } = marketingCopy({ locale, messages });
  return (
    <span className="xos-mkt-ai">
      <span className="xos-mkt-tag">
        <Icon name="Sparkles" size={12} />
        {label ?? t("mk.ai.badge")}
      </span>
      {provider ? <span className="xos-mkt-ai-provider">{provider}</span> : null}
      {href ? (
        <a href={href} className={linkClass}>
          {linkLabel}
        </a>
      ) : null}
    </span>
  );
}

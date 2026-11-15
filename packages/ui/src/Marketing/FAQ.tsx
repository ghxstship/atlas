import { type ReactElement } from "react";
import { Icon } from "../Icon/Icon.tsx";
import { type FAQProps } from "./Marketing.types.ts";

/**
 * Questions and answers on native disclosure elements, so every answer stays in the document
 * while closed and the list works without script.
 */
export function FAQ({ headingLevel = 3, items }: FAQProps): ReactElement {
  const Heading = `h${headingLevel}` as const;
  return (
    <div className="xos-mkt-faq">
      {items.map((item) => (
        <details key={item.q} {...(item.open ? { open: true } : {})}>
          <summary>
            <Icon name="ChevronRight" size={14} />
            <Heading>{item.q}</Heading>
          </summary>
          <div className="xos-mkt-faq-body">
            {typeof item.a === "string" ? <p>{item.a}</p> : item.a}
          </div>
        </details>
      ))}
    </div>
  );
}

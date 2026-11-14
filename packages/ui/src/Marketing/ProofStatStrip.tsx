import { type CSSProperties, type ReactElement } from "react";
import { formatNumber } from "../lib/format.ts";
import { marketingCopy } from "./marketing-copy.ts";
import { type ProofStatStripProps } from "./Marketing.types.ts";

/** Verifiable figures. Each one links to the file that proves it. */
export function ProofStatStrip({
  label,
  items,
  locale,
  messages,
}: ProofStatStripProps): ReactElement {
  const copy = marketingCopy({ locale, messages });
  return (
    <ul
      className="xos-mkt-proof"
      aria-label={label}
      style={{ "--xos-mkt-n": items.length } as CSSProperties}
    >
      {items.map((item) => (
        <li key={item.label}>
          <strong className="xos-mkt-proof-value tabular-nums">
            {typeof item.value === "number" ? formatNumber(copy.locale, item.value) : item.value}
          </strong>
          <span className="xos-mkt-proof-label">{item.label}</span>
          {item.source ? (
            <a className="xos-mkt-proof-src" href={item.source.href}>
              {copy.t("mk.proof.source", { label: item.source.label })}
            </a>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

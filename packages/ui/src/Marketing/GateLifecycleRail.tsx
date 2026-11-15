import { type ReactElement } from "react";
import { Icon } from "../Icon/Icon.tsx";
import { PhaseGlyph } from "../Glyphs/Glyphs.tsx";
import { marketingCopy } from "./marketing-copy.ts";
import { type GateLifecycleRailProps } from "./Marketing.types.ts";

/** The nine gates in three acts. A gate reads "Gate 3 · Advance": the number never stands alone. */
export function GateLifecycleRail({
  label,
  acts,
  locale,
  messages,
}: GateLifecycleRailProps): ReactElement {
  const { t } = marketingCopy({ locale, messages });
  return (
    <ol className="xos-mkt-rail" aria-label={label}>
      {acts.map((act) => (
        <li key={act.name} className="xos-mkt-act">
          <p className="xos-mkt-act-name">
            <strong>{act.name}</strong>
            {act.range ? <span>{act.range}</span> : null}
          </p>
          <ol className="xos-mkt-gates" start={act.gates[0]?.n}>
            {act.gates.map((gate) => (
              <li key={gate.n} className="xos-mkt-gate">
                <div className="xos-mkt-gate-head">
                  <span className="xos-mkt-tile" aria-hidden="true">
                    <PhaseGlyph code={gate.code} size={16} />
                  </span>
                  <span className="xos-mkt-gate-name">
                    <span>{t("phase.gate", { n: gate.n })}</span>
                    <span className="xos-mkt-sep" aria-hidden="true">
                      ·
                    </span>
                    <strong>{gate.name}</strong>
                  </span>
                </div>
                {gate.summary ? <p>{gate.summary}</p> : null}
                {gate.evidence ? (
                  <p className="xos-mkt-gate-evidence">
                    <Icon name="FileCheck" size={14} />
                    <span>{gate.evidence}</span>
                  </p>
                ) : null}
              </li>
            ))}
          </ol>
        </li>
      ))}
    </ol>
  );
}

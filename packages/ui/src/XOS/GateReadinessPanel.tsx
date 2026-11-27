import { type ReactElement } from "react";
import { useT } from "../lib/context.tsx";
import { Button } from "../Button/Button.tsx";
import { GateReadinessPanelView } from "./GateReadinessPanelView.tsx";
import { type GateReadinessPanelProps } from "./XOS.types.ts";

/**
 * A gate's criteria as a checklist with evidence, blocking flags and the action that clears each
 * gap. The next-gate button enables when the last blocking criterion is met.
 */
export function GateReadinessPanel({
  gate,
  code,
  name,
  nextLabel,
  criteria,
  onAdvance,
  onCriterionAction,
}: GateReadinessPanelProps): ReactElement {
  const t = useT();
  return (
    <GateReadinessPanelView
      gate={gate}
      code={code}
      name={name}
      criteria={criteria}
      t={t}
      criterionAction={(c) => (
        <Button size="sm" onClick={() => onCriterionAction?.(c.code, c.label)}>
          {c.action}
        </Button>
      )}
      advance={(blocked) => (
        <Button
          variant="primary"
          disabled={blocked}
          shortcut="⌘↵"
          onClick={onAdvance}
          className="max-sm:w-full"
        >
          {nextLabel}
        </Button>
      )}
    />
  );
}

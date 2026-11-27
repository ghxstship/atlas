import { type ReactElement } from "react";
import { cx } from "../lib/cx.ts";
import { buttonClass } from "../Button/button-class.ts";
import { Keys } from "../Kbd/Kbd.tsx";
import { GateReadinessPanelView } from "../XOS/GateReadinessPanelView.tsx";
import { marketingCopy } from "./marketing-copy.ts";
import { type StaticGateReadinessPanelProps } from "./Marketing.types.ts";

/**
 * GateReadinessPanel for a server component: the same markup as the product panel, with its strings
 * from the page's `locale` and `messages`. It takes no handlers, so its buttons act on nothing; a
 * public page shows it inside ScreenshotFrame, which makes it inert and names it as one image.
 */
export function StaticGateReadinessPanel({
  gate,
  code,
  name,
  nextLabel,
  criteria,
  locale,
  messages,
}: StaticGateReadinessPanelProps): ReactElement {
  const { t } = marketingCopy({ locale, messages });
  return (
    <GateReadinessPanelView
      gate={gate}
      code={code}
      name={name}
      criteria={criteria}
      t={t}
      criterionAction={(c) => (
        <button type="button" className={buttonClass("secondary", "sm")}>
          {c.action}
        </button>
      )}
      advance={(blocked) => (
        <button
          type="button"
          disabled={blocked}
          className={cx(buttonClass("primary", "md"), "max-sm:w-full")}
        >
          {nextLabel}
          <span className="ms-4 inline-flex pointer-coarse:hidden">
            <Keys keys="⌘↵" />
          </span>
        </button>
      )}
    />
  );
}

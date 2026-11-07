import { type ReactElement, type ReactNode } from "react";
import { useT } from "../lib/context.tsx";
import { Accordion } from "./Accordion.tsx";

export interface MoreFieldsProps {
  /** The fields past the seventh. */
  children: ReactNode;
  /** Opens the section, for example when one of its fields has an error to show. */
  open?: boolean;
  /**
   * The section header's heading level. A form most often sits right under the page title, where a
   * level 3 header skips a level; 2 follows any heading without skipping one.
   */
  headingLevel?: 2 | 3 | 4;
}

/**
 * The More fields section of a long form (Section 11.10, Section 18 gate 27): a form shows at most
 * seven fields and puts the rest here. Collapsed fields stay in the DOM, hidden, so they keep their
 * values and submit with the form.
 */
export function MoreFields({
  children,
  open = false,
  headingLevel = 2,
}: MoreFieldsProps): ReactElement {
  const t = useT();
  return (
    <Accordion
      key={open ? "open" : "closed"}
      keepMounted
      headingLevel={headingLevel}
      items={[
        {
          title: t("form.moreFields"),
          open,
          content: <div className="flex flex-col gap-16 pt-4 text-text-primary">{children}</div>,
        },
      ]}
    />
  );
}

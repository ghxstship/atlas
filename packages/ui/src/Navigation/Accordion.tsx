import { type ReactElement } from "react";
import { Accordion as RAccordion } from "radix-ui";
import { cx } from "../lib/cx.ts";
import { Icon } from "../Icon/Icon.tsx";
import { type AccordionProps } from "./Navigation.types.ts";

/** Progressively discloses sections; each header is a button that Enter or Space toggles. */
export function Accordion({ items }: AccordionProps): ReactElement {
  return (
    <RAccordion.Root
      type="multiple"
      defaultValue={items.filter((it) => it.open).map((it) => it.title)}
      className="rounded-card border border-border-subtle"
    >
      {items.map((it) => (
        <RAccordion.Item
          key={it.title}
          value={it.title}
          className="group border-b border-border-subtle last:border-b-0"
        >
          <RAccordion.Header className="m-0">
            <RAccordion.Trigger
              className={cx(
                "flex items-center gap-6 w-full h-(--ui-accordion-row) px-12 bg-transparent border-0 cursor-pointer",
                "font-medium text-text-13 text-start pointer-coarse:min-h-target-coarse",
              )}
            >
              <Icon
                name="ChevronRight"
                size={14}
                className="text-text-secondary transition-transform duration-fast ease-standard group-data-[state=open]:rotate-90 group-data-[state=open]:rtl:-rotate-90"
              />
              <span>{it.title}</span>
              {it.meta ? (
                <span className="ms-auto text-text-secondary font-regular">{it.meta}</span>
              ) : null}
            </RAccordion.Trigger>
          </RAccordion.Header>
          <RAccordion.Content className="pb-12 ps-(--ui-accordion-indent) pe-12 text-text-secondary">
            {it.content}
          </RAccordion.Content>
        </RAccordion.Item>
      ))}
    </RAccordion.Root>
  );
}

"use client";

import {
  BrandMark,
  buttonClass,
  Icon,
  orgSwitcherTriggerClass,
  type IconName,
  type MenuItem,
  type OrgSwitcherProps,
} from "@xos/ui";
import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { onDemand, useOnDemand } from "./on-demand";

const menus = onDemand(() => import("./shell-menus"));

const OPEN_KEYS = new Set(["Enter", " ", "ArrowDown"]);

/**
 * A header menu whose closed trigger renders without Radix (ADR 0027, A24-009). The trigger has the
 * same markup, classes and ARIA as the @xos/ui menu's closed trigger. Pointing at it or focusing it
 * loads the menu module and swaps in the real menu, keeping focus on the trigger; pressing it before
 * the module arrives opens the menu as soon as it does.
 */
function useDeferredMenu() {
  const [wanted, setWanted] = useState(false);
  const [openOnLoad, setOpenOnLoad] = useState(false);
  const loaded = useOnDemand(menus, wanted);
  const wrapper = useRef<HTMLSpanElement>(null);
  const focused = useRef(false);

  useEffect(() => {
    if (loaded && focused.current && !openOnLoad) {
      wrapper.current?.querySelector<HTMLButtonElement>("button")?.focus();
    }
  }, [loaded, openOnLoad]);

  const press = () => {
    setWanted(true);
    setOpenOnLoad(true);
  };
  const trigger = {
    type: "button" as const,
    "aria-haspopup": "menu" as const,
    "aria-expanded": false,
    "data-state": "closed",
    onPointerEnter: () => setWanted(true),
    onFocus: () => {
      focused.current = true;
      setWanted(true);
    },
    onBlur: () => {
      focused.current = false;
    },
    onPointerDown: (event: PointerEvent<HTMLButtonElement>) => {
      if (event.button !== 0 || event.ctrlKey) return;
      event.preventDefault();
      press();
    },
    onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => {
      if (!OPEN_KEYS.has(event.key)) return;
      event.preventDefault();
      press();
    },
  };
  return { loaded, wrapper, trigger, openOnLoad };
}

function Slot({
  wrapper,
  children,
}: {
  wrapper: RefObject<HTMLSpanElement | null>;
  children: ReactNode;
}) {
  return (
    <span ref={wrapper} className="contents">
      {children}
    </span>
  );
}

/** The account menu: the @xos/ui DropdownMenu, deferred. */
export function AccountMenu({
  label,
  icon,
  items,
}: {
  label: string;
  icon: IconName;
  items: MenuItem[];
}) {
  const { loaded, wrapper, trigger, openOnLoad } = useDeferredMenu();
  return (
    <Slot wrapper={wrapper}>
      {loaded ? (
        <loaded.DropdownMenu
          label={label}
          icon={icon}
          items={items}
          {...(openOnLoad ? { defaultOpen: true } : {})}
        />
      ) : (
        <button {...trigger} className={buttonClass()}>
          <Icon name={icon} size={14} />
          {label}
          <Icon name="ChevronDown" size={14} />
        </button>
      )}
    </Slot>
  );
}

/** The org switcher: the @xos/ui OrgSwitcher, deferred. */
export function ShellOrgSwitcher(props: Omit<OrgSwitcherProps, "defaultOpen">) {
  const { loaded, wrapper, trigger, openOnLoad } = useDeferredMenu();
  return (
    <Slot wrapper={wrapper}>
      {loaded ? (
        <loaded.OrgSwitcher {...props} {...(openOnLoad ? { defaultOpen: true } : {})} />
      ) : (
        <button {...trigger} aria-label={props.current} className={orgSwitcherTriggerClass}>
          <BrandMark name={props.current} size="sm" />
          <Icon name="ChevronsUpDown" size={14} color="var(--color-text-secondary)" />
        </button>
      )}
    </Slot>
  );
}

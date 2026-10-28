/**
 * Shortcut targets (Section 11.2 principle 1): how a shell's key handler finds what a record or view
 * shortcut acts on. A region of the page carries data-shortcut-scope (`record` on the record full page
 * and the side peek, `view` on a collection), and the control that does an action carries
 * data-shortcut="<registry id>". The handler clicks that control, or focuses it when it is a field or
 * carries data-shortcut-focus, so a feature binds its control to a shortcut by carrying the attribute.
 *
 * - The attribute may sit on the control itself or on a wrapper around it; in a wrapper, the selected
 *   option of a radio group or tab list wins, else the first control.
 * - A control belongs to the nearest region around it, so a peek or a nested collection keeps its own.
 * - Disabled and hidden controls are skipped, except a `hidden` button that carries the attribute
 *   itself: a page keeps such a button for an action that has no control of its own on screen.
 */

export const SHORTCUT_REGION = "[data-shortcut-scope]";

const CONTROL =
  'button, a[href], input, select, textarea, summary, [contenteditable="true"], [role="button"], [role="radio"], [role="tab"], [role="combobox"], [role="menuitem"]';
const SELECTED = '[aria-checked="true"], [aria-selected="true"], [aria-pressed="true"]';
const FIELD =
  'input:not([type="button"]):not([type="submit"]):not([type="reset"]):not([type="checkbox"]):not([type="radio"]), select, textarea, [contenteditable="true"]';

/**
 * The region a key press acts in: the nearest marked region around the focused element or, while
 * focus rests on the page itself, the first region on the page.
 */
export function shortcutRegion(target: EventTarget | null): Element | null {
  if (!(target instanceof Element)) return null;
  const near = target.closest(SHORTCUT_REGION);
  if (near) return near;
  const doc = target.ownerDocument;
  return target === doc.body || target === doc.documentElement
    ? doc.querySelector(SHORTCUT_REGION)
    : null;
}

/** The scope a region answers for, such as `record` or `view`. */
export function regionScope(region: Element | null): string | null {
  return region?.getAttribute("data-shortcut-scope") || null;
}

function usable(control: HTMLElement): boolean {
  if (control.matches(':disabled, [aria-disabled="true"]') || control.closest("[inert]")) {
    return false;
  }
  return control.getClientRects().length > 0;
}

interface Target {
  readonly control: HTMLElement;
  readonly focus: boolean;
}

function targetIn(region: Element, id: string): Target | null {
  for (const marked of region.querySelectorAll<HTMLElement>(`[data-shortcut="${id}"]`)) {
    if (marked.closest(SHORTCUT_REGION) !== region) continue;
    const focus = marked.hasAttribute("data-shortcut-focus");
    if (marked.matches(CONTROL)) {
      const kept = marked.hidden && marked.tagName === "BUTTON";
      if (kept || usable(marked)) return { control: marked, focus };
      continue;
    }
    const candidates = [
      ...marked.querySelectorAll<HTMLElement>(SELECTED),
      ...marked.querySelectorAll<HTMLElement>(CONTROL),
    ];
    const control = candidates.find((c) => c.matches(CONTROL) && usable(c));
    if (control) return { control, focus };
  }
  return null;
}

/**
 * The control in a region that does the shortcut's action, or null when the region has none. Ids
 * are registry ids (letters, digits, dots and hyphens), so they quote safely in the selector.
 */
export function shortcutControl(region: Element, id: string): HTMLElement | null {
  return targetIn(region, id)?.control ?? null;
}

function openPicker(select: HTMLSelectElement): void {
  try {
    select.showPicker();
  } catch {
    // Not every browser opens a select's picker from script; the select keeps focus.
  }
}

/**
 * Does the shortcut's action in a region: clicks its control, or focuses it (selecting a text
 * input's text, such as a title). Returns false when nothing in the region does the action, so the key goes on.
 */
export function runShortcut(region: Element, id: string): boolean {
  const target = targetIn(region, id);
  if (!target) return false;
  const { control } = target;
  if (target.focus || control.matches(FIELD)) {
    control.focus();
    if (control instanceof HTMLInputElement) control.select();
    // A list to pick from opens where the browser allows it, as assigning an owner expects.
    if (control instanceof HTMLSelectElement && !target.focus) openPicker(control);
  } else {
    control.click();
  }
  return true;
}

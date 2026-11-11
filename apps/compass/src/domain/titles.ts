/**
 * Whether a page title fits the native large-title header. iOS draws that header on one line and cuts a longer
 * title with an ellipsis, which hid most of the Spanish ones ("Requisitos de incorpor…", C-23). At 34 pt bold
 * about 20 characters fit across the narrowest supported iPhone (375 pt, less the margins); a longer title is
 * drawn as a heading in the page, where it wraps, and the header keeps only the back button.
 */
export const LARGE_TITLE_MAX_CHARACTERS = 20;

export function largeTitleFits(title: string): boolean {
  return [...title].length <= LARGE_TITLE_MAX_CHARACTERS;
}

export interface StackTitleOptions {
  readonly title: string;
  readonly headerTitle: string;
  readonly headerLargeTitle: boolean;
}

/**
 * The root stack header's options for a page title: the large title when it fits, otherwise a compact bar with no
 * title while the page draws it as a wrapping heading. With no title there is no large-title band either; an empty
 * one left about 120 pt blank under the back button (A59-031).
 */
export function stackTitleOptions(title: string): StackTitleOptions {
  return title !== "" && largeTitleFits(title)
    ? { title, headerTitle: title, headerLargeTitle: true }
    : { title, headerTitle: "", headerLargeTitle: false };
}

import { type ReactElement, type ReactNode } from "react";
import { InToastRegion } from "./Feedback.shared.tsx";

/**
 * A polite live region that stacks toasts at the bottom of the viewport. Mount it for the life of
 * the page and render toasts into it: a live region added together with its content is often not
 * announced.
 */
export function ToastRegion({
  label,
  children,
}: {
  label: string;
  children?: ReactNode;
}): ReactElement {
  return (
    <section
      aria-label={label}
      aria-live="polite"
      aria-atomic="false"
      className="fixed bottom-16 end-16 z-toast flex flex-col items-end gap-8 max-w-[calc(100vw-var(--space-32))]"
    >
      <InToastRegion.Provider value={true}>{children}</InToastRegion.Provider>
    </section>
  );
}

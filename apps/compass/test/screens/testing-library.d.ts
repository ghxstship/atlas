/** What these tests use of the renderer vitest.screens.config.ts borrows, which Compass does not depend on. */
declare module "@testing-library/react" {
  import type { ReactElement } from "react";
  export function render(ui: ReactElement): unknown;
  export function cleanup(): void;
  export function act(run: () => Promise<void>): Promise<void>;
  export const fireEvent: { click(element: Element): boolean };
  export const screen: {
    getByTestId(id: string): HTMLElement;
    queryByTestId(id: string): HTMLElement | null;
    getByText(text: RegExp): HTMLElement;
    queryByText(text: RegExp): HTMLElement | null;
  };
}

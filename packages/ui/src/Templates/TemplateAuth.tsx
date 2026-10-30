import type { ReactElement } from "react";
import { type TemplateAuthProps } from "./Templates.types.ts";

/** Sign in, MFA, invite acceptance and passkey setup: a centered 400 px card. */
export function TemplateAuth({ brand, children }: TemplateAuthProps): ReactElement {
  return (
    <div data-template="auth" className="grid place-items-center min-h-full p-24 bg-bg-canvas">
      <div className="flex flex-col gap-24 w-[min(var(--layout-auth),100%)]">
        {brand ? <div className="flex justify-center">{brand}</div> : null}
        <div className="flex flex-col gap-16 p-24 bg-bg-raised border border-border-subtle rounded-card">
          {children}
        </div>
      </div>
    </div>
  );
}

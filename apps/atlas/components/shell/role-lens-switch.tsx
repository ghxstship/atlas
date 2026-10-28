import { Check, ChevronRight, UserRoundSearch } from "lucide-react";
import type { OrgContext } from "@/lib/shell/context";
import { setRoleLensAction } from "@/lib/shell/role-lens-actions";

type Translate = (key: string, values?: Record<string, string>) => string;

/**
 * The role lens under the org switcher (Section 4.8.1, A128, ADR 0089): All roles, or one role the person holds in
 * the org. A server-rendered disclosure with a plain form, so it adds no JavaScript to any page (the shell's
 * pages sit close to their bundle budget) and works before hydration. Choosing an option sets the lens for the
 * browser session and renders the page again under it. It shows only for a person with two or more roles, and
 * not while View as role previews another role.
 */
export function RoleLensSwitch({ ctx, t }: { ctx: OrgContext; t: Translate }) {
  const { roles, role } = ctx.lens;
  if (roles.length < 2 || ctx.preview) return null;
  const name = (r: (typeof roles)[number]) => r.name ?? t(`shell.roles.${r.code}`);
  const current = role ? name(role) : t("shell.roleLens.all");
  const options = [
    { value: "", label: t("shell.roleLens.all"), active: role === null },
    ...roles.map((r) => ({ value: r.id, label: name(r), active: role?.id === r.id })),
  ];
  return (
    // Keyed on the lens, so the disclosure closes once a choice renders the page again.
    <details key={role?.id ?? "all"} data-testid="role-lens" className="group/lens mt-4">
      <summary
        aria-label={t("shell.roleLens.summary", { role: current })}
        className="flex min-h-target-fine cursor-pointer list-none items-center gap-8 rounded-control px-8 text-text-13 text-text-secondary hover:bg-bg-hover focus-visible:outline-2 focus-visible:outline-focus-ring pointer-coarse:min-h-target-coarse [&::-webkit-details-marker]:hidden"
      >
        <UserRoundSearch aria-hidden="true" className="size-14 shrink-0" />
        <span className="min-w-0 flex-1 truncate">
          {t("shell.roleLens.label")}: <span className="text-text-primary">{current}</span>
        </span>
        <ChevronRight
          aria-hidden="true"
          className="size-14 shrink-0 transition-transform duration-fast ease-standard group-open/lens:rotate-90 group-open/lens:rtl:-rotate-90"
        />
      </summary>
      <form
        action={setRoleLensAction}
        aria-label={t("shell.roleLens.label")}
        className="mt-4 flex flex-col gap-2 rounded-control border border-border-subtle bg-bg-raised p-4 group-not-open/lens:hidden"
      >
        <input type="hidden" name="org" value={ctx.org.slug} />
        <p className="m-0 px-8 py-4 text-text-12 text-text-secondary">{t("shell.roleLens.hint")}</p>
        {options.map((o) => (
          <button
            key={o.value || "all"}
            type="submit"
            name="role"
            value={o.value}
            aria-pressed={o.active}
            data-testid={`role-lens-${o.value || "all"}`}
            className="flex min-h-target-fine cursor-pointer items-center gap-8 rounded-control border-0 bg-transparent px-8 text-start text-text-13 text-text-primary hover:bg-bg-hover focus-visible:outline-2 focus-visible:outline-focus-ring pointer-coarse:min-h-target-coarse"
          >
            {o.active ? (
              <Check aria-hidden="true" className="size-14 shrink-0" />
            ) : (
              <span aria-hidden="true" className="size-14 shrink-0" />
            )}
            {o.label}
          </button>
        ))}
      </form>
    </details>
  );
}

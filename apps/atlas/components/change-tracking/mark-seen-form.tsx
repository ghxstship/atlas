import { Button } from "@/components/ui";
import { markSeenAction } from "@/lib/change-tracking/actions";

/** Mark all as seen (B6): a plain form, so it works before any script loads. */
export function MarkSeenForm({
  surface,
  scopeId,
  path,
  label,
}: {
  surface: "Today" | "Show Day";
  scopeId: string;
  path: string;
  label: string;
}) {
  return (
    <form action={markSeenAction}>
      <input type="hidden" name="surface" value={surface} />
      <input type="hidden" name="scopeId" value={scopeId} />
      <input type="hidden" name="path" value={path} />
      <Button type="submit" variant="ghost" size="sm" icon="Check">
        {label}
      </Button>
    </form>
  );
}

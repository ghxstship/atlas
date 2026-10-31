/**
 * Where the focus goes once a For Your Information item leaves (A127): the item that takes its place, which is the
 * next one, or the one before it when the last item left. Null when no item is left, so the empty-state sentence
 * takes the focus and the keyboard user is not dropped on the page.
 */
export function focusAfterLeaving(index: number, count: number): number | null {
  const remaining = count - 1;
  if (remaining <= 0) return null;
  return Math.min(Math.max(index, 0), remaining - 1);
}

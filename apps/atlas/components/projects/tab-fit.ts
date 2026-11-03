/** Space between the last visible tab and the More button, and around a promoted tab. */
const GAP = 16;

/**
 * How many leading tabs fit in `available`, keeping room for More and for the current tab when it would overflow.
 * `edges` are each tab's far edge from the start of the row and `widths` their widths, as measured with every tab
 * rendered; a caller that found the rendered bar wider than those says so by passing less `available`.
 */
export function fit(
  edges: readonly number[],
  widths: readonly number[],
  available: number,
  more: number,
  current: number,
): number {
  const n = edges.length;
  if (n === 0 || (edges[n - 1] ?? 0) <= available) return n;
  let k = n - 1;
  while (k > 0 && (edges[k - 1] ?? 0) + GAP + more > available) k -= 1;
  if (current >= k) {
    const promoted = (widths[current] ?? 0) + GAP;
    while (k > 0 && (edges[k - 1] ?? 0) + promoted + GAP + more > available) k -= 1;
  }
  return k;
}

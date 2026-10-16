/** The request's current time, read once where a server page needs it (outside render purity rules). */
export function requestNow(): number {
  return Date.now();
}

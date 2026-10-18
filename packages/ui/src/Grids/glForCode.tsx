import type { GLAccount } from "../types/reference";

/** The account a role code or URID posts to: its class's one account of the requested type, or null. */
export function glForCode(
  code: string,
  accounts: GLAccount[],
  type: GLAccount["type"] = "Expense",
): GLAccount | null {
  const cls = code.split(".")[0];
  return accounts.find((a) => a.classCode === cls && a.type === type) ?? null;
}

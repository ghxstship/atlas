/**
 * Canon input registry (Section 2). File names, Drive IDs, roles and the Drive
 * modified times recorded when the owner fetched the files into canon/source.
 * Hashes are never stated here; the manifest computes them from the bytes.
 */

export type SourceRole = "bible" | "playbook" | "item-catalog" | "gl-chart" | "kit" | "templates";

export interface SourceFile {
  readonly file: string;
  readonly role: SourceRole;
  readonly driveFileId: string;
  readonly driveModifiedTime: string;
  readonly referenceOnly: boolean;
}

export const SOURCE_FILES: readonly SourceFile[] = [
  {
    file: "XOS_4.0_Bible.xlsx",
    role: "bible",
    driveFileId: "13nY5TNM71uXAcWbfiJaf5QpQPdCUFvQQ",
    driveModifiedTime: "2026-09-15T22:29:08Z",
    referenceOnly: false,
  },
  {
    file: "XOS-4.0_Production-Playbook_2026.xlsx",
    role: "playbook",
    driveFileId: "1p5Yxgyp5G09WR9X6sj8Btim2IM5vr-Zhe5eEvokn15w",
    driveModifiedTime: "2026-10-07T15:36:45.256Z",
    referenceOnly: false,
  },
  {
    file: "XOS_4.0_Item_Catalog.csv",
    role: "item-catalog",
    driveFileId: "1rum0_qhVdu4Dty608yNq8mqQ-fKR1GOQ",
    driveModifiedTime: "2026-09-15T22:29:08Z",
    referenceOnly: false,
  },
  {
    file: "XOS_4.0_GL_Chart_of_Accounts.csv",
    role: "gl-chart",
    driveFileId: "1WQR9rV5Guyx3J-qfxj8eThQKG-0m4xP_",
    driveModifiedTime: "2026-09-15T22:29:08Z",
    referenceOnly: false,
  },
  {
    file: "XOS_4.0_Kit.zip",
    role: "kit",
    driveFileId: "1xmq0KYsh9DhneaFrE_pmXd9ZLSeSTiKi",
    driveModifiedTime: "2026-09-15T22:29:08Z",
    referenceOnly: true,
  },
  {
    file: "XOS_4.0_Templates.zip",
    role: "templates",
    driveFileId: "1HTk7-scm8V7Yq8Azb6fsh-iP6R7Ed77q",
    driveModifiedTime: "2026-09-15T22:29:08Z",
    referenceOnly: true,
  },
];

export function sourceByRole(role: SourceRole): SourceFile {
  const found = SOURCE_FILES.find((s) => s.role === role);
  if (!found) throw new Error(`No canon source registered for role ${role}`);
  return found;
}

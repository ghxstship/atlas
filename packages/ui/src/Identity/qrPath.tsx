import qrcode from "qrcode-generator";
import { type QRModules } from "./Identity.types.ts";

/** The dark modules of a QR code (error correction M) as one SVG path, with a 4-module quiet zone. */
export function qrPath(value: string): { size: number; path: string } {
  const code = qrcode(0, "M");
  code.addData(value);
  code.make();
  const modules = code as unknown as QRModules;
  const n = modules.getModuleCount();
  const cells: string[] = [];
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) if (modules.isDark(r, c)) cells.push(`M${c + 4} ${r + 4}h1v1h-1z`);
  }
  return { size: n + 8, path: cells.join("") };
}

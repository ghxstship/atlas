import qrcode from "qrcode-generator";

interface QrModules {
  getModuleCount(): number;
  isDark(row: number, col: number): boolean;
}

/**
 * The QR code of a record link as rows of dark modules (qrcode-generator 1.4.4, error correction M).
 * The renderer draws it as vector squares inside a tagged Figure; the page around it is the quiet zone.
 */
export function qrMatrix(text: string): boolean[][] {
  const code = qrcode(0, "M");
  code.addData(text);
  code.make();
  const modules = code as unknown as QrModules;
  const size = modules.getModuleCount();
  return Array.from({ length: size }, (_, r) =>
    Array.from({ length: size }, (_, c) => modules.isDark(r, c)),
  );
}

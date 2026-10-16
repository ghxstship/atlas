/** The docs theme preference: remembered in this browser, applied before first paint. */
export const THEME_KEY = "xos-docs-theme";

/** Runs in <head> before paint, so a light-theme reader never sees a dark flash. Dark is the fallback. */
export const THEME_SCRIPT = `try{var p=localStorage.getItem("${THEME_KEY}")||"system";document.documentElement.dataset.theme=p==="system"?(matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light"):p;}catch(e){document.documentElement.dataset.theme="dark";}`;

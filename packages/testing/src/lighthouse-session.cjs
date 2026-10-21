/* global module, process, URL */
/**
 * Lighthouse CI puppeteerScript for the signed-in pages (src/lighthouse-cli.ts). Before each page,
 * it puts the demo session the CLI signed in with into the browser's cookie jar, where the app's
 * own cookies join it, as in a real browser. CommonJS, because lhci loads the script with require.
 */
module.exports = async function setSession(browser, { url }) {
  const cookies = JSON.parse(process.env.XOS_LH_SESSION_COOKIES || "[]").map((cookie) => ({
    name: cookie.name,
    value: cookie.value,
    domain: new URL(url).hostname,
    path: "/",
    httpOnly: true,
    sameSite: "Lax",
  }));
  if (cookies.length === 0) throw new Error("XOS_LH_SESSION_COOKIES holds no session cookie.");
  await browser.setCookie(...cookies);
};

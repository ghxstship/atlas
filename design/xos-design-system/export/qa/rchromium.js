// Chromium (Blink) responsive matrix. Usage: node rchromium.js <rt dir> <project dir> <out.json>
const { chromium } = require(process.argv[2] + '/node_modules/playwright-core');
const fs = require('fs'), audit = require('./raudit.js');
const P = process.argv[3], OUT = process.argv[4];
const DEVICES = [
  { id: 'phone-320', width: 320, height: 568, dpr: 2, touch: true },     // WCAG 1.4.10 reflow width, iPhone SE (1st gen)
  { id: 'phone-375', width: 375, height: 667, dpr: 2, touch: true },     // iPhone SE (3rd gen)
  { id: 'phone-390', width: 390, height: 844, dpr: 3, touch: true },     // Compass reference phone
  { id: 'android-412', width: 412, height: 915, dpr: 2.625, touch: true },// Pixel 7
  { id: 'phone-430', width: 430, height: 932, dpr: 3, touch: true },     // Compass large phone
  { id: 'bp-sm-640', width: 640, height: 900, dpr: 1, touch: false },
  { id: 'tablet-768', width: 768, height: 1024, dpr: 2, touch: true },   // bp-md, iPad portrait
  { id: 'tablet-1024', width: 1024, height: 768, dpr: 2, touch: true },  // bp-lg, Atlas tablet reference
  { id: 'laptop-1280', width: 1280, height: 800, dpr: 2, touch: false }, // bp-xl, Atlas laptop reference
  { id: 'desktop-1440', width: 1440, height: 900, dpr: 1, touch: false },// Atlas desktop reference
  { id: 'bp-2xl-1536', width: 1536, height: 960, dpr: 1, touch: false },
  { id: 'bp-3xl-1920', width: 1920, height: 1080, dpr: 1, touch: false },
];
const tok = JSON.parse(fs.readFileSync(P + '/tokens.json', 'utf8'));
function tokenSets(theme) {
  const px = v => v; const sizes = new Set(); tok.type.groups.forEach(g => g.styles.forEach(s => sizes.add(s.fontSize)));
  tok.iconSize.tokens.forEach(t => sizes.add(t.value));
  return { fontSize: [...sizes], fontWeight: tok.fontWeight.tokens.map(t => t.value),
    space: ['0px', ...tok.spacing.tokens.map(t => t.value)], radius: ['0px', ...tok.radius.tokens.map(t => t.value)],
    border: ['0px', ...tok.strokeWidth.tokens.map(t => t.value)], color: null, theme };
}
(async () => {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const list = JSON.parse(fs.readFileSync('/tmp/rsite/list.json', 'utf8')).filter(x => !process.env.ONLY || process.env.ONLY.split(',').includes(x.name));
  const results = [];
  // Resolved token colors per theme, read from the browser so they match computed styles exactly.
  const colorSets = {};
  for (const TH of ['dark', 'light', 'sunlight']) {
    const c = await b.newContext(); const pg = await c.newPage(); await pg.goto(`http://127.0.0.1:8765/p/Button.${TH}.html`);
    colorSets[TH] = await pg.evaluate(names => names.map(n => { const d = document.createElement('div'); d.style.color = `var(--${n})`; document.body.appendChild(d); const v = getComputedStyle(d).color; d.remove(); return v; }), tok.color.tokens.map(t => t.name));
    colorSets[TH].push('rgb(0, 0, 0)', 'rgb(255, 255, 255)'); await c.close();
  }
  for (const D of DEVICES) {
    const ctx = await b.newContext({ viewport: { width: D.width, height: D.height }, deviceScaleFactor: D.dpr, hasTouch: D.touch, isMobile: D.touch && D.width < 1024 });
    for (const item of list) {
      const themes = D.id === 'desktop-1440' ? ['dark', 'light', 'sunlight'] : (D.id === 'phone-390' ? ['dark', 'sunlight'] : ['dark']);
      for (const TH of themes) {
        const pg = await ctx.newPage(); const errs = []; pg.on('pageerror', e => errs.push(e.message));
        await pg.goto(`http://127.0.0.1:8765/p/${item.name}.${TH}.html`); await pg.evaluate(() => document.fonts.ready); await pg.waitForTimeout(120);
        const coarse = await pg.evaluate(() => matchMedia('(pointer: coarse)').matches);
        const opts = { coarse };
        if (D.id === 'desktop-1440') { const T = tokenSets(TH); T.color = colorSets[TH]; opts.tokens = T; }
        const r = await pg.evaluate(`(${audit.toString()})(${JSON.stringify(opts)})`);
        results.push({ engine: 'chromium', device: D.id, theme: TH, preview: item.name, group: item.group, page: item.page, coarse, errors: errs, ...r });
        if ((process.env.SHOTS || '').split(',').includes(item.name)) await pg.screenshot({ path: `/tmp/rshots/${item.name}.${D.id}.${TH}.png`, fullPage: true });
        await pg.close();
      }
    }
    await ctx.close(); console.log('done', D.id);
  }
  fs.writeFileSync(OUT, JSON.stringify(results)); await b.close();
})();

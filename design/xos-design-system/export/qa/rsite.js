// Builds /tmp/rsite: every preview as a standalone page that loads shared libraries, real fonts and theme variables,
// and serves it on 127.0.0.1:8765. Usage: node rsite.js <rt dir> <project dir>
const fs = require('fs'), path = require('path'), http = require('http');
const RT = process.argv[2], P = process.argv[3], OUT = '/tmp/rsite';
fs.rmSync(OUT, { recursive: true, force: true }); fs.mkdirSync(OUT + '/lib', { recursive: true }); fs.mkdirSync(OUT + '/fonts', { recursive: true }); fs.mkdirSync(OUT + '/p', { recursive: true });
const cp = (a, b) => fs.copyFileSync(a, OUT + '/' + b);
cp(RT + '/node_modules/react/umd/react.production.min.js', 'lib/react.js');
cp(RT + '/node_modules/react-dom/umd/react-dom.production.min.js', 'lib/react-dom.js');
cp(P + '/components/lib/react-alias.js', 'lib/react-alias.js');
cp(P + '/components/lib/qrcode-generator.js', 'lib/qrcode.js');
cp(P + '/components/lib/lucide-react.min.js', 'lib/lucide.js');
cp(P + '/components/bundle.js', 'lib/bundle.js');
fs.writeFileSync(OUT + '/lib/bundle.css', fs.readFileSync(P + '/components/bundle.css', 'utf8').replace(/@import url\("[^"]*"\);/, ''));
// Fonts: Inter (variable) and JetBrains Mono 400 and 500, same files production self-hosts.
const IV = RT + '/node_modules/@fontsource-variable/inter/files/', JB = RT + '/node_modules/@fontsource/jetbrains-mono/files/';
cp(IV + 'inter-latin-wght-normal.woff2', 'fonts/inter.woff2');
cp(JB + 'jetbrains-mono-latin-400-normal.woff2', 'fonts/jbm-400.woff2'); cp(JB + 'jetbrains-mono-latin-500-normal.woff2', 'fonts/jbm-500.woff2');
fs.writeFileSync(OUT + '/lib/fonts.css', `@font-face{font-family:"Inter";src:url(/fonts/inter.woff2) format("woff2");font-weight:100 900;font-display:block}
@font-face{font-family:"JetBrains Mono";src:url(/fonts/jbm-400.woff2) format("woff2");font-weight:400;font-display:block}
@font-face{font-family:"JetBrains Mono";src:url(/fonts/jbm-500.woff2) format("woff2");font-weight:500;font-display:block}`);
// Theme variables from tokens.json, one file per theme.
const tok = JSON.parse(fs.readFileSync(P + '/tokens.json', 'utf8'));
for (const TH of ['dark', 'light', 'sunlight']) {
  let v = ':root{';
  for (const t of tok.color.tokens) { let x = typeof t.value === 'string' ? t.value : (t.value[TH] ?? t.value.dark); v += `--${t.name}:${x.replace(/^\{(.*)\}$/, 'var(--$1)')};`; }
  for (const f of Object.keys(tok)) { if (['color', 'type', 'meta', 'name', 'version'].includes(f)) continue; for (const t of tok[f].tokens) { let x = typeof t.value === 'string' ? t.value : (t.value[TH] ?? t.value.dark); v += `--${t.name}:${x};`; } }
  v += `--font-sans:${tok.type.families.sans};--font-mono:${tok.type.families.mono};}`;
  fs.writeFileSync(OUT + `/lib/theme-${TH}.css`, v);
}
const head = TH => `<head><link rel="stylesheet" href="/lib/fonts.css"><link rel="stylesheet" href="/lib/theme-${TH}.css"><link rel="stylesheet" href="/lib/bundle.css"><meta name="viewport" content="width=device-width, initial-scale=1"><script src="/lib/react.js"></script><script src="/lib/react-dom.js"></script><script src="/lib/react-alias.js"></script><script src="/lib/qrcode.js"></script><script src="/lib/lucide.js"></script><script src="/lib/bundle.js"></script>`;
const list = [];
for (const d of fs.readdirSync(P + '/components').sort()) {
  const f = P + '/components/' + d + '/preview.html'; if (!fs.existsSync(f)) continue;
  const src = fs.readFileSync(f, 'utf8'), m = src.match(/@dsCard group="([^"]+)"[^>]*?(?:width=(\d+))?[^>]*-->/);
  for (const TH of ['dark', 'light', 'sunlight']) {
    let html = src.replace(/^<!--[^\n]*\n/, '').replace('<head>', () => head(TH)).replace(/<html[^>]*>/, `<html lang="en-US" data-theme="${TH}">`);
    fs.writeFileSync(OUT + `/p/${d}.${TH}.html`, html);
  }
  list.push({ name: d, group: m ? m[1] : '', cardWidth: m && m[2] ? +m[2] : null, page: / page\b/.test(src.split('\n')[0]) });
}
fs.writeFileSync(OUT + '/list.json', JSON.stringify(list));
const types = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.woff2': 'font/woff2', '.json': 'application/json' };
http.createServer((q, r) => { const f = OUT + decodeURIComponent(q.url.split('?')[0]); if (!f.startsWith(OUT) || !fs.existsSync(f)) { r.writeHead(404); return r.end(); } r.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(r); })
  .listen(8765, '127.0.0.1', () => console.log('serving', list.length, 'previews'));

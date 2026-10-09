// WebKit (Safari's engine, GTK port) responsive matrix through WebKitWebDriver. Run under xvfb-run.
// Usage: node rwebkit.js <rt dir> <out.json>
const { Builder } = require(process.argv[2] + '/node_modules/selenium-webdriver');
const fs = require('fs'), audit = require('./raudit.js'), OUT = process.argv[3];
const WIDTHS = [320, 390, 768, 1024, 1440];
(async () => {
  const caps = { browserName: 'MiniBrowser', 'webkitgtk:browserOptions': { binary: '/usr/lib/x86_64-linux-gnu/webkit2gtk-4.1/MiniBrowser', args: ['--automation'] } };
  const svc = require('child_process').spawn('/usr/bin/WebKitWebDriver', ['--port=4445'], { stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 1500));
  const d = await new Builder().usingServer('http://127.0.0.1:4445').withCapabilities(caps).build();
  const ua = await d.executeScript('return navigator.userAgent');
  const list = JSON.parse(fs.readFileSync('/tmp/rsite/list.json', 'utf8')).filter(x => !process.env.ONLY || process.env.ONLY.split(',').includes(x.name));
  const results = [];
  // Phone widths render in an iframe of the exact width, because the MiniBrowser window cannot be narrower than about 450 px.
  require('fs').writeFileSync('/tmp/rsite/frame.html', '<!doctype html><html><body style="margin:0"><iframe id="f" style="border:0;display:block"></iframe><script>const q=new URLSearchParams(location.search);const f=document.getElementById("f");f.style.width=q.get("w")+"px";f.style.height="900px";f.src=q.get("src");</script></body></html>');
  await d.manage().window().setRect({ width: 1440, height: 1000 });
  for (const W of WIDTHS) {
    const framed = W < 768;
    if (!framed) {
      await d.manage().window().setRect({ width: W, height: 900 }); await d.get('http://127.0.0.1:8765/p/Button.dark.html');
      for (let k = 0; k < 4; k++) { const iw = await d.executeScript('return document.documentElement.clientWidth'); if (iw === W) break; const r = await d.manage().window().getRect(); await d.manage().window().setRect({ width: r.width + (W - iw), height: 900 }); }
    } else await d.manage().window().setRect({ width: 1440, height: 1000 });
    let actual = null;
    for (const item of list) {
      const src = `/p/${item.name}.dark.html`;
      if (framed) { await d.switchTo().defaultContent(); await d.get(`http://127.0.0.1:8765/frame.html?w=${W}&src=${encodeURIComponent(src)}`); await d.sleep(150); await d.switchTo().frame(0); }
      else await d.get('http://127.0.0.1:8765' + src);
      await d.executeAsyncScript('const cb = arguments[arguments.length - 1]; const go = () => document.fonts.ready.then(() => setTimeout(cb, 150)); document.readyState === "complete" ? go() : addEventListener("load", go);');
      const r = await d.executeScript(`return (${audit.toString()})({coarse:false})`);
      actual = r.w;
      results.push({ engine: 'webkit', device: 'webkit-' + W, framed, theme: 'dark', preview: item.name, group: item.group, page: item.page, ...r });
    }
    if (framed) await d.switchTo().defaultContent();
    console.log('done', W, 'layout width', actual);
  }
  fs.writeFileSync(OUT, JSON.stringify({ userAgent: ua, results })); await d.quit(); svc.kill();
})().catch(e => { console.error(e); process.exit(1); });

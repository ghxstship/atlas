/* XOS contrast gate. Usage: node check-contrast.js <tokens.json> <contrast-pairs.json>
   Exits 1 when any declared pair falls under its WCAG 2.2 AA threshold in any theme. */
"use strict";
var fs = require("fs");
var tokens = JSON.parse(fs.readFileSync(process.argv[2] || "tokens.json", "utf8"));
var spec = JSON.parse(fs.readFileSync(process.argv[3] || "contrast-pairs.json", "utf8"));
var themes = tokens.color.themes.map(function (t) { return t.id; });
var byName = {};
tokens.color.tokens.forEach(function (t) { byName[t.name] = t; });
function raw(name, theme) {
  var t = byName[name];
  if (!t) throw new Error("Unknown color token: " + name);
  var v = typeof t.value === "string" ? t.value : (t.value[theme] !== undefined ? t.value[theme] : t.value[themes[0]]);
  var m = /^\{(.+)\}$/.exec(v);
  return m ? raw(m[1], theme) : v;
}
function lin(c) { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
function lum(hex) { var h = hex.replace("#", ""); if (h.length === 3) h = h.replace(/./g, "$&$&"); return 0.2126 * lin(parseInt(h.substr(0, 2), 16)) + 0.7152 * lin(parseInt(h.substr(2, 2), 16)) + 0.0722 * lin(parseInt(h.substr(4, 2), 16)); }
function ratio(a, b) { var x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); }
var failures = 0, checked = 0;
themes.forEach(function (theme) {
  spec.rules.forEach(function (rule) {
    rule.fg.forEach(function (fg) {
      rule.bg.forEach(function (bg) {
        checked++;
        var r = ratio(raw(fg, theme), raw(bg, theme));
        if (r < rule.min) { failures++; console.log("FAIL " + theme + " " + rule.name + ": " + fg + " on " + bg + " = " + r.toFixed(2) + ":1 (needs " + rule.min + ":1)"); }
      });
    });
  });
});
console.log(checked + " pairs checked across " + themes.length + " themes, " + failures + " failing.");
process.exit(failures ? 1 : 0);

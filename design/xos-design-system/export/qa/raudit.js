// In-page responsive and anatomy audit. Runs in any browser; returns plain JSON. `opts.coarse` requires 44 px targets, `opts.min` sets another minimum (48 for Compass); `opts.tokens` checks token conformance.
module.exports = function audit(opts) {
  const W = document.documentElement.clientWidth, root = document.getElementById('root') || document.body;
  const out = { w: W, overflowX: Math.max(0, document.documentElement.scrollWidth - W), escape: [], clipped: [], overlapText: [], overlapTarget: [], target: [], tokens: [], images: [], minFont: [] };
  const name = el => { const c = (el.className && el.className.baseVal === undefined ? String(el.className) : '').split(' ').filter(x => x.startsWith('xos-')).slice(0, 2).join('.'); const t = (el.getAttribute('aria-label') || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 32); return el.tagName.toLowerCase() + (c ? '.' + c : '') + (t ? ` "${t}"` : ''); };
  // Content of a closed <details> is not rendered, apart from its summary.
  const collapsed = el => { const d = el.closest('details:not([open])'); return !!d && !el.closest('summary'); };
  const visible = (el, cs) => { if (collapsed(el)) return false; if (cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity === 0) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const srOnly = el => !!el.closest('.xos-sr, [aria-hidden="true"]') && el.getBoundingClientRect().width <= 1;
  // The nearest ancestor that clips horizontally bounds what is visible; only elements with no clipping ancestor can escape the page.
  const clipAncestor = el => { for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) { const s = getComputedStyle(p); if (s.overflowX !== 'visible' || s.contain.includes('paint')) return p; } return null; };
  const layer = el => { for (let p = el; p && p !== document.body; p = p.parentElement) { const s = getComputedStyle(p); if (s.position === 'fixed' || s.position === 'absolute' || s.position === 'sticky') return p; } return document.body; };
  const els = [...root.querySelectorAll('*')].filter(el => !(el instanceof SVGElement) || el.tagName.toLowerCase() === 'svg');
  const textEls = [], targets = [];
  for (const el of els) {
    const cs = getComputedStyle(el); if (!visible(el, cs) || srOnly(el)) continue;
    const r = el.getBoundingClientRect();
    if ((r.right > W + 0.5 || r.left < -0.5) && !clipAncestor(el)) out.escape.push(`${name(el)} spans ${Math.round(r.left)} to ${Math.round(r.right)}`);
    const ownText = [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim());
    if (ownText) {
      // Per-line glyph boxes of the element's own text, so wrapped inline text is not mistaken for a full-width block.
      // Glyph boxes are clipped to the element's visible region, so text cut off by an ellipsis or a scroller is not counted.
      let clip = { left: -1e9, top: -1e9, right: 1e9, bottom: 1e9 };
      for (let p = el; p && p !== document.body; p = p.parentElement) { const s = getComputedStyle(p); if (s.overflowX !== 'visible' || s.overflowY !== 'visible') { const b = p.getBoundingClientRect(); clip = { left: Math.max(clip.left, b.left), top: Math.max(clip.top, b.top), right: Math.min(clip.right, b.right), bottom: Math.min(clip.bottom, b.bottom) }; } }
      const rects = []; for (const n of el.childNodes) if (n.nodeType === 3 && n.textContent.trim()) { const rg = document.createRange(); rg.selectNodeContents(n); for (const q of rg.getClientRects()) { const c = { left: Math.max(q.left, clip.left), top: Math.max(q.top, clip.top), right: Math.min(q.right, clip.right), bottom: Math.min(q.bottom, clip.bottom) }; c.width = c.right - c.left; c.height = c.bottom - c.top; if (c.width > 0.5 && c.height > 0.5) rects.push(c); } }
      textEls.push({ el, rects });
      const fs = parseFloat(cs.fontSize); if (fs < 11) out.minFont.push(`${name(el)} ${fs}px`);
      // Clipped text: content wider than its box with no ellipsis and no scroll.
      if ((cs.overflowX === 'hidden' || cs.overflowX === 'clip') && el.scrollWidth > el.clientWidth + 1 && cs.textOverflow !== 'ellipsis') out.clipped.push(`${name(el)} needs ${el.scrollWidth}px in ${el.clientWidth}px`);
      if (cs.textOverflow === 'ellipsis' && el.scrollWidth > el.clientWidth + 1 && !el.getAttribute('title') && !el.closest('[title]') && !el.closest('[aria-label]')) out.clipped.push(`${name(el)} truncates without the full text available`);
      // A label squeezed to a few characters is unreadable even when its full text is available elsewhere.
      if (cs.textOverflow === 'ellipsis' && el.scrollWidth > el.clientWidth + 1 && el.clientWidth < Math.min(48, el.scrollWidth)) out.clipped.push(`${name(el)} squeezed to ${el.clientWidth}px`);
    }
    const tag = el.tagName.toLowerCase(), role = el.getAttribute('role');
    const interactive = (tag === 'button' || (tag === 'a' && el.hasAttribute('href')) || tag === 'select' || tag === 'textarea' || (tag === 'input' && el.type !== 'hidden') || ['button', 'tab', 'menuitem', 'checkbox', 'switch', 'radio', 'option', 'slider', 'link'].includes(role)) && !el.disabled;
    if (interactive) {
      // Inline links inside running text are exempt (WCAG 2.5.8). A visually hidden native input is measured by its label.
      const inlineText = tag === 'a' && cs.display === 'inline' && el.parentElement && [...el.parentElement.childNodes].some(n => n.nodeType === 3 && n.textContent.trim());
      let box = r; const lab = el.closest('label'); if (tag === 'input' && lab) box = lab.getBoundingClientRect();
      // An invisible absolutely positioned ::before enlarges the hit area; measure that area.
      let hit = box; const pb = getComputedStyle(el, '::before');
      if (pb.content !== 'none' && pb.position === 'absolute') { const L = parseFloat(pb.left), T = parseFloat(pb.top), Rr = parseFloat(pb.right), B = parseFloat(pb.bottom);
        if ([L, T, Rr, B].every(Number.isFinite)) { const ox = r.left + el.clientLeft, oy = r.top + el.clientTop, iw = el.clientWidth, ih = el.clientHeight; const e = { left: Math.min(box.left, ox + L), top: Math.min(box.top, oy + T), right: Math.max(box.right, ox + iw - Rr), bottom: Math.max(box.bottom, oy + ih - B) }; e.width = e.right - e.left; e.height = e.bottom - e.top; hit = e; } }
      // Only the part of a target its clipping ancestors show can be hit; content scrolled under a bar is not a collision.
      let vis = { left: box.left, top: box.top, right: box.right, bottom: box.bottom };
      for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) { const s = getComputedStyle(p); if (s.overflowX !== 'visible' || s.overflowY !== 'visible') { const b = p.getBoundingClientRect(); vis = { left: Math.max(vis.left, b.left), top: Math.max(vis.top, b.top), right: Math.min(vis.right, b.right), bottom: Math.min(vis.bottom, b.bottom) }; } }
      if (!inlineText && vis.right - vis.left > 0.5 && vis.bottom - vis.top > 0.5) targets.push({ el, r: vis, hit, l: layer(el) });
    }
    if (tag === 'img' && el.naturalWidth) { const a = el.naturalWidth / el.naturalHeight, b = r.width / r.height; if (Math.abs(a - b) / a > 0.02 && !['cover', 'contain'].includes(cs.objectFit)) out.images.push(`${name(el)} distorted ${a.toFixed(2)} to ${b.toFixed(2)}`); }
    if (opts.tokens) {
      const T = opts.tokens, bad = [];
      if (ownText && !T.fontSize.includes(cs.fontSize) && !el.closest('svg')) bad.push('font-size ' + cs.fontSize);
      if (ownText && !T.fontWeight.includes(cs.fontWeight)) bad.push('font-weight ' + cs.fontWeight);
      for (const p of ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'rowGap', 'columnGap']) { const v = cs[p]; if (v && v !== 'normal' && !T.space.includes(v)) bad.push(p + ' ' + v); }
      for (const p of ['borderTopLeftRadius']) { const v = cs[p]; if (!T.radius.includes(v) && !v.endsWith('%')) bad.push('radius ' + v); }
      for (const p of ['borderTopWidth', 'borderLeftWidth']) { const s = cs[p.replace('Width', 'Style')]; if (s !== 'none' && !T.border.includes(cs[p])) bad.push(p + ' ' + cs[p]); }
      if (ownText && !T.color.includes(cs.color)) bad.push('color ' + cs.color);
      const bg = cs.backgroundColor; if (bg !== 'rgba(0, 0, 0, 0)' && !T.color.includes(bg)) bad.push('background ' + bg);
      if (bad.length) out.tokens.push(`${name(el)}: ${bad.join(', ')}`);
    }
  }
  const inter = (a, b) => Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
  for (let i = 0; i < textEls.length; i++) for (let j = i + 1; j < textEls.length; j++) {
    const A = textEls[i], B = textEls[j]; if (A.el.contains(B.el) || B.el.contains(A.el)) continue; if (layer(A.el) !== layer(B.el)) continue;
    let hit = false; for (const a of A.rects) { for (const b of B.rects) { const small = Math.min(a.width * a.height, b.width * b.height); if (small > 0 && inter(a, b) / small > 0.2) { hit = true; break; } } if (hit) break; }
    if (hit) out.overlapText.push(`${name(A.el)} overlaps ${name(B.el)}`);
  }
  // `opts.min` overrides the minimum, such as 48 for Compass (touch-min).
  const min = opts.min || (opts.coarse ? 44 : 24), cx = r => [(r.left + r.right) / 2, (r.top + r.bottom) / 2];
  for (let i = 0; i < targets.length; i++) {
    const A = targets[i];
    for (let j = i + 1; j < targets.length; j++) { const B = targets[j]; if (A.el.contains(B.el) || B.el.contains(A.el) || A.l !== B.l) continue; if (inter(A.r, B.r) > 4) out.overlapTarget.push(`${name(A.el)} overlaps ${name(B.el)}`); }
    if (Math.min(A.hit.width, A.hit.height) < min - 0.5) {
      // Spacing exception: an undersized target passes when no other target center sits within the minimum distance.
      const [x, y] = cx(A.hit); const crowded = targets.some(B => B !== A && !A.el.contains(B.el) && !B.el.contains(A.el) && Math.hypot(cx(B.r)[0] - x, cx(B.r)[1] - y) < min);
      if (crowded || opts.coarse || opts.min) out.target.push(`${name(A.el)} ${Math.round(A.hit.width)}x${Math.round(A.hit.height)}`);
    }
  }
  for (const k of Object.keys(out)) if (Array.isArray(out[k])) out[k] = [...new Set(out[k])];
  return out;
};

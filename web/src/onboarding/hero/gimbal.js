// Welcome background: a large gimbal drawn in characters. Three rings swing with a simulated market
// while the platform inside never tilts. Each frame lights the rings in 3D and turns every cell of a
// monospace grid into a character from a short, light ramp; the back of each ring fades, and the
// field softens behind the copy so the text always wins.
// Cheap by design: no blur in the loop (the glow is a CSS filter), 25 frames a second, paused
// when the tab or the canvas is out of view, one still frame under prefers-reduced-motion.
// GimbalAscii.mount(canvas, { cx, cy, size, quiet: [elements], still, t })
//   cx, cy: centre of the gimbal as a fraction of the canvas; size: outer radius as a fraction of its height.
(() => {
  const RAMP = ' .:*+co';                         // printable ASCII, light to dense (the WebGL version's ramp, shortened)
  const FONT = '400 10px "Gimbal Mono", ui-monospace, monospace';
  const CW = 6, CH = 11;
  const INK = '242,242,240', LEVEL = '0,236,151';

  const market = t => Math.sin(t * 0.33) * 0.6 + Math.sin(t * 0.13 + 1.3) * 0.3 + Math.sin(t * 0.71 + 0.4) * 0.1;
  const rot = (p, ax, a) => {
    const [x, y, z] = p, c = Math.cos(a), s = Math.sin(a);
    if (ax === 0) return [x, y * c - z * s, y * s + z * c];
    if (ax === 1) return [x * c + z * s, y, -x * s + z * c];
    return [x * c - y * s, x * s + y * c, z];
  };
  const view = p => rot(rot(p, 0, -0.38), 1, 0.3);
  const LIGHT = (() => { const l = [-0.45, 0.75, -0.5], n = Math.hypot(...l); return l.map(v => v / n); })();

  async function mount(canvas, opt = {}) {
    await document.fonts.load(FONT);
    if (opt.signal?.aborted || !canvas.isConnected) return;   // the page moved on while the font loaded
    const ctx = canvas.getContext('2d');
    let W, H, k, cols, rows, n, lum, depth, kind, zb, quiet = [];
    let sA, sG, held, sKind;                       // per-cell state carried between frames, so nothing flickers

    function size() {
      k = Math.min(2, window.devicePixelRatio || 1);
      W = canvas.clientWidth; H = canvas.clientHeight;
      canvas.width = W * k; canvas.height = H * k;
      cols = Math.ceil(W / CW); rows = Math.ceil(H / CH); n = cols * rows;
      lum = new Float32Array(n); depth = new Float32Array(n); kind = new Uint8Array(n); zb = new Float32Array(n);
      sA = new Float32Array(n); sG = new Float32Array(n); held = new Uint8Array(n); sKind = new Uint8Array(n);
      const c = canvas.getBoundingClientRect();
      quiet = [].concat(opt.quiet || []).map(el => el.getBoundingClientRect())
        .map(q => ({ x0: (q.left - c.left) / CW, x1: (q.right - c.left) / CW, y0: (q.top - c.top) / CH, y1: (q.bottom - c.top) / CH }));
    }
    const hush = (x, y) => {
      let h = 1;
      for (const q of quiet) {
        const dx = Math.max(q.x0 - x, 0, x - q.x1), dy = Math.max(q.y0 - y, 0, y - q.y1);
        h = Math.min(h, 0.12 + Math.hypot(dx / 10, dy / 3.5) * 0.3);
      }
      return Math.min(1, h);
    };

    function field(t) {
      lum.fill(0); kind.fill(0); zb.fill(1e9);
      const m1 = market(t), m2 = market(t * 1.37 + 5), m3 = market(t * 0.83 + 11);
      const cx = W * (opt.cx ?? 0.5), cy = H * (opt.cy ?? 0.5), S = H * (opt.size ?? 0.4), D = 4.2;
      const plot = (p, nn, kk, shade) => {
        p = view(p); nn = view(nn);
        const f = S * D / (p[2] + D);
        const ci = Math.floor((cx + p[0] * f) / CW), ri = Math.floor((cy - p[1] * f) / CH);
        if (ci < 0 || ri < 0 || ci >= cols || ri >= rows) return;
        const i = ri * cols + ci;
        if (p[2] >= zb[i]) return;
        zb[i] = p[2];
        const d = Math.abs(nn[0] * LIGHT[0] + nn[1] * LIGHT[1] + nn[2] * LIGHT[2]);
        lum[i] = shade === undefined ? 0.18 + 0.82 * d * d : shade;
        depth[i] = Math.min(1, Math.max(0, (p[2] + 1.1) / 2.2));
        kind[i] = kk;
      };
      // sampling follows the drawn size, so a big gimbal stays unbroken and a small one stays cheap
      const da = Math.max(0.003, 1.4 * CW / (S * 1.0));
      const ring = (R, r, ang) => {
        for (let a = 0; a < 6.2832; a += da) {
          const ca = Math.cos(a), sa = Math.sin(a);
          for (let b = 0; b < 6.2832; b += 0.42) {
            const cb = Math.cos(b), sb = Math.sin(b);
            let p = [(R + r * cb) * ca, (R + r * cb) * sa, r * sb], q = [cb * ca, cb * sa, sb];
            for (const [ax, an] of ang) { p = rot(p, ax, an); q = rot(q, ax, an); }
            plot(p, q, 0);
          }
        }
      };
      const a1 = m1 * 0.85, a2 = m2 * 0.7 + t * 0.06, a3 = m3 * 0.6;
      ring(1.0, 0.035, [[0, Math.PI / 2], [1, a1]]);
      ring(0.82, 0.035, [[1, Math.PI / 2], [1, a1], [0, a2]]);
      ring(0.64, 0.035, [[0, a3], [1, a1], [0, a2]]);
      // the platform never tilts: a fine dot field with a brighter rim
      const dr = Math.max(0.006, 1.2 * CH / S);
      for (let r = 0; r <= 0.44; r += dr) {
        const shade = r > 0.41 ? 0.95 : 0.3;     // an even plate with a bright rim: it never shimmers
        for (let a = 0; a < 6.2832; a += (0.9 * CW / S) / Math.max(r, 0.05)) plot([r * Math.cos(a), 0, r * Math.sin(a)], [0, 1, 0], 1, shade);
      }
    }

    // rate 1 draws the frame as computed (stills); below 1 every cell eases toward its new value,
    // so characters fade in and out over a few frames instead of popping
    function frame(t, rate = 0.3) {
      field(t);
      ctx.setTransform(k, 0, 0, k, 0, 0);
      ctx.clearRect(0, 0, W, H);                  // transparent, so the CSS glow follows the glyphs
      ctx.font = FONT; ctx.textBaseline = 'top';
      let last = '';
      const top = RAMP.length - 1;
      for (let i = 0; i < n; i++) {
        const L = lum[i], lit = L >= 0.06;
        const c = i % cols, r = (i / cols) | 0;
        const targetA = lit ? (0.16 + 0.74 * (1 - depth[i])) * (0.3 + 0.7 * L) * hush(c, r) : 0;
        if (lit) { sKind[i] = kind[i]; sG[i] += ((1 + L * (top - 1)) - sG[i]) * rate; }
        sA[i] += (targetA - sA[i]) * rate;
        if (sA[i] < 0.03) continue;
        // hysteresis: the character changes only when the light has clearly moved to another step
        if (!held[i] || Math.abs(sG[i] - (held[i] + 0.5)) > 0.85 || rate === 1) held[i] = Math.max(1, Math.min(top, Math.floor(sG[i])));
        const style = `rgba(${sKind[i] ? LEVEL : INK},${(Math.round(sA[i] * 24) / 24).toFixed(3)})`;
        if (style !== last) { ctx.fillStyle = style; last = style; }
        ctx.fillText(RAMP[held[i]], c * CW, r * CH);
      }
    }

    size();
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const t0 = performance.now() - (opt.t || 0) * 1000;
    window.__gimbalFrame = frame;                // lets a recorder step through time frame by frame
    if (reduce || opt.still) { frame(opt.t || 0, 1); return; }
    let running = true, seen = true, hidden = false, lastT = 0, dead = false, io = null;
    // Stops when the canvas leaves the page or the caller aborts (see gimbal-fx.js).
    const stop = () => {
      if (dead) return;
      dead = true; running = false;
      document.removeEventListener('visibilitychange', onVisible);
      removeEventListener('resize', onResize);
      if (io) io.disconnect();
    };
    const onVisible = () => { hidden = document.hidden; go(); };
    const onResize = () => { if (canvas.isConnected) size(); };
    const loop = now => {
      if (!running || dead) return;
      if (!canvas.isConnected || opt.signal?.aborted) { stop(); return; }
      if (now - lastT > 40) { frame((now - t0) / 1000); lastT = now; }   // 25 fps: the swing is slow
      requestAnimationFrame(loop);
    };
    const go = () => { if (dead) return; const r = seen && !hidden; if (r && !running) { running = true; requestAnimationFrame(loop); } running = r; };
    document.addEventListener('visibilitychange', onVisible);
    if ('IntersectionObserver' in window) { io = new IntersectionObserver(e => { seen = e[0].isIntersecting; go(); }); io.observe(canvas); }
    addEventListener('resize', onResize);
    if (opt.signal) opt.signal.addEventListener('abort', stop);
    requestAnimationFrame(loop);
  }

  window.GimbalAscii = { mount };
})();

// Gimbal FX: the Welcome gimbal rendered on the GPU and turned into ASCII by a shader.
//   1. scene  — ray-marches a working three-axis gimbal (rings on axles, solved so the platform stays exactly
//               level) and the platform with its level rings and bubble, lit with a key light, specular, rim
//               and ambient occlusion; supersampled inside each character cell.
//   2. blend  — eases every cell toward its new value (no flicker) or, for phosphor, keeps a fading trail.
//   3. ascii  — draws each cell as a glyph from an atlas set in Geist Mono, plus a soft optical glow.
// Looks: 'lit' (shaded volume), 'edges' (directional outline glyphs), 'phosphor' (long-exposure trails).
// GimbalFX.mount(canvas, { look, cx, cy, size, quiet: [elements], still, t }) → false if WebGL2 is missing.
(() => {
  const CW = 6, CH = 11;                            // character cell in CSS px
  // fill glyphs, printable ASCII only, chosen by measured ink in Geist Mono so each step adds about the
  // same amount (from .026 to .362 of the cell); no - _ = | ~, which line up into stripes
  const RAMP = ' .:*+coa#8@';
  const EDGE = '-/|\\';                             // outline glyphs by direction
  const GLYPHS = RAMP + EDGE;                       // atlas order: fill 0-10, outline 11-14

  const market = t => Math.sin(t * 0.33) * 0.6 + Math.sin(t * 0.13 + 1.3) * 0.3 + Math.sin(t * 0.71 + 0.4) * 0.1;
  const rotM = (ax, a) => {
    const c = Math.cos(a), s = Math.sin(a);
    return ax === 0 ? [1, 0, 0, 0, c, -s, 0, s, c] : ax === 1 ? [c, 0, s, 0, 1, 0, -s, 0, c] : [c, -s, 0, s, c, 0, 0, 0, 1];
  };
  const mul = (A, B) => { const R = []; for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) R[i * 3 + j] = A[i * 3] * B[j] + A[i * 3 + 1] * B[3 + j] + A[i * 3 + 2] * B[6 + j]; return R; };
  // world = R_n … R_1 · local; uploading the row-major result makes GLSL see its transpose, the inverse
  const orient = list => list.reduce((M, [ax, an]) => mul(rotM(ax, an), M), [1, 0, 0, 0, 1, 0, 0, 0, 1]);
  // A real three-axis gimbal. The market rocks the outer ring (attitude A). The other rings turn on their
  // axles — middle about the outer's X, inner about the middle's Y, platform about the inner's Z — by exactly
  // the angles that cancel A, so the platform stays perfectly level: A · Rx(a) · Ry(b) · Rz(c) = I.
  const T = R => [R[0], R[3], R[6], R[1], R[4], R[7], R[2], R[5], R[8]];
  const apply = (R, v) => [R[0] * v[0] + R[1] * v[1] + R[2] * v[2], R[3] * v[0] + R[4] * v[1] + R[5] * v[2], R[6] * v[0] + R[7] * v[1] + R[8] * v[2]];
  const kinematics = t => {
    const A = mul(rotM(1, market(t) * 0.7), mul(rotM(0, market(t * 1.37 + 5) * 0.55), rotM(2, market(t * 0.83 + 11) * 0.6)));
    const R = T(A);                                         // what the three axle angles must add up to
    const b = Math.asin(Math.max(-1, Math.min(1, R[2]))), a = Math.atan2(-R[5], R[8]);
    const M = mul(A, rotM(0, a)), I = mul(mul(M, rotM(1, b)), rotM(1, Math.PI / 2));   // inner ring lies in its YZ plane
    const axle = (F, v, r0, r1) => [apply(F, v.map(x => x * r0)), apply(F, v.map(x => x * r1))];
    const ax = [
      ...axle(A, [1, 0, 0], 0.79, 1.03), ...axle(A, [-1, 0, 0], 0.79, 1.03),     // outer <-> middle, on X
      ...axle(M, [0, 1, 0], 0.61, 0.85), ...axle(M, [0, -1, 0], 0.61, 0.85),     // middle <-> inner, on Y
      [0, 0, 0.40], [0, 0, 0.67], [0, 0, -0.40], [0, 0, -0.67],                   // inner <-> platform, on Z (level)
    ];
    return { O: A, M, I, ax: new Float32Array(ax.flat()) };
  };

  const VS = `#version 300 es
  in vec2 p; void main() { gl_Position = vec4(p, 0.0, 1.0); }`;

  const SCENE = (ss) => `#version 300 es
  precision highp float;
  uniform vec2 uCellPx;        // cell size in device px
  uniform vec2 uCenter;        // gimbal centre in device px, bottom-left origin
  uniform float uFocal;        // focal length in device px
  uniform mat3 uR0, uR1, uR2;
  uniform vec3 uAx[12];        // six axles, as end-point pairs in world space
  uniform float uPolish;       // 1 for smooth renders: brighter, more mirror-like metal
  uniform float uTube;         // ring thickness (thicker for small sizes such as an avatar)
  out vec4 o;
  const vec3 RO = vec3(1.2081, 1.5524, -3.7954);   // camera: a little above and to the left, 4.2 away
  float torus(vec3 q, float R, float r) { return length(vec2(length(q.xy) - R, q.z)) - r; }
  float capsule(vec3 p, vec3 a, vec3 b, float r) { vec3 pa = p - a, ba = b - a; float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0); return length(pa - ba * h) - r; }
  // material: 0 ring or axle, 1 platform, 2 the bubble
  vec2 map(vec3 p) {
    float d = torus(uR0 * p, 1.0, uTube);
    d = min(d, torus(uR1 * p, 0.82, uTube));
    d = min(d, torus(uR2 * p, 0.64, uTube));
    for (int i = 0; i < 6; i++) d = min(d, capsule(p, uAx[2 * i], uAx[2 * i + 1], 0.022));
    float plate = length(vec2(max(length(p.xz) - 0.40, 0.0), max(abs(p.y) - 0.045, 0.0))) - 0.012;  // a puck
    float bubble = length(p - vec3(0.0, 0.05, 0.0)) - 0.075;                                          // sits dead centre
    vec2 r = vec2(d, 0.0);
    if (plate < r.x) r = vec2(plate, 1.0);
    if (bubble < r.x) r = vec2(bubble, 2.0);
    return r;
  }
  vec3 nrm(vec3 p) { vec2 e = vec2(0.0015, 0.0);
    return normalize(vec3(map(p + e.xyy).x - map(p - e.xyy).x, map(p + e.yxy).x - map(p - e.yxy).x, map(p + e.yyx).x - map(p - e.yyx).x)); }
  float ao(vec3 p, vec3 n) { float a = 0.0, w = 1.0;
    for (int i = 1; i <= 4; i++) { float h = 0.03 * float(i); a += w * (h - map(p + n * h).x); w *= 0.6; }
    return clamp(1.0 - 3.0 * a, 0.0, 1.0); }
  // returns vec3(light, platform, hit) for one ray through device pixel px
  vec3 shade(vec2 px) {
    vec3 fw = normalize(-RO), rt = normalize(cross(vec3(0, 1, 0), fw)), up = cross(fw, rt);
    vec3 rd = normalize(fw * uFocal + rt * (px.x - uCenter.x) + up * (px.y - uCenter.y));
    float t = 2.6; vec2 h = vec2(1.0, 0.0);
    for (int i = 0; i < 80; i++) { h = map(RO + rd * t); if (h.x < 0.0015 || t > 6.2) break; t += h.x; }
    if (h.x >= 0.0015) return vec3(0.0);
    vec3 p = RO + rd * t, n = nrm(p), v = -rd;
    vec3 L = normalize(vec3(-0.5, 0.85, -0.45));
    float dif = max(dot(n, L), 0.0) * 0.85 + 0.15;
    float spe = pow(max(dot(n, normalize(L + v)), 0.0), 40.0);
    float rim = pow(1.0 - max(dot(n, v), 0.0), 3.0);
    float occ = ao(p, n);
    float far = mix(1.0, 0.38, smoothstep(3.4, 5.2, t));     // the back of the gimbal sinks into the dark
    float l;
    if (h.y > 1.5) {
      // the bubble: glossy, the brightest thing on the plate
      l = 0.62 + 0.6 * pow(max(dot(n, normalize(L + v)), 0.0), 18.0) + 0.3 * rim;
    } else if (h.y > 0.5) {
      float r = length(p.xz);
      if (n.y > 0.6) {
        // top face: a broad sheen from the light's side, two engraved level rings, shadow where the rings pass
        float side = 0.5 + 0.5 * dot(normalize(p.xz + 1e-4), normalize(vec2(-0.6, 0.45)));
        float sheen = pow(max(dot(n, normalize(L + v)), 0.0), 3.0);
        l = 0.24 + 0.42 * side * smoothstep(0.08, 0.40, r) + 0.2 * sheen;
        float groove = min(abs(r - 0.18), abs(r - 0.31));
        l *= mix(0.22, 1.0, smoothstep(0.006, 0.02, groove)) * (0.55 + 0.45 * occ);
      } else {
        l = 0.3 + 0.5 * max(dot(n, L), 0.0) + 0.3 * rim;                  // the edge of the puck, so it has thickness
      }
      l *= far;
    } else {
      l = (0.06 + 0.62 * dif * occ + 0.55 * spe + 0.35 * rim) * far;
      // polished: a sharper highlight and a cool sky band along the top of each ring
      l += uPolish * (0.5 * pow(max(dot(n, normalize(L + v)), 0.0), 90.0) + 0.18 * smoothstep(0.2, 0.9, n.y) + 0.12 * rim) * far;
    }
    return vec3(clamp(l, 0.0, 1.0), h.y > 0.5 ? 1.0 : 0.0, 1.0);
  }
  void main() {
    vec2 cell = floor(gl_FragCoord.xy);
    float lum = 0.0, plat = 0.0; vec2 g = vec2(0.0); float hits = 0.0;
    const int S = ${ss};
    for (int j = 0; j < S; j++) for (int i = 0; i < S; i++) {
      vec2 f = (vec2(float(i), float(j)) + 0.5) / float(S);
      vec3 s = shade((cell + f) * uCellPx);
      lum += s.x; plat += s.y * s.z; hits += s.z;
      g += (f - 0.5) * s.z * (0.6 + 0.4 * s.x);              // where in the cell the surface sits
    }
    float n = float(S * S);
    lum /= n; plat = hits > 0.0 ? plat / hits : 0.0;
    // an outline crosses this cell when only part of it is covered; its direction is across the gradient
    float cover = hits / n;
    float edge = clamp(length(g) * 4.0 * (1.0 - abs(cover - 0.5) * 1.2), 0.0, 1.0);
    float ang = atan(g.y, g.x) + 1.5708;
    o = vec4(lum, plat, edge, fract(ang / 3.14159265 + 1.0));
  }`;


  // A black hole in the Gargantua mould: rays bend around a Schwarzschild mass (horizon radius 1), a thin
  // accretion disk lies perfectly level in y = 0, and lensing lifts the far side of the disk over the
  // shadow and under it. Matter swirls at Keplerian speed (the market); the disk plane never tilts.
  // The side moving toward the viewer is brighter (Doppler beaming); the hot inner edge glows green.
  const SCENE_HOLE = `#version 300 es
  precision highp float;
  uniform vec2 uCellPx, uCenter; uniform float uFocal, uT;
  out vec4 o;
  const vec3 RO = vec3(0.0, 2.3, -19.0);                   // about seven degrees above the disk, like the film
  float hash(vec2 q) { return fract(sin(dot(q, vec2(127.1, 311.7))) * 43758.5453); }
  float vnoise(vec2 q) { vec2 i = floor(q), f = fract(q); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y); }
  vec3 shade(vec2 px) {
    vec3 fw = normalize(-RO), rt = normalize(cross(vec3(0, 1, 0), fw)), up = cross(fw, rt);
    vec3 v = normalize(fw * uFocal + rt * (px.x - uCenter.x) + up * (px.y - uCenter.y));
    vec3 p = RO;
    float h2 = dot(cross(p, v), cross(p, v));
    float lum = 0.0, green = 0.0, closest = 1e9; int crossings = 0;
    for (int i = 0; i < 260; i++) {
      float r = length(p); closest = min(closest, r);
      if (r < 1.0) break;                                   // inside the horizon: black
      float dt = clamp(0.06 * r, 0.04, 0.9);
      vec3 q = p;
      v += -1.5 * h2 * p / pow(r, 5.0) * dt;                // the bend of light near a Schwarzschild mass
      p += v * dt;
      // the disk and its first lensed image; images from rays that grazed the photon sphere are thinner than a
      // character cell and only read as specks, so they are left out
      if (q.y * p.y < 0.0 && ++crossings <= 2 && !(crossings == 2 && closest < 1.9)) {
        vec3 c = mix(q, p, q.y / (q.y - p.y));
        float rr = length(c.xz);
        if (rr > 2.6 && rr < 12.0) {
          float ang = atan(c.z, c.x) + uT * 0.9 / pow(rr, 1.5);        // inner matter turns faster, all of it slowly
          float swirl = vnoise(vec2(ang * 3.8, rr * 1.4)) * 0.75 + vnoise(vec2(ang * 7.0, rr * 3.0)) * 0.25;   // broad bands, little grain
          float hot = pow(2.6 / rr, 1.05);
          vec3 vel = normalize(vec3(-c.z, 0.0, c.x));
          float beam = clamp(1.0 + 0.75 * dot(vel, -normalize(v)), 0.25, 1.9);
          float e = 1.5 * hot * (0.35 + 0.75 * swirl) * beam * smoothstep(12.0, 5.5, rr) * smoothstep(2.6, 3.1, rr);
          e *= 1.0 - lum * 0.6;
          lum += e;
          green += e * smoothstep(3.9, 2.8, rr);
        }
      }
      if (r > 32.0 && dot(p, v) > 0.0) break;
    }
    // a faint photon ring hugs the shadow's edge
    return vec3(clamp(lum, 0.0, 1.0), lum > 0.0 ? clamp(green / lum, 0.0, 1.0) : 0.0, 1.0);
  }
  void main() {
    vec2 cell = floor(gl_FragCoord.xy);
    vec3 s = shade((cell + 0.5) * uCellPx);
    o = vec4(s.x, s.y, 0.0, 0.0);
  }`;

  const BLEND = `#version 300 es
  precision highp float;
  uniform sampler2D uNew, uOld; uniform float uRate, uLive; uniform int uLook;
  out vec4 o;
  void main() {
    ivec2 c = ivec2(gl_FragCoord.xy);
    vec4 n = texelFetch(uNew, c, 0), p = texelFetch(uOld, c, 0);
    if (uLook == 2) {
      // phosphor: r is the live ring, eased like the other looks; b is the afterglow it leaves behind.
      // The glow takes at most 45% of the ring's light and halves in about half a second.
      float live = mix(p.r, n.r, uLive);
      float glow = max(n.r * (1.0 - n.g) * 0.45, p.b * 0.93);
      o = vec4(live, mix(p.g, n.g, uLive), glow, n.a);
    } else {
      vec4 m = mix(p, n, uRate);
      m.a = n.b > 0.15 ? n.a : p.a;                           // keep the last good outline direction
      o = m;
    }
  }`;

  const ASCII = `#version 300 es
  precision highp float;
  uniform sampler2D uCells, uAtlas;
  uniform vec2 uCellPx, uGrid; uniform int uLook; uniform float uGlyphs;
  uniform vec4 uQuiet[2]; uniform int uQuietN; uniform float uGain; uniform int uSmooth;
  out vec4 o;
  const vec3 INK = vec3(0.949, 0.949, 0.941), LEVEL = vec3(0.0, 0.925, 0.592), COOL = vec3(0.50, 0.58, 0.64);
  float hush(vec2 c) { float h = 1.0;
    for (int i = 0; i < 2; i++) { if (i >= uQuietN) break; vec4 q = uQuiet[i];
      vec2 d = max(max(q.xy - c, c - q.zw), 0.0); h = min(h, 0.04 + length(d / vec2(10.0, 3.5)) * 0.24); }
    return clamp(h, 0.0, 1.0); }
  float glyph(float idx, vec2 local) {
    vec2 uv = vec2((idx + local.x) / uGlyphs, 1.0 - local.y);
    return texture(uAtlas, uv).r;
  }
  void main() {
    vec2 cf = gl_FragCoord.xy / uCellPx; ivec2 c = ivec2(floor(cf)); vec2 local = fract(cf);
    vec4 d = texelFetch(uCells, c, 0);
    float hu = hush(vec2(c) + 0.5);
    float lum = d.r, plat = d.g;
    float idx = 0.0, bright = 0.0;
    if (uLook == 1) {
      if (d.b > 0.3) {                                       // outline: pick the glyph that follows the edge
        idx = 11.0 + mod(floor(d.a * 4.0 + 0.5), 4.0); bright = 0.55 + 0.45 * lum;
      } else if (lum > 0.04) { idx = 1.0 + floor(clamp(lum, 0.0, 1.0) * 3.0); bright = 0.35 + 0.3 * lum; }
    } else if (uLook == 2) {
      if (lum > 0.06) { idx = 1.0 + floor(clamp(lum, 0.0, 0.999) * 10.0); bright = 0.3 + 0.7 * lum; }
      // afterglow: only the two lightest glyphs, . and :, cooling as they fade
      else if (d.b > 0.03) { idx = 1.0 + floor(clamp(d.b / 0.45, 0.0, 0.999) * 2.0); bright = 0.25 + 1.2 * d.b; }
    } else if (lum > 0.06) {
      idx = 1.0 + floor(clamp(lum, 0.0, 0.999) * 10.0); bright = 0.25 + 0.75 * lum;
    }
    vec3 col = mix(INK, LEVEL, plat);
    if (uSmooth == 1) { float v = clamp(lum * uGain, 0.0, 1.0) * hu; o = vec4(col * v, v); return; }
    if (uLook == 2 && lum <= 0.06) col = mix(COOL * 0.8, mix(COOL, INK, 0.35), clamp(d.b / 0.45, 0.0, 1.0));
    float a = idx > 0.0 ? glyph(idx, local) * min(1.0, bright * uGain) * hu : 0.0;
    // optical glow: the cell field, linearly filtered, under the glyphs
    vec4 lin = texture(uCells, cf / uGrid);
    float halo = (lin.r + (uLook == 2 ? lin.b * 0.5 : 0.0)) * (uLook == 1 ? 0.10 : 0.16) * hu;
    vec3 rgb = col * a + col * halo * (1.0 - a);
    float alpha = clamp(a + halo * (1.0 - a), 0.0, 1.0);
    o = vec4(rgb, alpha);
  }`;

  function compile(gl, vs, fs) {
    const pr = gl.createProgram();
    for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) {
      const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      gl.attachShader(pr, s);
    }
    gl.linkProgram(pr);
    if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(pr));
    return pr;
  }

  async function mount(canvas, opt = {}) {
    // opt.cell: [w, h] of a character cell in CSS px (bigger for small displays such as social images);
    // opt.smooth: draw the light itself, no glyphs (cell becomes one device pixel)
    const smooth = !!opt.smooth;
    let [CW, CH] = opt.cell || [6, 11];
    const gl = canvas.getContext('webgl2', { premultipliedAlpha: true, alpha: true, antialias: false });
    if (!gl) return false;
    await document.fonts.load('400 10px "Gimbal Mono"');
    if (opt.signal?.aborted || !canvas.isConnected) return true;   // the page moved on while the font loaded
    const hole = opt.look === 'hole';                       // the black hole is drawn the phosphor way
    const look = { lit: 0, edges: 1, phosphor: 2, hole: 2 }[opt.look || 'lit'];
    const progScene = compile(gl, VS, hole ? SCENE_HOLE : SCENE(look === 1 ? 3 : 2));
    const progBlend = compile(gl, VS, BLEND), progAscii = compile(gl, VS, ASCII);
    const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    for (const pr of [progScene, progBlend, progAscii]) { const l = gl.getAttribLocation(pr, 'p'); gl.enableVertexAttribArray(l); gl.vertexAttribPointer(l, 2, gl.FLOAT, false, 0, 0); }

    let W, H, k, cols, rows, tex = [], fbs = [], atlas, quiet = [], cur = 0;
    const mkTex = (w, h, filter) => {
      const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return t;
    };
    function size() {
      k = opt.k || Math.min(2, window.devicePixelRatio || 1);   // opt.k: a fixed pixel ratio for exports
      if (smooth) { CW = 1 / k; CH = 1 / k; }
      W = canvas.clientWidth; H = canvas.clientHeight;
      canvas.width = Math.round(W * k); canvas.height = Math.round(H * k);
      cols = Math.ceil(W / CW); rows = Math.ceil(H / CH);
      tex = [0, 1, 2].map(() => mkTex(cols, rows, gl.LINEAR));      // 0: fresh scene, 1 and 2: blended ping-pong
      fbs = tex.map(t => { const f = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, f); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0); return f; });
      // glyph atlas: every glyph in one row, drawn white in Geist Mono at the cell's device size
      const cw = Math.max(1, Math.round(CW * k)), ch = Math.max(1, Math.round(CH * k));
      const ac = document.createElement('canvas'); ac.width = cw * GLYPHS.length; ac.height = ch;
      const x = ac.getContext('2d'); x.fillStyle = '#fff'; x.font = `400 ${Math.round(CW / 0.6 * k)}px "Gimbal Mono", ui-monospace, monospace`;   // Geist Mono advance is 0.6 em
      x.textBaseline = 'middle'; x.textAlign = 'center';
      [...GLYPHS].forEach((g, i) => x.fillText(g, i * cw + cw / 2, ch / 2 + 0.5 * k));
      atlas = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, atlas);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, ac);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const cr = canvas.getBoundingClientRect();
      quiet = [].concat(opt.quiet || []).slice(0, 2).map(el => el.getBoundingClientRect())
        .map(q => [(q.left - cr.left) / CW, (cr.bottom - q.bottom) / CH, (q.right - cr.left) / CW, (cr.bottom - q.top) / CH]);
    }

    function frame(t, rate = 0.35) {
      const K = kinematics(t);
      // 1. scene into texture 0, one fragment per character cell
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbs[0]); gl.viewport(0, 0, cols, rows); gl.useProgram(progScene);
      const u = n => gl.getUniformLocation(progScene, n);
      gl.uniform2f(u('uCellPx'), CW * k, CH * k);
      gl.uniform2f(u('uCenter'), W * k * (opt.cx ?? 0.5), H * k * (1 - (opt.cy ?? 0.5)));
      // the gimbal's outer ring has radius 1 at distance 4.2; the black hole's disk ends at radius 9.5, 19 away
      gl.uniform1f(u('uFocal'), H * k * (opt.size ?? 0.4) * (hole ? 19 / 9.5 : 4.2));
      if (hole) gl.uniform1f(u('uT'), t);
      gl.uniformMatrix3fv(u('uR0'), false, K.O); gl.uniformMatrix3fv(u('uR1'), false, K.M); gl.uniformMatrix3fv(u('uR2'), false, K.I);
      gl.uniform3fv(u('uAx'), K.ax); gl.uniform1f(u('uTube'), opt.tube || 0.045); gl.uniform1f(u('uPolish'), smooth ? 1 : 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      // 2. blend into the other ping-pong texture
      const src = 1 + cur, dst = 2 - cur; cur = 1 - cur;
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbs[dst]); gl.useProgram(progBlend);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tex[0]);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, tex[src]);
      gl.uniform1i(gl.getUniformLocation(progBlend, 'uNew'), 0); gl.uniform1i(gl.getUniformLocation(progBlend, 'uOld'), 1);
      gl.uniform1f(gl.getUniformLocation(progBlend, 'uRate'), rate); gl.uniform1i(gl.getUniformLocation(progBlend, 'uLook'), look);
      gl.uniform1f(gl.getUniformLocation(progBlend, 'uLive'), hole ? 0.4 : 0.65);   // the swirl eases more gently
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      // 3. ascii to the screen
      gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT); gl.useProgram(progAscii);
      const a = n => gl.getUniformLocation(progAscii, n);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tex[dst]);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, atlas);
      gl.uniform1i(a('uCells'), 0); gl.uniform1i(a('uAtlas'), 1);
      gl.uniform2f(a('uCellPx'), CW * k, CH * k); gl.uniform2f(a('uGrid'), cols, rows);
      gl.uniform1i(a('uLook'), look); gl.uniform1f(a('uGlyphs'), GLYPHS.length);
      gl.uniform1f(a('uGain'), opt.gain || 1);              // exposure: avatars need more than the site
      gl.uniform1i(a('uSmooth'), smooth ? 1 : 0);
      gl.uniform1i(a('uQuietN'), quiet.length);
      if (quiet.length) gl.uniform4fv(a('uQuiet'), new Float32Array([].concat(...quiet, ...(quiet.length < 2 ? [[0, 0, 0, 0]] : []))));
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    size();
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    window.__fxFrame = frame;
    if (reduce || opt.still) { const n = look === 2 ? 60 : 1; for (let i = 0; i < n; i++) frame((opt.t || 0) - (n - 1 - i) / 25, look === 2 ? 0.35 : 1); return true; }
    const t0 = performance.now() - (opt.t || 0) * 1000;
    let running = true, seen = true, hidden = false, dead = false, io = null;
    // The page is a React app: the canvas is removed when the owner leaves Welcome. Stop then, or the loop would go on
    // drawing into a canvas nobody sees. `opt.signal` lets the caller stop it by hand as well (StrictMode mounts twice).
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
      frame((now - t0) / 1000);
      requestAnimationFrame(loop);
    };
    const go = () => { if (dead) return; const r = seen && !hidden; if (r && !running) { running = true; requestAnimationFrame(loop); } running = r; };
    document.addEventListener('visibilitychange', onVisible);
    if ('IntersectionObserver' in window) { io = new IntersectionObserver(e => { seen = e[0].isIntersecting; go(); }); io.observe(canvas); }
    addEventListener('resize', onResize);
    if (opt.signal) opt.signal.addEventListener('abort', stop);
    requestAnimationFrame(loop);
    return true;
  }

  window.GimbalFX = { mount };
})();

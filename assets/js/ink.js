/* Foylan v3: living ink.
   A stable-fluids solver on the GPU. Dye is stored as absorbance and shown with
   Beer-Lambert mixing over paper, so inks combine like pigment, not light.
   Pointer movement stirs the basin; pressing (or touch) drops the active pigment.
   Falls back to a still image when WebGL float targets are unavailable or the
   visitor prefers reduced motion (a pre-rolled frame is drawn once instead). */
(() => {
  const canvas = document.getElementById('ink');
  if (!canvas) return;
  const root = document.documentElement;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const fail = () => { root.classList.add('no-ink'); };

  const PAPER = [0.957, 0.961, 0.965];
  const PIGMENTS = {
    red: [0.851, 0.016, 0.161],
    black: [0.07, 0.08, 0.1],
    indigo: [0.04, 0.1, 0.2],
  };
  // Smaller screens hold the same pours in less area, so they get thinner ink.
  const DENS = Math.min(1, Math.max(0.38, (innerWidth * innerHeight) / (1440 * 900)));
  const absorb = (rgb, k) => rgb.map((c) => (1 - c) * k * DENS);
  const hexToRgb = (hex) => {
    const n = parseInt(hex.replace('#', ''), 16);
    return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255];
  };

  /* ---------- context ---------- */
  const params = { alpha: false, depth: false, stencil: false, antialias: false, preserveDrawingBuffer: false };
  let gl = canvas.getContext('webgl2', params);
  const isGL2 = !!gl;
  if (!gl) gl = canvas.getContext('webgl', params) || canvas.getContext('experimental-webgl', params);
  if (!gl) return fail();

  let halfFloat, linear, internal;
  if (isGL2) {
    if (!gl.getExtension('EXT_color_buffer_float') && !gl.getExtension('EXT_color_buffer_half_float')) return fail();
    halfFloat = gl.HALF_FLOAT;
    linear = !!gl.getExtension('OES_texture_float_linear') || true; // half-float linear filtering is core in WebGL2
    internal = gl.RGBA16F;
  } else {
    const hf = gl.getExtension('OES_texture_half_float');
    if (!hf) return fail();
    halfFloat = hf.HALF_FLOAT_OES;
    linear = !!gl.getExtension('OES_texture_half_float_linear');
    internal = gl.RGBA;
  }

  /* ---------- shaders ---------- */
  const VERT = `
    precision highp float;
    attribute vec2 aPosition;
    varying vec2 vUv, vL, vR, vT, vB;
    uniform vec2 texelSize;
    void main () {
      vUv = aPosition * 0.5 + 0.5;
      vL = vUv - vec2(texelSize.x, 0.0);
      vR = vUv + vec2(texelSize.x, 0.0);
      vT = vUv + vec2(0.0, texelSize.y);
      vB = vUv - vec2(0.0, texelSize.y);
      gl_Position = vec4(aPosition, 0.0, 1.0);
    }`;

  const FRAG = {
    splat: `
      precision highp float;
      varying vec2 vUv;
      uniform sampler2D uTarget;
      uniform float aspectRatio, radius;
      uniform vec3 color;
      uniform vec2 point;
      void main () {
        vec2 p = vUv - point;
        p.x *= aspectRatio;
        vec3 splat = exp(-dot(p, p) / radius) * color;
        gl_FragColor = vec4(texture2D(uTarget, vUv).xyz + splat, 1.0);
      }`,
    advection: `
      precision highp float;
      varying vec2 vUv;
      uniform sampler2D uVelocity, uSource;
      uniform vec2 texelSize, dyeTexelSize;
      uniform float dt, dissipation;
      vec4 bilerp (sampler2D sam, vec2 uv, vec2 tsize) {
        vec2 st = uv / tsize - 0.5;
        vec2 i = floor(st);
        vec2 f = fract(st);
        vec4 a = texture2D(sam, (i + vec2(0.5, 0.5)) * tsize);
        vec4 b = texture2D(sam, (i + vec2(1.5, 0.5)) * tsize);
        vec4 c = texture2D(sam, (i + vec2(0.5, 1.5)) * tsize);
        vec4 d = texture2D(sam, (i + vec2(1.5, 1.5)) * tsize);
        return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
      }
      void main () {
      #ifdef MANUAL_FILTERING
        vec2 coord = vUv - dt * bilerp(uVelocity, vUv, texelSize).xy * texelSize;
        vec4 result = bilerp(uSource, coord, dyeTexelSize);
      #else
        vec2 coord = vUv - dt * texture2D(uVelocity, vUv).xy * texelSize;
        vec4 result = texture2D(uSource, coord);
      #endif
        gl_FragColor = result / (1.0 + dissipation * dt);
      }`,
    divergence: `
      precision mediump float;
      varying vec2 vUv, vL, vR, vT, vB;
      uniform sampler2D uVelocity;
      void main () {
        float L = texture2D(uVelocity, vL).x;
        float R = texture2D(uVelocity, vR).x;
        float T = texture2D(uVelocity, vT).y;
        float B = texture2D(uVelocity, vB).y;
        vec2 C = texture2D(uVelocity, vUv).xy;
        if (vL.x < 0.0) L = -C.x;
        if (vR.x > 1.0) R = -C.x;
        if (vT.y > 1.0) T = -C.y;
        if (vB.y < 0.0) B = -C.y;
        gl_FragColor = vec4(0.5 * (R - L + T - B), 0.0, 0.0, 1.0);
      }`,
    curl: `
      precision mediump float;
      varying vec2 vUv, vL, vR, vT, vB;
      uniform sampler2D uVelocity;
      void main () {
        float L = texture2D(uVelocity, vL).y;
        float R = texture2D(uVelocity, vR).y;
        float T = texture2D(uVelocity, vT).x;
        float B = texture2D(uVelocity, vB).x;
        gl_FragColor = vec4(0.5 * (R - L - T + B), 0.0, 0.0, 1.0);
      }`,
    vorticity: `
      precision highp float;
      varying vec2 vUv, vL, vR, vT, vB;
      uniform sampler2D uVelocity, uCurl;
      uniform float curl, dt;
      void main () {
        float L = texture2D(uCurl, vL).x;
        float R = texture2D(uCurl, vR).x;
        float T = texture2D(uCurl, vT).x;
        float B = texture2D(uCurl, vB).x;
        float C = texture2D(uCurl, vUv).x;
        vec2 force = 0.5 * vec2(abs(T) - abs(B), abs(R) - abs(L));
        force /= length(force) + 0.0001;
        force *= curl * C;
        force.y *= -1.0;
        vec2 vel = texture2D(uVelocity, vUv).xy + force * dt;
        gl_FragColor = vec4(clamp(vel, -1000.0, 1000.0), 0.0, 1.0);
      }`,
    pressure: `
      precision mediump float;
      varying vec2 vUv, vL, vR, vT, vB;
      uniform sampler2D uPressure, uDivergence;
      void main () {
        float L = texture2D(uPressure, vL).x;
        float R = texture2D(uPressure, vR).x;
        float T = texture2D(uPressure, vT).x;
        float B = texture2D(uPressure, vB).x;
        float div = texture2D(uDivergence, vUv).x;
        gl_FragColor = vec4((L + R + B + T - div) * 0.25, 0.0, 0.0, 1.0);
      }`,
    gradient: `
      precision mediump float;
      varying vec2 vUv, vL, vR, vT, vB;
      uniform sampler2D uPressure, uVelocity;
      void main () {
        float L = texture2D(uPressure, vL).x;
        float R = texture2D(uPressure, vR).x;
        float T = texture2D(uPressure, vT).x;
        float B = texture2D(uPressure, vB).x;
        vec2 vel = texture2D(uVelocity, vUv).xy - vec2(R - L, T - B);
        gl_FragColor = vec4(vel, 0.0, 1.0);
      }`,
    clear: `
      precision mediump float;
      varying vec2 vUv;
      uniform sampler2D uTexture;
      uniform float value;
      void main () { gl_FragColor = value * texture2D(uTexture, vUv); }`,
    display: `
      precision highp float;
      varying vec2 vUv;
      uniform sampler2D uTexture;
      uniform vec3 paper;
      uniform vec4 uCalm[8];
      uniform vec2 uView;
      float hash (vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
      float vnoise (vec2 p) {
        vec2 i = floor(p), f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
      }
      float dens (vec2 uv) { vec3 a = texture2D(uTexture, uv).rgb; return max(a.r, max(a.g, a.b)); }
      void main () {
        vec3 a = max(texture2D(uTexture, vUv).rgb, 0.0);
        float m = max(a.r, max(a.g, a.b));
        vec3 hue = a / max(m, 0.0001);
        // Suminagashi rings: isolines of density, drawn about one screen pixel wide.
        const float K = 2.4;
        vec2 px1 = 1.0 / uView;
        float gx = dens(vUv + vec2(px1.x, 0.0)) - dens(vUv - vec2(px1.x, 0.0));
        float gy = dens(vUv + vec2(0.0, px1.y)) - dens(vUv - vec2(0.0, px1.y));
        float pw = max(length(vec2(gx, gy)) * 0.5 * K, 0.0005);   // ring spacing per pixel
        float f = fract(m * K);
        float dist = min(f, 1.0 - f) / pw;                          // distance to ring in pixels
        float line = 1.0 - smoothstep(0.45, 1.35, dist);
        line *= smoothstep(0.05, 0.16, m);
        line *= 1.0 - smoothstep(0.18, 0.4, pw);                    // rings packed tighter than ~3px fade out: no moire
        line *= 1.0 - 0.75 * smoothstep(1.4, 2.6, m);
        float wash = smoothstep(0.08, 0.9, m) * 0.13;
        float amount = max(line * 0.95, wash);
        vec2 e = smoothstep(vec2(0.0), vec2(0.06), vUv) * smoothstep(vec2(0.0), vec2(0.06), 1.0 - vUv);
        amount *= e.x * e.y;
        // Resist: rounded, feathered, noise-edged zones around text, so ink thins organically.
        vec2 p = vec2(vUv.x, 1.0 - vUv.y) * uView;
        float calm = 0.0;
        float wobble = vnoise(p * 0.012) * 70.0;
        for (int i = 0; i < 8; i++) {
          vec4 r = uCalm[i];
          if (r.z <= r.x) continue;
          vec2 c = (r.xy + r.zw) * 0.5, hsz = (r.zw - r.xy) * 0.5;
          vec2 q = abs(p - c) - hsz + 40.0;
          float sdf = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - 40.0;
          calm = max(calm, 1.0 - smoothstep(-20.0, 110.0 + wobble, sdf));
        }
        amount *= 1.0 - calm;
        vec3 col = paper * exp(-hue * amount * 2.6);
        float fiber = vnoise(gl_FragCoord.xy * 0.35) * 0.6 + hash(floor(gl_FragCoord.xy)) * 0.4;
        col -= (fiber - 0.5) * 0.028;
        gl_FragColor = vec4(col, 1.0);
      }`,
  };

  const compile = (type, src, defines = '') => {
    const s = gl.createShader(type);
    gl.shaderSource(s, defines + src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  };
  const vs = compile(gl.VERTEX_SHADER, VERT);
  const program = (fragSrc, defines) => {
    const p = gl.createProgram();
    gl.attachShader(p, vs);
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fragSrc, defines));
    gl.bindAttribLocation(p, 0, 'aPosition');
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    const u = {};
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) { const name = gl.getActiveUniform(p, i).name; u[name] = gl.getUniformLocation(p, name); }
    return { p, u };
  };

  let P;
  try {
    P = {
      splat: program(FRAG.splat),
      advection: program(FRAG.advection, linear ? '' : '#define MANUAL_FILTERING\n'),
      divergence: program(FRAG.divergence),
      curl: program(FRAG.curl),
      vorticity: program(FRAG.vorticity),
      pressure: program(FRAG.pressure),
      gradient: program(FRAG.gradient),
      clear: program(FRAG.clear),
      display: program(FRAG.display),
    };
  } catch (e) { return fail(); }

  /* ---------- geometry ---------- */
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, -1, 1, 1, 1, 1, -1]), gl.STATIC_DRAW);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array([0, 1, 2, 0, 2, 3]), gl.STATIC_DRAW);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.enableVertexAttribArray(0);

  const blit = (target) => {
    if (target) { gl.viewport(0, 0, target.w, target.h); gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo); }
    else { gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight); gl.bindFramebuffer(gl.FRAMEBUFFER, null); }
    gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
  };

  /* ---------- render targets ---------- */
  const fbo = (w, h, filter) => {
    gl.activeTexture(gl.TEXTURE0);
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, gl.RGBA, halfFloat, null);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    return { tex, fbo: fb, w, h, ok, attach (id) { gl.activeTexture(gl.TEXTURE0 + id); gl.bindTexture(gl.TEXTURE_2D, tex); return id; } };
  };
  const double = (w, h, filter) => {
    let a = fbo(w, h, filter), b = fbo(w, h, filter);
    return { w, h, ok: a.ok && b.ok, get read () { return a; }, get write () { return b; }, swap () { [a, b] = [b, a]; } };
  };

  const res = (base) => {
    const aspect = innerWidth / innerHeight;
    const min = Math.round(base), max = Math.round(base * Math.max(aspect, 1 / aspect));
    return aspect > 1 ? { w: max, h: min } : { w: min, h: max };
  };

  const small = matchMedia('(max-width: 760px)').matches;
  const CFG = {
    sim: small ? 96 : 128,
    dye: small ? 512 : 1024,
    pressureIters: 20,
    curl: 3,
    velDissipation: 0.35,
    dyeDissipation: 0.06,
    radius: 0.00055,
    force: 4200,
  };

  let velocity, dye, divergence, curlT, pressure;
  const filter = linear ? gl.LINEAR : gl.NEAREST;
  const init = () => {
    const s = res(CFG.sim), d = res(CFG.dye);
    velocity = double(s.w, s.h, filter);
    dye = double(d.w, d.h, filter);
    divergence = fbo(s.w, s.h, gl.NEAREST);
    curlT = fbo(s.w, s.h, gl.NEAREST);
    pressure = double(s.w, s.h, gl.NEAREST);
    return velocity.ok && dye.ok && divergence.ok && pressure.ok;
  };

  const resizeCanvas = () => {
    const dpr = Math.min(devicePixelRatio || 1, 1.5);
    const w = Math.floor(canvas.clientWidth * dpr), h = Math.floor(canvas.clientHeight * dpr);
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; return true; }
    return false;
  };
  resizeCanvas();
  if (!init()) return fail();

  /* ---------- simulation ---------- */
  const use = (prog) => { gl.useProgram(prog.p); return prog.u; };

  const splat = (x, y, dx, dy, color, radiusScale = 1) => {
    const aspect = canvas.width / canvas.height;
    let u = use(P.splat);
    gl.uniform1i(u.uTarget, velocity.read.attach(0));
    gl.uniform1f(u.aspectRatio, aspect);
    gl.uniform2f(u.point, x, y);
    gl.uniform3f(u.color, dx, dy, 0);
    gl.uniform1f(u.radius, CFG.radius * radiusScale * (aspect > 1 ? aspect : 1));
    blit(velocity.write); velocity.swap();
    if (color) {
      gl.uniform1i(u.uTarget, dye.read.attach(0));
      gl.uniform3f(u.color, color[0], color[1], color[2]);
      blit(dye.write); dye.swap();
    }
  };

  const step = (dt) => {
    gl.disable(gl.BLEND);
    let u = use(P.curl);
    gl.uniform2f(u.texelSize, 1 / velocity.w, 1 / velocity.h);
    gl.uniform1i(u.uVelocity, velocity.read.attach(0));
    blit(curlT);

    u = use(P.vorticity);
    gl.uniform2f(u.texelSize, 1 / velocity.w, 1 / velocity.h);
    gl.uniform1i(u.uVelocity, velocity.read.attach(0));
    gl.uniform1i(u.uCurl, curlT.attach(1));
    gl.uniform1f(u.curl, CFG.curl);
    gl.uniform1f(u.dt, dt);
    blit(velocity.write); velocity.swap();

    u = use(P.divergence);
    gl.uniform2f(u.texelSize, 1 / velocity.w, 1 / velocity.h);
    gl.uniform1i(u.uVelocity, velocity.read.attach(0));
    blit(divergence);

    u = use(P.clear);
    gl.uniform1i(u.uTexture, pressure.read.attach(0));
    gl.uniform1f(u.value, 0.8);
    blit(pressure.write); pressure.swap();

    u = use(P.pressure);
    gl.uniform2f(u.texelSize, 1 / velocity.w, 1 / velocity.h);
    gl.uniform1i(u.uDivergence, divergence.attach(0));
    for (let i = 0; i < CFG.pressureIters; i++) {
      gl.uniform1i(u.uPressure, pressure.read.attach(1));
      blit(pressure.write); pressure.swap();
    }

    u = use(P.gradient);
    gl.uniform2f(u.texelSize, 1 / velocity.w, 1 / velocity.h);
    gl.uniform1i(u.uPressure, pressure.read.attach(0));
    gl.uniform1i(u.uVelocity, velocity.read.attach(1));
    blit(velocity.write); velocity.swap();

    u = use(P.advection);
    gl.uniform2f(u.texelSize, 1 / velocity.w, 1 / velocity.h);
    gl.uniform2f(u.dyeTexelSize, 1 / velocity.w, 1 / velocity.h);
    gl.uniform1i(u.uVelocity, velocity.read.attach(0));
    gl.uniform1i(u.uSource, velocity.read.attach(0));
    gl.uniform1f(u.dt, dt);
    gl.uniform1f(u.dissipation, CFG.velDissipation);
    blit(velocity.write); velocity.swap();

    gl.uniform2f(u.dyeTexelSize, 1 / dye.w, 1 / dye.h);
    gl.uniform1i(u.uVelocity, velocity.read.attach(0));
    gl.uniform1i(u.uSource, dye.read.attach(1));
    gl.uniform1f(u.dissipation, CFG.dyeDissipation);
    blit(dye.write); dye.swap();
  };

  const calmEls = () => Array.from(document.querySelectorAll('.nav, .halo, [data-calm], .ph-head > *, .room-text > *'));
  const calmData = new Float32Array(32);
  const draw = () => {
    const u = use(P.display);
    gl.uniform1i(u.uTexture, dye.read.attach(0));
    gl.uniform3f(u.paper, PAPER[0], PAPER[1], PAPER[2]);
    // Collect up to four visible text blocks, in CSS pixels (top-left origin).
    calmData.fill(0);
    let n = 0;
    for (const el of calmEls()) {
      if (n >= 8) break;
      const r = el.getBoundingClientRect();
      if (r.bottom < 0 || r.top > innerHeight || r.width === 0) continue;
      calmData.set([r.left - 16, r.top - 16, r.right + 16, r.bottom + 16], n * 4);
      n++;
    }
    gl.uniform4fv(u['uCalm[0]'] || u.uCalm, calmData);
    gl.uniform2f(u.uView, innerWidth, innerHeight);
    blit(null);
  };

  /* ---------- pigment state (shared with the page via events) ---------- */
  const pigment = absorb(PIGMENTS.red, 1);
  const setPigment = () => {};
  document.addEventListener('ink:pigment', (e) => setPigment(e.detail.key, e.detail.hex));
  if (window.__inkPigment) setPigment(window.__inkPigment.key, window.__inkPigment.hex);

  /* ---------- opening composition: a poured stream that curls across the page ---------- */
  const rand = (a, b) => a + Math.random() * (b - a);
  const pourPath = [];
  const seedComposition = () => {
    // A long S-curve from the upper right toward the lower left, in indigo with a red vein.
    const pts = 70;
    for (let i = 0; i < pts; i++) {
      const t = i / (pts - 1);
      const x = 0.95 - t * 0.48 + Math.sin(t * Math.PI * 1.6) * 0.05;
      const y = 0.88 - t * 0.72 + Math.sin(t * Math.PI * 2.2) * 0.08;
      pourPath.push({ x, y, t });
    }
  };
  seedComposition();

  const current = () => {
    // Broad, slow currents: large-radius velocity only, so dye is stretched into veins.
    for (let k = 0; k < 5; k++) {
      const ang = rand(0, Math.PI * 2);
      splat(rand(0.1, 0.9), rand(0.1, 0.9), Math.cos(ang) * 900, Math.sin(ang) * 900, null, 60);
    }
  };
  // Where ink enters: the Foylan roundel in the hero when present, else the upper right.
  const source = () => {
    const el = document.querySelector('[data-ink-source]');
    if (el) {
      const r = el.getBoundingClientRect();
      if (r.bottom > 0 && r.top < innerHeight && r.width) return { x: (r.left + r.width / 2) / innerWidth, y: 1 - (r.top + r.height / 2) / innerHeight, r: r.width / innerWidth };
    }
    return { x: 0.82, y: 0.78, r: 0.12 };
  };
  const isHome = document.body.classList.contains('page-index');
  const preroll = () => {
    const src = isHome ? source() : { x: 0.86, y: 0.32, r: 0.1 };
    const red = absorb(PIGMENTS.red, 1.8);
    const black = absorb(PIGMENTS.red, 0.9); // light red ring between full red rings: ink is red only
    // Concentric drops around the mark, red and black alternating, then combed by broad currents.
    for (let k = 0; k < 5; k++) splat(src.x, src.y, 0, 0, k % 2 ? black : red, (16 - k * 2.6) * (isHome ? 1 : 0.6));
    for (let i = 0; i < 40; i++) step(1 / 60);
    for (let k = 0; k < 3; k++) {
      const ang = rand(Math.PI * 0.7, Math.PI * 1.3);
      splat(src.x + rand(-0.04, 0.04), src.y + rand(-0.06, 0.06), Math.cos(ang) * 700, Math.sin(ang) * 500, null, 30);
    }
    for (let i = 0; i < 120; i++) { if (i % 60 === 0) current(); step(1 / 60); }
  };
  preroll();

  /* ---------- input ---------- */
  const pointer = { x: 0, y: 0, px: 0, py: 0, moved: false, down: false, primed: false };
  const toUV = (cx, cy) => [cx / innerWidth, 1 - cy / innerHeight];
  addEventListener('pointermove', (e) => {
    const [x, y] = toUV(e.clientX, e.clientY);
    if (!pointer.primed) { pointer.px = x; pointer.py = y; pointer.primed = true; }
    pointer.x = x; pointer.y = y; pointer.moved = true;
    pointer.touch = e.pointerType === 'touch';
  }, { passive: true });
  addEventListener('pointerdown', (e) => {
    if (e.target.closest('a, button, input, select, textarea, label, [data-no-ink]')) return;
    const [x, y] = toUV(e.clientX, e.clientY);
    pointer.down = true; pointer.x = pointer.px = x; pointer.y = pointer.py = y; pointer.primed = true;
    drops.push({ x, y, life: 1 });
  }, { passive: true });
  addEventListener('pointerup', () => { pointer.down = false; }, { passive: true });
  addEventListener('pointercancel', () => { pointer.down = false; }, { passive: true });

  // Programmatic drops (the pigment dock drops a sample when a colour is chosen).
  const drops = [];
  document.addEventListener('ink:drop', (e) => {
    const { x = rand(0.55, 0.85), y = rand(0.35, 0.75) } = e.detail || {};
    drops.push({ x, y, life: 1 });
  });

  let lastScroll = scrollY;

  // Ambient pours: a curving stream of ink entering from the right half of the basin.
  const streams = [];
  let pourCount = 0;
  const pour = () => {
    const order = [PIGMENTS.red];
    const tone = order[pourCount++ % order.length];
    const src = source();
    const fromMark = isHome && pourCount % 2 === 1;
    // Away from the header band (top 18% of the viewport) and biased to the right.
    const x0 = fromMark ? src.x : rand(0.62, 0.94), y0 = fromMark ? src.y : rand(0.12, 0.7);
    const ang = rand(Math.PI * 0.6, Math.PI * 1.4) + (y0 > 0.55 ? -0.35 : 0.35);
    const len = rand(0.18, 0.34), bend = rand(-2.4, 2.4), n = 30;
    const pts = [];
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1), a = ang + bend * t * t;
      const prev = pts[i - 1] || { x: x0, y: y0 };
      pts.push(i === 0 ? { x: x0, y: y0 } : { x: prev.x + Math.cos(a) * len / n, y: prev.y + Math.sin(a) * len / n });
    }
    streams.push({ pts, i: 0, color: absorb(tone, 1.1) });
  };

  /* ---------- loop ---------- */
  let last = performance.now();
  let ambient = 0.4;
  let running = !reduce;
  const frame = (now) => {
    if (!running) return;
    const dt = Math.min((now - last) / 1000, 1 / 30);
    last = now;
    if (resizeCanvas()) { /* keep simulation, only the view changes */ }

    // Pointer: stirring always, painting while pressed or on touch.
    if (pointer.moved) {
      const dx = (pointer.x - pointer.px) * CFG.force;
      const dy = (pointer.y - pointer.py) * CFG.force;
      if (Math.abs(dx) + Math.abs(dy) > 0.01) {
        const paint = pointer.down || pointer.touch;
        splat(pointer.x, pointer.y, dx, dy, paint ? pigment.map((c) => c * 0.34) : null, paint ? 1 : 3);
      }
      pointer.px = pointer.x; pointer.py = pointer.y; pointer.moved = false;
    }

    // Scrolling drags the basin gently.
    const sy = scrollY, ds = sy - lastScroll;
    lastScroll = sy;
    if (Math.abs(ds) > 0.5) {
      const force = Math.max(-260, Math.min(260, ds * 6));
      splat(rand(0.15, 0.85), rand(0.2, 0.8), rand(-40, 40), force, null, 14);
    }

    // Drops bloom outward over a few frames.
    for (let i = drops.length - 1; i >= 0; i--) {
      const d = drops[i];
      splat(d.x, d.y, 0, 0, pigment.map((c) => c * 1.1 * d.life), 3 + (1 - d.life) * 6);
      for (let k = 0; k < 6; k++) {
        const ang = k * Math.PI / 3 + rand(-0.3, 0.3);
        splat(d.x, d.y, Math.cos(ang) * 180 * d.life, Math.sin(ang) * 180 * d.life, null, 4);
      }
      d.life -= 0.14;
      if (d.life <= 0) drops.splice(i, 1);
    }

    // Ambient: an occasional slow drop and current so the basin is never still.
    ambient -= dt;
    if (ambient <= 0) {
      ambient = isHome ? rand(6, 9) : rand(12, 18);
      if (Math.random() < 0.5) current();
      pour();
    }

    // Advance any streams that are pouring.
    for (let i = streams.length - 1; i >= 0; i--) {
      const st = streams[i];
      for (let k = 0; k < 2 && st.i < st.pts.length; k++, st.i++) {
        const a = st.pts[Math.max(0, st.i - 1)], b = st.pts[st.i];
        splat(b.x, b.y, (b.x - a.x) * CFG.force * 0.45, (b.y - a.y) * CFG.force * 0.45, st.color, 0.75);
      }
      if (st.i >= st.pts.length) streams.splice(i, 1);
    }

    step(dt);
    draw();
    requestAnimationFrame(frame);
  };

  const ringsAtSource = () => {
    if (!isHome) return;
    const src = source();
    const red = absorb(PIGMENTS.red, 1.5), black = absorb(PIGMENTS.red, 0.75);
    for (let k = 0; k < 4; k++) splat(src.x, src.y, 0, 0, k % 2 ? black : red, 12 - k * 2.4);
  };
  if (document.readyState === 'complete') ringsAtSource(); else addEventListener('load', ringsAtSource, { once: true });
  matchMedia('(max-width: 860px)').addEventListener('change', ringsAtSource);
  draw();
  root.classList.add('ink-live');
  if (running) requestAnimationFrame((t) => { last = t; requestAnimationFrame(frame); });

  document.addEventListener('visibilitychange', () => {
    if (reduce) return;
    if (document.hidden) running = false;
    else if (!running) { running = true; last = performance.now(); requestAnimationFrame(frame); }
  });
  if (reduce) addEventListener('resize', () => { resizeCanvas(); draw(); });

  // Exposed for the page: a visitor-initiated drop works even with reduced motion (single frame).
  window.__ink = {
    // drop(x, y, hex): x/y in viewport pixels (optional), hex colour (optional, defaults to the active pigment).
    drop (cx, cy, hex) {
      const x = cx == null ? rand(0.55, 0.85) : cx / innerWidth;
      const y = cy == null ? rand(0.35, 0.75) : 1 - cy / innerHeight;
      const col = absorb(PIGMENTS.red, 1.6); // all ink is Foylan red
      if (running) {
        splat(x, y, 0, 0, col, 3.2);
        for (let k = 0; k < 6; k++) { const ang = k * Math.PI / 3 + rand(-0.3, 0.3); splat(x, y, Math.cos(ang) * 160, Math.sin(ang) * 160, null, 4); }
      } else { splat(x, y, 0, 0, col, 3); for (let i = 0; i < 40; i++) step(1 / 60); draw(); }
    },
  };})();

// ============================================================================
// HeroBackground — aurora noise en WebGL nativo (sin three.js)
// ============================================================================
// Por qué sin R3F/three: el chunk de three + fiber + drei pesaba 817.94 kB
// (220 kB gzip) para pintar un plano con un fragment shader de ~40 líneas.
// Un contexto WebGL con dos buffers lo hace en <6 kB. Mismo shader, mismo
// aspecto, 100x menos peso — y sin ~800 kB de dependencia en una app que
// además expone un panel de admin.
// Spec: PROJECT.md §21.7
// ============================================================================
import { useEffect, useRef } from 'react';

const VERT = `
attribute vec2 aPos;
varying vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const FRAG = `
precision mediump float;
uniform float uTime;
uniform vec2  uMouse;
uniform vec2  uRes;
uniform vec3  uColorA;  // fresa
uniform vec3  uColorB;  // durazno
uniform vec3  uColorC;  // ube
uniform vec3  uColorD;  // matcha
uniform vec3  uColorE;  // cyan
uniform float uIntensity;
varying vec2 vUv;

// Simple hash for pseudo-random
float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

// Simple value noise
float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f); // smoothstep
  float a = hash(i);
  float b = hash(i + vec2(1.0, 0.0));
  float c = hash(i + vec2(0.0, 1.0));
  float d = hash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

// fbm with 3 octaves - no loops, unrolled
float fbm(vec2 p) {
  float v = 0.0;
  v += 0.5000 * noise(p); p *= 2.02;
  v += 0.2500 * noise(p); p *= 2.02;
  v += 0.1250 * noise(p);
  return v;
}

void main() {
  vec2 uv = vUv;
  float aspect = uRes.x / max(uRes.y, 1.0);
  vec2 p = vec2(uv.x * aspect, uv.y);

  vec2 m = (uMouse - 0.5) * 0.15;
  float t = uTime * 0.04;

  // Multiple noise layers for organic aurora movement
  float n1 = fbm(p * 1.8 + vec2(t, t * 0.7) + m);
  float n2 = fbm(p * 3.2 - vec2(t * 0.5, t * 0.9) + m * 0.5);
  float n3 = fbm(p * 0.9 + vec2(t * 0.3, t * 0.4) - m * 0.3);
  float n = 0.5 * n1 + 0.3 * n2 + 0.2 * n3;

  // Smooth color transitions through mochi palette
  float k = smoothstep(-0.6, 0.6, n);
  vec3 col;

  // 5-color gradient: fresa -> durazno -> ube -> matcha -> cyan
  if (k < 0.2) {
    col = mix(uColorA, uColorB, k * 5.0);
  } else if (k < 0.4) {
    col = mix(uColorB, uColorC, (k - 0.2) * 5.0);
  } else if (k < 0.6) {
    col = mix(uColorC, uColorD, (k - 0.4) * 5.0);
  } else if (k < 0.8) {
    col = mix(uColorD, uColorE, (k - 0.6) * 5.0);
  } else {
    col = mix(uColorE, uColorA, (k - 0.8) * 5.0);
  }

  // Sweeping light beams
  float beam1 = smoothstep(0.75, 0.0, abs(uv.x - (0.25 + 0.06 * sin(t * 0.6))));
  float beam2 = smoothstep(0.82, 0.0, abs(uv.x - (0.75 + 0.05 * cos(t * 0.4))));
  col += (beam1 * 0.12 + beam2 * 0.08) * uColorE;

  // Vignette suave
  float d = distance(uv, vec2(0.5));
  col *= 1.0 - d * 0.25;

  // Subtle grain
  float grain = fract(sin(dot(uv * uRes, vec2(12.9898, 78.233))) * 43758.5453);
  col += (grain - 0.5) * 0.008;

  gl_FragColor = vec4(col * uIntensity, 0.75);
}
`;

const DPR_CAP = 1.5;
const MAX_PIXELS = 2400000;
const STATIC_TIME = 9.5;

function compile(
  gl: WebGLRenderingContext,
  type: number,
  src: string,
): WebGLShader | null {
  const sh = gl.createShader(type);
  if (!sh) return null;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    console.warn('[mymochis/shader]', gl.getShaderInfoLog(sh));
    gl.deleteShader(sh);
    return null;
  }
  return sh;
}

function hex2rgb(h: string): [number, number, number] {
  const s = h.replace('#', '');
  return [
    parseInt(s.slice(0, 2), 16) / 255,
    parseInt(s.slice(2, 4), 16) / 255,
    parseInt(s.slice(4, 6), 16) / 255,
  ];
}

export interface HeroBackgroundProps {
  colorA?: string;  // fresa
  colorB?: string;  // durazno
  colorC?: string;  // ube
  colorD?: string;  // matcha
  colorE?: string;  // cyan
  /** 0..1 — baja la intensidad cuando hay contenido legible encima */
  intensity?: number;
  className?: string;
}

export function HeroBackground({
  colorA = '#FF8FB4',   // fresa
  colorB = '#FFB88C',   // durazno
  colorC = '#B08CF0',   // ube
  colorD = '#7BBC46',   // matcha
  colorE = '#56C8E4',   // cyan
  intensity = 1,
  className = 'shader-canvas',
}: HeroBackgroundProps = {}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;

    const gl = (canvas.getContext('webgl', {
      alpha: true, antialias: false, depth: false, powerPreference: 'low-power',
    }) || canvas.getContext('experimental-webgl')) as WebGLRenderingContext | null;

    if (!gl) return undefined;

    const vs = compile(gl, gl.VERTEX_SHADER, VERT);
    const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG);
    if (!vs || !fs) return undefined;

    const prog = gl.createProgram();
    if (!prog) return undefined;
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      console.warn('[mymochis/shader] link', gl.getProgramInfoLog(prog));
      return undefined;
    }
    gl.useProgram(prog);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const aPos = gl.getAttribLocation(prog, 'aPos');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    const u = {
      time: gl.getUniformLocation(prog, 'uTime'),
      mouse: gl.getUniformLocation(prog, 'uMouse'),
      res: gl.getUniformLocation(prog, 'uRes'),
      cA: gl.getUniformLocation(prog, 'uColorA'),
      cB: gl.getUniformLocation(prog, 'uColorB'),
      cC: gl.getUniformLocation(prog, 'uColorC'),
      cD: gl.getUniformLocation(prog, 'uColorD'),
      cE: gl.getUniformLocation(prog, 'uColorE'),
      int: gl.getUniformLocation(prog, 'uIntensity'),
    };

    const [ar, ag, ab] = hex2rgb(colorA);
    const [br, bg, bb] = hex2rgb(colorB);
    const [cr, cg, cb] = hex2rgb(colorC);
    const [dr, dg, db] = hex2rgb(colorD);
    const [er, eg, eb] = hex2rgb(colorE);
    gl.uniform3f(u.cA, ar, ag, ab);
    gl.uniform3f(u.cB, br, bg, bb);
    gl.uniform3f(u.cC, cr, cg, cb);
    gl.uniform3f(u.cD, dr, dg, db);
    gl.uniform3f(u.cE, er, eg, eb);
    gl.uniform1f(u.int, intensity);

    let rect = canvas.getBoundingClientRect();
    let pointer: [number, number] = [0.5, 0.5];

    const resize = () => {
      rect = canvas.getBoundingClientRect();
      const cssW = Math.max(1, rect.width);
      const cssH = Math.max(1, rect.height);
      const dpr = Math.min(window.devicePixelRatio || 1, DPR_CAP);
      let w = Math.floor(cssW * dpr);
      let h = Math.floor(cssH * dpr);
      const px = w * h;
      if (px > MAX_PIXELS) {
        const k = Math.sqrt(MAX_PIXELS / px);
        w = Math.max(1, Math.floor(w * k));
        h = Math.max(1, Math.floor(h * k));
      }
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        gl.viewport(0, 0, w, h);
        gl.uniform2f(u.res, w, h);
      }
    };

    // El rect se relee solo cuando el layout cambia: en el loop no hay ninguna
    // lectura de layout (el puntero usa el rect cacheado).
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    const onMove = (e: PointerEvent) => {
      const w = Math.max(rect.width, 1);
      const h = Math.max(rect.height, 1);
      pointer = [(e.clientX - rect.left) / w, 1 - (e.clientY - rect.top) / h];
    };
    window.addEventListener('pointermove', onMove, { passive: true });

    let scrollQueued = false;
    const onScroll = () => {
      if (scrollQueued) return;
      scrollQueued = true;
      requestAnimationFrame(() => {
        scrollQueued = false;
        rect = canvas.getBoundingClientRect();
      });
    };
    window.addEventListener('scroll', onScroll, { passive: true });

    const draw = (time: number) => {
      gl.useProgram(prog);
      gl.uniform1f(u.time, time);
      gl.uniform2f(u.mouse, pointer[0], pointer[1]);
      gl.uniform2f(u.res, canvas.width, canvas.height);
      gl.uniform3f(u.cA, ar, ag, ab);
      gl.uniform3f(u.cB, br, bg, bb);
      gl.uniform3f(u.cC, cr, cg, cb);
      gl.uniform3f(u.cD, dr, dg, db);
      gl.uniform3f(u.cE, er, eg, eb);
      gl.uniform1f(u.int, intensity);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };

    let raf = 0;
    const t0 = performance.now();
    const loop = () => {
      draw((performance.now() - t0) / 1000);
      raf = requestAnimationFrame(loop);
    };
    const start = () => { if (!raf) raf = requestAnimationFrame(loop); };
    const stop = () => { if (raf) { cancelAnimationFrame(raf); raf = 0; } };

    const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    let reduced = motionQuery.matches;

    const applyMotionMode = () => {
      if (reduced) {
        stop();
        draw(STATIC_TIME);
      } else if (!document.hidden) {
        start();
      }
    };

    const onMotionChange = (e: MediaQueryListEvent) => {
      reduced = e.matches;
      applyMotionMode();
    };

    // No renderizar fuera de viewport y pausar en background: la landing es un
    // scroll largo y el shader se pagaría entero el tiempo aunque nadie lo vea.
    const io = new IntersectionObserver((entries) => {
      const visible = entries[0] && entries[0].isIntersecting;
      if (reduced) return;
      if (visible) start(); else stop();
    }, { threshold: 0 });
    io.observe(canvas);

    const onVis = () => {
      if (reduced) return;
      if (document.hidden) stop(); else start();
    };
    document.addEventListener('visibilitychange', onVis);
    motionQuery.addEventListener('change', onMotionChange);

    resize();
    applyMotionMode();

    return () => {
      stop();
      io.disconnect();
      ro.disconnect();
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('visibilitychange', onVis);
      motionQuery.removeEventListener('change', onMotionChange);
      gl.deleteProgram(prog);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      gl.deleteBuffer(buf);
    };
  }, [colorA, colorB, colorC, colorD, colorE, intensity]);

  return <canvas ref={canvasRef} className={className} aria-hidden="true" />;
}

export default HeroBackground;
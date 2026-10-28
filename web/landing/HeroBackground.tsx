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
uniform vec3  uColorA;
uniform vec3  uColorB;
uniform vec3  uColorC;
uniform float uIntensity;
varying vec2 vUv;

// 2D simplex noise (Ashima Arts, dominio público)
vec3 mod289(vec3 x){return x-floor(x*(1.0/289.0))*289.0;}
vec2 mod289(vec2 x){return x-floor(x*(1.0/289.0))*289.0;}
vec3 permute(vec3 x){return mod289(((x*34.0)+1.0)*x);}
float snoise(vec2 v){
  const vec4 C=vec4(0.211324865405187,0.366025403784439,
                   -0.577350269189626,0.024390243902439);
  vec2 i=floor(v+dot(v,C.yy));
  vec2 x0=v-i+dot(i,C.xx);
  vec2 i1=(x0.x>x0.y)?vec2(1.0,0.0):vec2(0.0,1.0);
  vec4 x12=x0.xyxy+C.xxzz; x12.xy-=i1;
  i=mod289(i);
  vec3 p=permute(permute(i.y+vec3(0.0,i1.y,1.0))+i.x+vec3(0.0,i1.x,1.0));
  vec3 m=max(0.5-vec3(dot(x0,x0),dot(x12.xy,x12.xy),dot(x12.zw,x12.zw)),0.0);
  m=m*m; m=m*m;
  vec3 x=2.0*fract(p*C.www)-1.0;
  vec3 h=abs(x)-0.5;
  vec3 ox=floor(x+0.5);
  vec3 a0=x-ox;
  m*=1.79284291400159-0.85373472095314*(a0*a0+h*h);
  vec3 g;
  g.x=a0.x*x0.x+h.x*x0.y;
  g.yz=a0.yz*x12.xz+h.yz*x12.yw;
  return 130.0*dot(m,g);
}

float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 3; i++) {
    v += a * snoise(p);
    p *= 2.02;
    a *= 0.5;
  }
  return v;
}

void main() {
  vec2 uv = vUv;
  float aspect = uRes.x / max(uRes.y, 1.0);
  vec2 p = vec2(uv.x * aspect, uv.y);

  vec2 m = (uMouse - 0.5) * 0.12;
  float t = uTime * 0.05;

  float n1 = fbm(p * 1.5 + vec2(t, t * 0.6) + m);
  float n2 = fbm(p * 2.9 - vec2(t * 0.45, t * 0.8) + m * 0.6);
  float n = 0.66 * n1 + 0.34 * n2;

  float k = smoothstep(-0.5, 0.55, n);
  vec3 col = k < 0.5
    ? mix(uColorA, uColorB, k * 2.0)
    : mix(uColorB, uColorC, (k - 0.5) * 2.0);

  // haces muy lentos: dos lóbulos que barren la escena sin que se note el loop
  float beam1 = smoothstep(0.70, 0.0, abs(uv.x - (0.26 + 0.05 * sin(t * 0.7))));
  float beam2 = smoothstep(0.80, 0.0, abs(uv.x - (0.74 + 0.04 * cos(t * 0.5))));
  col += (beam1 * 0.10 + beam2 * 0.06) * uColorC;

  // viñeta suave: mantiene el centro legible bajo el texto del hero
  float d = distance(uv, vec2(0.5));
  col *= 1.0 - d * 0.30;

  // grano muy leve: mata el banding en degradados amplios
  float grain = fract(sin(dot(uv * uRes, vec2(12.9898, 78.233))) * 43758.5453);
  col += (grain - 0.5) * 0.010;

  gl_FragColor = vec4(col * uIntensity, 0.62);
}`;

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
  colorA?: string;
  colorB?: string;
  colorC?: string;
  /** 0..1 — baja la intensidad cuando hay contenido legible encima */
  intensity?: number;
  className?: string;
}

export function HeroBackground({
  colorA = '#FF8FB4',
  colorB = '#FFC24D',
  colorC = '#56C8E4',
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
      int: gl.getUniformLocation(prog, 'uIntensity'),
    };

    const [ar, ag, ab] = hex2rgb(colorA);
    const [br, bg, bb] = hex2rgb(colorB);
    const [cr, cg, cb] = hex2rgb(colorC);
    gl.uniform3f(u.cA, ar, ag, ab);
    gl.uniform3f(u.cB, br, bg, bb);
    gl.uniform3f(u.cC, cr, cg, cb);
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
      gl.uniform1f(u.time, time);
      gl.uniform2f(u.mouse, pointer[0], pointer[1]);
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
      document.removeEventListener('visibilitychange', onVis);
      motionQuery.removeEventListener('change', onMotionChange);
      gl.deleteProgram(prog);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      gl.deleteBuffer(buf);
    };
  }, [colorA, colorB, colorC, intensity]);

  return <canvas ref={canvasRef} className={className} aria-hidden="true" />;
}

export default HeroBackground;

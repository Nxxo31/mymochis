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
  // aspect-correct: sin esto el noise se estira en pantallas anchas
  float aspect = uRes.x / max(uRes.y, 1.0);
  vec2 p = vec2(uv.x * aspect, uv.y);

  vec2 m = (uMouse - 0.5) * 0.15;
  float t = uTime * 0.15;

  float n1 = fbm(p * 1.8 + vec2(t, t * 0.7) + m);
  float n2 = fbm(p * 3.4 - vec2(t * 0.5, t) + m * 0.5);
  float n = 0.62 * n1 + 0.38 * n2;

  // rampa de 3 paradas: indigo -> durazno -> lavanda (identidad v4)
  float k = smoothstep(-0.45, 0.45, n);
  vec3 col = k < 0.5
    ? mix(uColorA, uColorB, k * 2.0)
    : mix(uColorB, uColorC, (k - 0.5) * 2.0);

  // viñeta suave: mantiene el centro legible bajo el texto del hero
  float d = distance(uv, vec2(0.5));
  col *= 1.0 - d * 0.38;

  // grano muy leve: mata el banding en degradados amplios
  float grain = fract(sin(dot(uv * uRes, vec2(12.9898, 78.233))) * 43758.5453);
  col += (grain - 0.5) * 0.012;

  gl_FragColor = vec4(col * uIntensity, 0.55);
}`;

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
}

export function HeroBackground({
  colorA = '#5B34B4',
  colorB = '#FF7A45',
  colorC = '#C5B0E8',
  intensity = 1,
}: HeroBackgroundProps = {}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;

    const fallback = () => canvas.parentElement?.classList.add('hero-island__bg--fallback');

    const gl = (canvas.getContext('webgl', {
      alpha: true, antialias: false, depth: false, powerPreference: 'low-power',
    }) || canvas.getContext('experimental-webgl')) as WebGLRenderingContext | null;

    if (!gl) { fallback(); return undefined; }

    const vs = compile(gl, gl.VERTEX_SHADER, VERT);
    const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG);
    if (!vs || !fs) { fallback(); return undefined; }

    const prog = gl.createProgram();
    if (!prog) { fallback(); return undefined; }
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      console.warn('[mymochis/shader] link', gl.getProgramInfoLog(prog));
      fallback();
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

    // pointer con throttle: sin esto cada mousemove fuerza un read de layout
    let pending: [number, number] | null = null;
    const onMove = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      if (!r.width || !r.height) return;
      pending = [(e.clientX - r.left) / r.width, 1 - (e.clientY - r.top) / r.height];
    };
    window.addEventListener('pointermove', onMove, { passive: true });

    const resize = () => {
      // dpr capado a 1.6: en móvil un dpr nativo de 3 quadruplica el fill rate
      const dpr = Math.min(window.devicePixelRatio || 1, 1.6);
      const w = Math.max(1, Math.floor(canvas.clientWidth * dpr));
      const h = Math.max(1, Math.floor(canvas.clientHeight * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        gl.viewport(0, 0, w, h);
        gl.uniform2f(u.res, w, h);
      }
    };
    window.addEventListener('resize', resize, { passive: true });

    let raf = 0;
    const t0 = performance.now();
    const loop = () => {
      resize();
      gl.uniform1f(u.time, (performance.now() - t0) / 1000);
      if (pending) { gl.uniform2f(u.mouse, pending[0], pending[1]); pending = null; }
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      raf = requestAnimationFrame(loop);
    };
    const start = () => { if (!raf) raf = requestAnimationFrame(loop); };
    const stop = () => { if (raf) { cancelAnimationFrame(raf); raf = 0; } };

    // No renderizar fuera de viewport: la landing es un scroll largo y el
    // shader se pagaría entero el tiempo aunque nadie lo esté viendo.
    const io = new IntersectionObserver((entries) => {
      if (entries[0] && entries[0].isIntersecting) start(); else stop();
    }, { threshold: 0 });
    io.observe(canvas);

    // pausa en background: un rAF abierto en una pestaña oculta quema batería
    const onVis = () => (document.hidden ? stop() : start());
    document.addEventListener('visibilitychange', onVis);

    resize();
    start();

    return () => {
      stop();
      io.disconnect();
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('resize', resize);
      document.removeEventListener('visibilitychange', onVis);
      gl.deleteProgram(prog);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      gl.deleteBuffer(buf);
    };
  }, [colorA, colorB, colorC, intensity]);

  return (
    <div className="hero-island__bg" aria-hidden="true">
      <canvas ref={canvasRef} />
    </div>
  );
}

export default HeroBackground;

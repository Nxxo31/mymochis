// ============================================================================
// MochiBelt — cinta transportadora de sabores (puerto del componente
// "Sushi Conveyor Menu" de 21st.dev al sistema visual de MyMochis)
// ============================================================================
// POR QUE NO /components/ui CON TAILWIND: este repo no usa Tailwind ni
// shadcn. El CSS vive en theme.css/ui.css (tokens clay/mochi) y las islas
// React se compilan con Vite a /build (spec PROJECT.md §21.9). El motor del
// componente (geometria del circuito + simulacion de la cinta) es JS puro y
// se conserva integro; lo que cambia es la capa visual: clases propias
// (web/styles/belt.css) y el acento por sabor en vez de chart-1..5.
//
// QUE ES: la cinta muestra los sabores de la semana como platos que giran.
// Al pasar el mouse se levanta el plato; al hacer click se abre el dialogo
// con la foto, el precio y el CTA real de pedido (window.openOrderModal).
// ============================================================================
import * as React from 'react';
import { createPortal } from 'react-dom';

export interface BeltDish {
  id: string;
  /** Nombre del sabor: chip, dialogo y aria-label. */
  name: string;
  /** Una o dos frases para el pie del plato y el dialogo. */
  description?: string;
  /** Precio ya formateado, p.ej. "$12.000". */
  price: string;
  /** Acento del sabor: color del anillo del plato. */
  accent: string;
  /** Foto del sabor (misma ruta que usa la landing). */
  image: string;
  /** Datos cortos: unidades, categoria, etc. */
  details?: string[];
  /** Etiqueta tipo "Más pedido". */
  ribbon?: string | null;
}

export interface BeltLabels {
  add: string;
  close: string;
  previous: string;
  next: string;
  pause?: string;
  belt?: string;
}

export interface MochiBeltProps extends Omit<React.ComponentProps<'section'>, 'children'> {
  items: BeltDish[];
  eyebrow?: string;
  heading?: string;
  caption?: string;
  action?: React.ReactNode;
  /** Velocidad de la cinta en px/s. */
  speed?: number;
  paused?: boolean;
  onPausedChange?: (paused: boolean) => void;
  autoplay?: boolean;
  interval?: number;
  active?: number | null;
  onActiveChange?: (index: number | null) => void;
  onOpenChange?: (index: number | null) => void;
  /** CTA principal del dialogo (abrir el pedido). */
  onOrder?: (item: BeltDish) => void;
  labels?: BeltLabels;
}

const SPACING = 1.35;
const CURVE = 0.95;
const BAND = 1.22;
const TILT = 0.8;
const SLAT = 0.34;
const LIFT_Y = -6;
const LIFT_SCALE = 0.08;
const BACK_SHADE = 0.15;
const CHIP_ROOM = 34;
const WIDE = 1024;
const HOLD = 1400;
const RUN = 0;
const SEEK = 1;
const DRAG = 2;

const DEFAULT_LABELS: BeltLabels = {
  add: 'Pedir este mochi',
  close: 'Cerrar',
  previous: 'Sabor anterior',
  next: 'Sabor siguiente',
  pause: 'Pausar la cinta',
  belt: 'Cinta de sabores',
};

type Geo = {
  width: number;
  height: number;
  d: number;
  r: number;
  s: number;
  l: number;
  pitch: number;
  n: number;
  kb: number;
  cx: number;
  ym: number;
  a: number;
  b: number;
  band: number;
  slats: number;
  side: number;
  edgeTop: number;
};
type Point = { x: number; z: number; nx: number; nz: number; tx: number; tz: number };
type Sim = {
  offset: number;
  v: number;
  mode: number;
  target: number;
  lift: number[];
  vlift: number[];
  z: number[];
  lane: string[];
  raf: number;
  last: number;
  visible: boolean;
  init: boolean;
  touched: boolean;
  l: number;
  center: number;
  published: string;
  px: number;
  py: number;
  inside: boolean;
  lock: boolean;
  lockX: number;
  lockY: number;
};

function makeSim(): Sim {
  return {
    offset: 0, v: 0, mode: RUN, target: 0, lift: [], vlift: [], z: [], lane: [],
    raf: 0, last: 0, visible: true, init: false, touched: false, l: 0, center: -1,
    published: '', px: 0, py: 0, inside: false, lock: false, lockX: 0, lockY: 0,
  };
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

/** Posicion sobre el circuito. u es longitud de arco; el carril frontal corre de derecha a izquierda. */
function along(g: Geo, u: number): Point {
  const { s, r } = g;
  let t = ((u % g.l) + g.l) % g.l;
  if (t < s) return { x: s / 2 - t, z: r, nx: 0, nz: 1, tx: -1, tz: 0 };
  t -= s;
  const arc = Math.PI * r;
  if (t < arc) {
    const f = t / r;
    const sin = Math.sin(f);
    const cos = Math.cos(f);
    return { x: -s / 2 - r * sin, z: r * cos, nx: -sin, nz: cos, tx: -cos, tz: -sin };
  }
  t -= arc;
  if (t < s) return { x: -s / 2 + t, z: -r, nx: 0, nz: -1, tx: 1, tz: 0 };
  t -= s;
  const f = Math.min(Math.PI, t / r);
  const sin = Math.sin(f);
  const cos = Math.cos(f);
  return { x: s / 2 + r * sin, z: -r * cos, nx: sin, nz: -cos, tx: cos, tz: sin };
}

/** Proyeccion con perspectiva: el carril trasero se encoge a kb y la profundidad se escorza. */
function project(g: Geo, x: number, z: number) {
  const k = g.a + g.b * z;
  return { x: g.cx + x * k, y: g.ym + TILT * (g.a * z + (g.b * z * z) / 2), k };
}

function makeGeo(width: number, n: number, d: number, kb: number): Geo {
  const l = Math.max(1, n) * SPACING * d;
  const r = Math.min(CURVE * d, l / (2 * Math.PI));
  const s = Math.max(0, (l - 2 * Math.PI * r) / 2);
  const g: Geo = {
    width, height: 0, d, r, s, l, pitch: l / Math.max(1, n), n: Math.max(1, n), kb,
    cx: width / 2, ym: 0, a: (1 + kb) / 2, b: (1 - kb) / (2 * r), band: BAND * d,
    slats: Math.max(10, Math.round(l / (SLAT * d))), side: Math.max(3, d * 0.07), edgeTop: 0,
  };
  let top = Infinity;
  let bottom = -Infinity;
  let edge = Infinity;
  for (let j = 0; j < 120; j++) {
    const p = along(g, (j / 120) * l);
    const rim = project(g, p.x + (p.nx * g.band) / 2, p.z + (p.nz * g.band) / 2);
    const plate = project(g, p.x, p.z);
    const half = (plate.k * d * TILT) / 2;
    edge = Math.min(edge, rim.y);
    top = Math.min(top, rim.y, plate.y + (LIFT_Y / 100) * half * 2 - half * (1 + LIFT_SCALE) - CHIP_ROOM);
    bottom = Math.max(bottom, rim.y + g.side + d * 0.06, plate.y + half + d * 0.08);
  }
  g.ym = Math.ceil(-top) + 2;
  g.height = Math.ceil(bottom - top) + 4;
  g.edgeTop = edge + g.ym;
  return g;
}

function halfSpan(g: Geo) {
  let span = 0;
  for (let j = 0; j < 120; j++) {
    const p = along(g, (j / 120) * g.l);
    const rim = project(g, p.x + (p.nx * g.band) / 2, p.z + (p.nz * g.band) / 2);
    const plate = project(g, p.x, p.z);
    span = Math.max(span, Math.abs(rim.x - g.cx) + 3, Math.abs(plate.x - g.cx) + (plate.k * g.d * (1 + LIFT_SCALE)) / 2);
  }
  return span;
}

function edgePath(g: Geo, offset: number) {
  let d = '';
  const steps = 168;
  for (let j = 0; j < steps; j++) {
    const p = along(g, (j / steps) * g.l);
    const q = project(g, p.x + p.nx * offset, p.z + p.nz * offset);
    d += `${j ? 'L' : 'M'}${q.x.toFixed(1)} ${q.y.toFixed(1)}`;
  }
  return `${d}Z`;
}

/** Juntas de liston en media luna: se redibujan cada frame para viajar con los platos. */
function slatPath(g: Geo, offset: number, shift: number) {
  const half = g.band * 0.46;
  const pitch = g.l / g.slats;
  const bulge = pitch * 0.2;
  let d = '';
  for (let j = 0; j < g.slats; j++) {
    const p = along(g, offset + shift + j * pitch);
    const inner = project(g, p.x - p.nx * half, p.z - p.nz * half);
    const outer = project(g, p.x + p.nx * half, p.z + p.nz * half);
    const mid = project(g, p.x + p.tx * bulge, p.z + p.tz * bulge);
    d += `M${inner.x.toFixed(1)} ${inner.y.toFixed(1)}Q${(2 * mid.x - (inner.x + outer.x) / 2).toFixed(1)} ${(2 * mid.y - (inner.y + outer.y) / 2).toFixed(1)} ${outer.x.toFixed(1)} ${outer.y.toFixed(1)}`;
  }
  return d;
}

function pose(g: Geo, offset: number, i: number) {
  const p = along(g, offset - i * g.pitch);
  const q = project(g, p.x, p.z);
  return { x: q.x, y: q.y, k: q.k, depth: (p.z + g.r) / (2 * g.r) };
}

function centerOf(g: Geo, offset: number) {
  return ((Math.round((offset - g.s / 2) / g.pitch) % g.n) + g.n) % g.n;
}

function pad(value: number) {
  return String(value).padStart(2, '0');
}

export function MochiBelt({
  items,
  eyebrow,
  heading,
  caption,
  action,
  speed = 26,
  paused: pausedProp,
  onPausedChange,
  autoplay = false,
  interval = 3000,
  active: activeProp,
  onActiveChange,
  onOpenChange,
  onOrder,
  labels = DEFAULT_LABELS,
  className,
  ...rest
}: MochiBeltProps) {
  const uid = React.useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const count = items.length;
  const sectionRef = React.useRef<HTMLElement | null>(null);
  const stageRef = React.useRef<HTMLDivElement | null>(null);
  const beltRef = React.useRef<HTMLDivElement | null>(null);
  const seamRef = React.useRef<SVGPathElement | null>(null);
  const glintRef = React.useRef<SVGPathElement | null>(null);
  const plates = React.useRef<(HTMLButtonElement | null)[]>([]);
  const lifts = React.useRef<(HTMLSpanElement | null)[]>([]);
  const shades = React.useRef<(HTMLSpanElement | null)[]>([]);
  const shadows = React.useRef<(HTMLSpanElement | null)[]>([]);
  const anchors = React.useRef<(HTMLSpanElement | null)[]>([]);
  const sim = React.useRef(makeSim());
  const pointer = React.useRef({ id: -1, index: -1, x: 0, y: 0, moved: false, start: 0, lane: 1, lastX: 0, lastT: 0, v: 0 });
  const pendingOpen = React.useRef(-1);
  const returnFocus = React.useRef<number | null>(null);
  const autoActive = React.useRef<number | null>(null);
  const autoLast = React.useRef<number | null>(null);
  const [size, setSize] = React.useState({ section: 0, stage: 0 });
  const [innerActive, setInnerActive] = React.useState<number | null>(null);
  const [innerPaused, setInnerPaused] = React.useState(false);
  const [openIndex, setOpenIndex] = React.useState<number | null>(null);
  const [lifted, setLifted] = React.useState<number | null>(null);
  const [reduced, setReduced] = React.useState(
    () => typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  );
  const [playing, setPlaying] = React.useState(autoplay);
  const [center, setCenter] = React.useState(0);
  const [failed, setFailed] = React.useState<Record<string, boolean>>({});

  const requested = activeProp !== undefined ? activeProp : innerActive;
  const active = requested !== null && requested >= 0 && requested < count ? requested : null;
  const paused = pausedProp ?? innerPaused;
  const wide = size.section >= WIDE;
  const narrow = size.section > 0 && size.section < 480;
  const kb = narrow ? 0.6 : 0.68;

  const geo = React.useMemo(() => {
    if (!size.stage || count === 0) return null;
    const span = halfSpan(makeGeo(1000, count, 100, kb)) / 100;
    const cap = wide ? 150 : clamp(size.section * 0.143, 96, 150);
    const fit = (size.stage - 8) / (2 * span);
    return makeGeo(size.stage, count, Math.round(clamp(fit, Math.min(96, cap), cap)), kb);
  }, [size.stage, size.section, count, kb, wide]);

  const live = React.useRef({
    geo: null as Geo | null,
    active: null as number | null,
    paused: false,
    reduced: false,
    open: false,
    count: 0,
    speed: 26,
    activeControlled: false,
    pausedControlled: false,
    onActiveChange: undefined as ((index: number | null) => void) | undefined,
    onPausedChange: undefined as ((value: boolean) => void) | undefined,
    onOpenChange: undefined as ((index: number | null) => void) | undefined,
    onOrder: undefined as ((item: BeltDish) => void) | undefined,
  });
  live.current = {
    geo, active, paused, reduced, open: openIndex !== null, count, speed: Math.max(0, speed),
    activeControlled: activeProp !== undefined, pausedControlled: pausedProp !== undefined,
    onActiveChange, onPausedChange, onOpenChange, onOrder,
  };

  const paintPlate = React.useCallback((i: number) => {
    const L = live.current;
    const g = L.geo;
    const s = sim.current;
    const button = plates.current[i];
    if (!g || !button) return;
    const q = pose(g, s.offset, i);
    const e = s.lift[i] ?? 0;
    button.style.transform = `translate3d(${(q.x - g.d / 2).toFixed(2)}px,${(q.y - (g.d * TILT) / 2).toFixed(2)}px,0) scale(${q.k.toFixed(4)})`;
    const z = i === L.active ? 2000 : 100 + Math.round(q.y);
    if (s.z[i] !== z) { s.z[i] = z; button.style.zIndex = String(z); }
    const lane = q.depth >= 0.5 ? 'front' : 'back';
    if (s.lane[i] !== lane) { s.lane[i] = lane; button.dataset.lane = lane; }
    const lift = lifts.current[i];
    if (lift) lift.style.transform = `translateY(${(LIFT_Y * e).toFixed(3)}%) scale(${(1 + LIFT_SCALE * e).toFixed(4)})`;
    const shade = shades.current[i];
    if (shade) shade.style.opacity = (BACK_SHADE * clamp(1 - q.depth, 0, 1) * (1 - 0.7 * clamp(e, 0, 1))).toFixed(3);
    const shadow = shadows.current[i];
    if (shadow) {
      shadow.style.transform = `translate3d(0,${(g.d * TILT * 0.05 * e).toFixed(2)}px,0) scale(${(1 + 0.14 * e).toFixed(3)})`;
      shadow.style.opacity = (1 - 0.5 * clamp(e, 0, 1)).toFixed(3);
    }
    const anchor = anchors.current[i];
    if (anchor) anchor.style.transform = `scale(${(1 / (q.k * (1 + LIFT_SCALE * e))).toFixed(4)})`;
  }, []);

  const paintBelt = React.useCallback(() => {
    const L = live.current;
    const g = L.geo;
    const s = sim.current;
    if (!g) return;
    seamRef.current?.setAttribute('d', slatPath(g, s.offset, 0));
    glintRef.current?.setAttribute('d', slatPath(g, s.offset, -Math.max(1.4, g.d * 0.024)));
    const v = (Math.abs(s.v) < 0.005 ? 0 : s.v).toFixed(2);
    if (v !== s.published) { s.published = v; beltRef.current?.style.setProperty('--belt-v', v); }
    const c = centerOf(g, s.offset);
    if (c !== s.center) { s.center = c; setCenter(c); }
  }, []);

  const paintAll = React.useCallback(() => {
    for (let i = 0; i < live.current.count; i++) paintPlate(i);
    paintBelt();
  }, [paintPlate, paintBelt]);

  const hitTest = React.useCallback((px: number, py: number) => {
    const L = live.current;
    const g = L.geo;
    const s = sim.current;
    if (!g) return null;
    let best: number | null = null;
    let bestY = -Infinity;
    for (let i = 0; i < L.count; i++) {
      const q = pose(g, s.offset, i);
      const e = clamp(s.lift[i] ?? 0, 0, 1.2);
      const grow = (1 + LIFT_SCALE * e) * (i === L.active ? 1.1 : 1);
      const rx = (g.d * q.k * grow) / 2;
      const ry = (g.d * TILT * q.k * grow) / 2;
      const dx = (px - q.x) / rx;
      const dy = (py - (q.y + (LIFT_Y / 100) * g.d * TILT * q.k * e)) / ry;
      if (dx * dx + dy * dy > 1) continue;
      if (i === L.active) return i;
      if (q.y > bestY) { best = i; bestY = q.y; }
    }
    return best;
  }, []);

  const hoverRef = React.useRef<(hit: number | null) => void>(() => {});

  const tick = React.useCallback((now: number) => {
    const s = sim.current;
    const L = live.current;
    const g = L.geo;
    s.raf = 0;
    if (!g || !s.visible) { s.last = 0; return; }
    const dt = s.last ? clamp((now - s.last) / 1000, 0, 0.25) : 1 / 60;
    s.last = now;
    // Sub-pasos: mantienen estables los muelles y la cinta en tiempo real.
    const steps = Math.max(1, Math.ceil(dt / 0.017));
    const h = dt / steps;
    const stopped = L.paused || L.active !== null || L.open;
    const cruise = L.reduced ? 0 : L.speed;
    for (let step = 0; step < steps; step++) {
      if (s.mode === SEEK) {
        const w = 5.6;
        s.v += (w * w * (s.target - s.offset) - 2 * w * s.v) * h;
        s.offset += s.v * h;
        if (Math.abs(s.target - s.offset) < 0.3 && Math.abs(s.v) < 4) { s.offset = s.target; s.v = 0; s.mode = RUN; }
      } else if (s.mode === RUN) {
        if (stopped) {
          s.v *= Math.exp(-7.2 * h);
          if (Math.abs(s.v) < 0.02) s.v = 0;
        } else {
          let e = s.v - cruise;
          if (Math.abs(e) > Math.max(6, cruise * 0.5)) e = Math.sign(e) * Math.max(0, Math.abs(e) * Math.exp(-2.4 * h) - 90 * h);
          else e *= Math.exp(-3.4 * h);
          s.v = cruise + (Math.abs(e) < 0.01 ? 0 : e);
        }
        s.offset += s.v * h;
      }
      for (let i = 0; i < L.count; i++) {
        const goal = i === L.active ? 1 : 0;
        if (L.reduced) { s.lift[i] = goal; s.vlift[i] = 0; continue; }
        const x = s.lift[i] ?? 0;
        const v = (s.vlift[i] ?? 0) + (330 * (goal - x) - 23 * (s.vlift[i] ?? 0)) * h;
        s.lift[i] = x + v * h;
        s.vlift[i] = v;
      }
    }
    let busy = s.mode !== RUN || s.v !== 0 || (!stopped && cruise > 0);
    for (let i = 0; i < L.count; i++) {
      const goal = i === L.active ? 1 : 0;
      if (Math.abs(goal - (s.lift[i] ?? 0)) < 0.002 && Math.abs(s.vlift[i] ?? 0) < 0.02) { s.lift[i] = goal; s.vlift[i] = 0; }
      else busy = true;
    }
    if (s.inside && !s.lock && s.mode === RUN && !L.open && pointer.current.id < 0 && Math.abs(s.v) > 0.3) {
      const hit = hitTest(s.px, s.py);
      if (hit !== null && hit !== L.active) hoverRef.current(hit);
    }
    paintAll();
    if (busy) s.raf = requestAnimationFrame(tick);
    else s.last = 0;
  }, [hitTest, paintAll]);

  const kick = React.useCallback(() => {
    const s = sim.current;
    if (s.raf || !s.visible) return;
    s.last = 0;
    s.raf = requestAnimationFrame(tick);
  }, [tick]);

  const setActive = React.useCallback((next: number | null) => {
    const L = live.current;
    if (L.active === next) return;
    if (!L.activeControlled) { L.active = next; setInnerActive(next); }
    L.onActiveChange?.(next);
    kick();
  }, [kick]);

  const stop = React.useCallback(() => {
    setPlaying(false);
    const s = sim.current;
    s.touched = true;
    if (s.mode === SEEK) s.mode = RUN;
    const auto = autoActive.current;
    if (auto !== null) {
      autoActive.current = null;
      if (live.current.active === auto) setActive(null);
    }
  }, [setActive]);

  const seekTo = React.useCallback((index: number) => {
    const s = sim.current;
    const g = live.current.geo;
    if (!g) return;
    const base = g.s / 2 + index * g.pitch;
    s.target = base + Math.round((s.offset - base) / g.l) * g.l;
    if (live.current.reduced) { s.offset = s.target; s.v = 0; s.mode = RUN; paintAll(); return; }
    s.mode = SEEK;
    kick();
  }, [kick, paintAll]);

  const focusVisible = () => !!stageRef.current?.querySelector('[data-dish]:focus-visible');

  hoverRef.current = (hit: number | null) => {
    const current = live.current.active;
    if (hit === current) {
      // El visitante toma el plato que el autoplay levanto: el autoplay para.
      if (hit !== null && autoActive.current === hit) { autoActive.current = null; setPlaying(false); }
      return;
    }
    if (hit !== null) { stop(); setActive(hit); return; }
    if (current !== null && current !== autoActive.current && !focusVisible()) setActive(null);
  };

  const open = React.useCallback((index: number) => {
    stop();
    setActive(index);
    const s = sim.current;
    s.v = 0;
    s.mode = RUN;
    live.current.open = true;
    paintBelt();
    setOpenIndex(index);
    live.current.onOpenChange?.(index);
  }, [stop, setActive, paintBelt]);

  const close = React.useCallback(() => {
    live.current.open = false;
    setOpenIndex(null);
    live.current.onOpenChange?.(null);
    kick();
  }, [kick]);

  const go = (index: number, focus: boolean) => {
    if (count === 0) return;
    const next = ((index % count) + count) % count;
    stop();
    if (focus) plates.current[next]?.focus({ preventScroll: true });
    setActive(next);
    seekTo(next);
  };

  const togglePause = () => {
    stop();
    const L = live.current;
    const next = !L.paused;
    if (!L.pausedControlled) { L.paused = next; setInnerPaused(next); }
    L.onPausedChange?.(next);
    if (!next && L.active !== null && !focusVisible() && !sim.current.inside) setActive(null);
    kick();
  };

  React.useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReduced(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);

  React.useEffect(() => { setPlaying(autoplay); }, [autoplay]);

  React.useLayoutEffect(() => {
    const section = sectionRef.current;
    const stage = stageRef.current;
    if (!section || !stage) return undefined;
    const measure = () => {
      const next = { section: Math.round(section.clientWidth), stage: Math.round(stage.clientWidth) };
      setSize((old) => (old.section === next.section && old.stage === next.stage ? old : next));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(section);
    observer.observe(stage);
    return () => observer.disconnect();
  }, [count > 0]);

  React.useLayoutEffect(() => {
    const s = sim.current;
    if (!geo) return;
    if (!s.init) {
      s.init = true;
      s.offset = geo.s / 2 - Math.min(live.current.speed * 1.62, geo.pitch * 0.45);
      s.v = live.current.reduced || live.current.paused ? 0 : live.current.speed;
    } else if (s.l > 0 && s.l !== geo.l) {
      const f = geo.l / s.l;
      s.offset *= f;
      s.target *= f;
    }
    if (live.current.reduced) {
      s.v = 0;
      if (s.mode !== DRAG) s.mode = RUN;
      if (!s.touched) s.offset = geo.s / 2;
    }
    s.l = geo.l;
    s.z = [];
    s.lane = [];
    paintAll();
    kick();
  }, [geo, items, reduced, paintAll, kick]);

  React.useEffect(() => { kick(); }, [active, paused, openIndex, reduced, speed, kick]);

  React.useEffect(() => {
    const node = sectionRef.current;
    const s = sim.current;
    let inView = true;
    const update = () => {
      const visible = inView && !document.hidden;
      if (visible === s.visible) return;
      s.visible = visible;
      if (visible) kick();
      else if (s.raf) { cancelAnimationFrame(s.raf); s.raf = 0; s.last = 0; }
    };
    const observer = node && typeof IntersectionObserver === 'function'
      ? new IntersectionObserver((entries) => { inView = entries.some((entry) => entry.isIntersecting); update(); })
      : null;
    if (node && observer) observer.observe(node);
    document.addEventListener('visibilitychange', update);
    update();
    return () => { observer?.disconnect(); document.removeEventListener('visibilitychange', update); };
  }, [kick]);

  React.useEffect(() => () => {
    const s = sim.current;
    if (s.raf) cancelAnimationFrame(s.raf);
    s.raf = 0;
    s.last = 0;
  }, []);

  const geoReady = geo !== null;
  React.useEffect(() => {
    if (!playing || reduced || paused || openIndex !== null || count === 0 || !geoReady) return undefined;
    let timer = 0;
    const show = () => {
      const g = live.current.geo;
      if (!g) return;
      const last = autoLast.current;
      const index = last === null
        ? centerOf(g, sim.current.offset + live.current.speed * 0.25)
        : (last + 1) % count;
      autoLast.current = index;
      autoActive.current = index;
      setActive(index);
      seekTo(index);
      timer = window.setTimeout(() => {
        if (autoActive.current === index) {
          autoActive.current = null;
          if (live.current.active === index) setActive(null);
        }
        timer = window.setTimeout(show, Math.max(300, interval - HOLD));
      }, HOLD);
    };
    timer = window.setTimeout(show, autoLast.current === null ? 1600 : Math.max(300, interval - HOLD));
    return () => window.clearTimeout(timer);
  }, [playing, reduced, paused, openIndex, count, interval, geoReady, setActive, seekTo]);

  React.useLayoutEffect(() => {
    if (openIndex !== null || lifted !== null || returnFocus.current === null) return;
    const index = returnFocus.current;
    returnFocus.current = null;
    plates.current[index]?.focus({ preventScroll: true });
  }, [openIndex, lifted]);

  const local = (event: React.PointerEvent) => {
    const box = stageRef.current?.getBoundingClientRect();
    return { x: event.clientX - (box?.left ?? 0), y: event.clientY - (box?.top ?? 0) };
  };

  const onPointerDown = (event: React.PointerEvent) => {
    const g = live.current.geo;
    if (event.button !== 0 || !g) return;
    const at = local(event);
    const hit = hitTest(at.x, at.y);
    pendingOpen.current = -1;
    pointer.current = {
      id: event.pointerId, index: hit ?? -1, x: event.clientX, y: event.clientY, moved: false,
      start: sim.current.offset, lane: at.y >= g.ym ? 1 : -1, lastX: event.clientX, lastT: event.timeStamp, v: 0,
    };
  };

  const onPointerMove = (event: React.PointerEvent) => {
    const s = sim.current;
    const p = pointer.current;
    const stage = stageRef.current;
    const g = live.current.geo;
    if (!stage || !g) return;
    const at = local(event);
    if (event.pointerType === 'mouse') { s.px = at.x; s.py = at.y; s.inside = true; }
    if (p.id === event.pointerId) {
      const dx = event.clientX - p.x;
      const now = event.timeStamp;
      if (!p.moved && Math.abs(dx) > 6 && Math.abs(dx) > Math.abs(event.clientY - p.y)) {
        p.moved = true;
        stop();
        setActive(null);
        s.mode = DRAG;
        if (stage.isConnected) stage.setPointerCapture(event.pointerId);
      }
      if (p.moved) {
        const v = (event.clientX - p.lastX) / Math.max(1, now - p.lastT);
        p.v = p.v * 0.6 + v * 0.4;
        p.lastX = event.clientX;
        p.lastT = now;
        const scale = p.lane > 0 ? 1 : 1 / g.kb;
        s.offset = p.start - p.lane * dx * scale;
        s.v = live.current.reduced ? 0 : -p.lane * p.v * 1000 * scale;
        kick();
      }
      return;
    }
    if (event.pointerType !== 'mouse' || live.current.open) return;
    if (s.lock) {
      if (Math.hypot(at.x - s.lockX, at.y - s.lockY) < 4) return;
      s.lock = false;
    }
    hoverRef.current(hitTest(at.x, at.y));
  };

  const finishPointer = (event: React.PointerEvent, cancelled: boolean) => {
    const p = pointer.current;
    if (p.id !== event.pointerId) return;
    const s = sim.current;
    const stage = stageRef.current;
    if (stage?.hasPointerCapture(event.pointerId)) stage.releasePointerCapture(event.pointerId);
    pointer.current = { ...p, id: -1 };
    if (s.mode === DRAG) {
      s.mode = RUN;
      // Soltar quieto disipa el impulso (constante de tiempo ~70 ms).
      const carry = Math.exp(-Math.max(0, event.timeStamp - p.lastT) / 70);
      s.v = live.current.reduced ? 0 : clamp(s.v * carry, -1400, 1400);
      if (event.pointerType === 'mouse') {
        const at = local(event);
        s.lock = true;
        s.lockX = at.x;
        s.lockY = at.y;
      }
      kick();
      return;
    }
    if (cancelled || p.moved) return;
    const touch = event.pointerType !== 'mouse';
    if (p.index < 0) {
      if (touch && live.current.active !== null) { stop(); setActive(null); }
      return;
    }
    stop();
    if (touch && live.current.active !== p.index) setActive(p.index);
    else pendingOpen.current = p.index;
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key) || count === 0) return;
    event.preventDefault();
    const own = (event.target as HTMLElement).closest('[data-dish]')?.getAttribute('data-dish');
    const from = own != null ? Number(own) : (active ?? center);
    go(event.key === 'Home' ? 0 : event.key === 'End' ? count - 1 : from + (event.key === 'ArrowRight' ? 1 : -1), true);
  };

  const openSource = React.useCallback(
    () => (openIndex === null ? null : lifts.current[openIndex]?.getBoundingClientRect() ?? null),
    [openIndex],
  );
  const onLift = React.useCallback((on: boolean) => setLifted(on ? openIndex : null), [openIndex]);
  const onDialogClose = React.useCallback(() => { returnFocus.current = openIndex; close(); }, [openIndex, close]);
  const onDialogOrder = React.useCallback(() => {
    const item = openIndex === null ? undefined : items[openIndex];
    if (item) live.current.onOrder?.(item);
  }, [openIndex, items]);

  const paths = React.useMemo(
    () => (geo ? {
      outer: edgePath(geo, geo.band / 2),
      inner: edgePath(geo, -geo.band / 2),
      island: edgePath(geo, -geo.band / 2 - geo.d * 0.035),
    } : null),
    [geo],
  );
  const current = active === null ? null : items[active] ?? null;
  const roving = active ?? center;
  const g = geo;

  const header = (eyebrow || heading) && (
    <div className={`belt-head ${wide ? 'belt-head--wide' : 'belt-head--stack'}`}>
      {eyebrow && <p className="belt-eyebrow">{eyebrow}</p>}
      {heading && <h2 className="belt-title">{heading}</h2>}
    </div>
  );

  const captionNode = (
    <div
      id={`${uid}-caption`}
      aria-live="polite"
      data-caption
      className={`belt-caption ${wide ? 'belt-caption--wide' : 'belt-caption--stack'}`}
    >
      <p className={current ? 'belt-caption__name' : 'belt-caption__idle'}>
        {current ? (
          <>
            {current.name}
            <span className="belt-caption__price"> · {current.price}</span>
          </>
        ) : caption}
      </p>
      {current?.description && <p className="belt-caption__desc">{current.description}</p>}
    </div>
  );

  const controls = count > 1 && (
    <div className="belt-ctrl">
      <button
        type="button"
        data-control="previous"
        className="belt-btn"
        aria-label={labels.previous}
        onClick={() => go((live.current.active ?? sim.current.center) - 1, false)}
      >
        <svg aria-hidden="true" viewBox="0 0 16 16" className="belt-btn__icon" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M10 3.5 5.5 8l4.5 4.5" /></svg>
      </button>
      <button
        type="button"
        data-control="pause"
        className="belt-btn"
        aria-label={labels.pause ?? DEFAULT_LABELS.pause}
        aria-pressed={paused}
        onClick={togglePause}
      >
        {paused ? (
          <svg aria-hidden="true" viewBox="0 0 16 16" className="belt-btn__icon" fill="currentColor"><path d="M5 3.4v9.2a.6.6 0 0 0 .9.5l7.4-4.6a.6.6 0 0 0 0-1L5.9 2.9a.6.6 0 0 0-.9.5Z" /></svg>
        ) : (
          <svg aria-hidden="true" viewBox="0 0 16 16" className="belt-btn__icon" fill="currentColor"><rect x="4" y="3" width="2.6" height="10" rx="0.8" /><rect x="9.4" y="3" width="2.6" height="10" rx="0.8" /></svg>
        )}
      </button>
      <button
        type="button"
        data-control="next"
        className="belt-btn"
        aria-label={labels.next}
        onClick={() => go((live.current.active ?? sim.current.center) + 1, false)}
      >
        <svg aria-hidden="true" viewBox="0 0 16 16" className="belt-btn__icon" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M6 3.5 10.5 8 6 12.5" /></svg>
      </button>
    </div>
  );

  const stage = count > 0 && (
    <div
      ref={stageRef}
      data-stage
      role="group"
      aria-label={heading ?? labels.belt ?? DEFAULT_LABELS.belt}
      aria-roledescription="cinta transportadora"
      className="belt-stage"
      style={{ height: g ? g.height : 260, overflowX: 'clip' }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(event) => finishPointer(event, false)}
      onPointerCancel={(event) => finishPointer(event, true)}
      onPointerLeave={(event) => {
        if (event.pointerType !== 'mouse') return;
        const s = sim.current;
        s.inside = false;
        s.lock = false;
        const currentActive = live.current.active;
        if (pointer.current.id < 0 && !live.current.open && currentActive !== null && currentActive !== autoActive.current && !focusVisible()) setActive(null);
      }}
      onBlur={(event) => {
        const next = event.relatedTarget as Node | null;
        if ((next && stageRef.current?.contains(next)) || live.current.open || sim.current.inside) return;
        const currentActive = live.current.active;
        if (currentActive !== null && currentActive !== autoActive.current) setActive(null);
      }}
      onKeyDown={onKeyDown}
    >
      {g && (
        <div
          aria-hidden="true"
          data-counter
          className="belt-counter"
          style={{
            top: Math.max(0, g.edgeTop - g.d * 0.34),
            height: g.ym - Math.max(0, g.edgeTop - g.d * 0.34),
          }}
        />
      )}
      <div ref={beltRef} data-belt aria-hidden="true" className="belt-svg-wrap">
        {g && paths && (
          <svg className="belt-svg" width={g.width} height={g.height} viewBox={`0 0 ${g.width} ${g.height}`} focusable="false">
            <defs>
              <filter id={`${uid}-soft`} x="-10%" y="-30%" width="120%" height="160%">
                <feGaussianBlur stdDeviation={(g.d * 0.06).toFixed(1)} />
              </filter>
              <linearGradient id={`${uid}-island`} x1="0" x2="0" y1="0" y2="1">
                <stop offset="0" style={{ stopColor: 'var(--island)' }} />
                <stop offset="1" style={{ stopColor: 'var(--island-low)' }} />
              </linearGradient>
            </defs>
            <path d={paths.outer} transform={`translate(0 ${(g.side + g.d * 0.07).toFixed(1)})`} fill="black" className="belt-shadow" filter={`url(#${uid}-soft)`} />
            <path d={`${paths.outer}${paths.inner}`} fillRule="evenodd" transform={`translate(0 ${g.side.toFixed(1)})`} style={{ fill: 'var(--belt-side)' }} />
            <path d={`${paths.outer}${paths.inner}`} fillRule="evenodd" style={{ fill: 'var(--belt)' }} />
            <path ref={seamRef} fill="none" stroke="black" strokeOpacity={0.42} strokeWidth={Math.max(1, g.d * 0.013)} strokeLinecap="round" />
            <path ref={glintRef} fill="none" stroke="white" strokeOpacity={0.14} strokeWidth={Math.max(0.8, g.d * 0.009)} strokeLinecap="round" />
            <path d={paths.outer} fill="none" style={{ stroke: 'var(--rail)' }} strokeWidth={Math.max(2, g.d * 0.026)} />
            <path d={paths.outer} fill="none" stroke="white" strokeOpacity={0.55} strokeWidth={Math.max(0.8, g.d * 0.008)} transform="translate(0 -0.8)" />
            <path d={paths.inner} fill="none" style={{ stroke: 'var(--rail)' }} strokeWidth={Math.max(1.6, g.d * 0.02)} />
            <path d={paths.inner} fill="none" stroke="white" strokeOpacity={0.4} strokeWidth={Math.max(0.8, g.d * 0.008)} transform="translate(0 -0.7)" />
            <path d={paths.island} style={{ fill: 'var(--island-wall)' }} />
            <path d={paths.island} transform={`translate(0 ${(-g.side * 0.6).toFixed(1)})`} style={{ fill: `url(#${uid}-island)` }} />
            <path d={paths.island} transform={`translate(0 ${(-g.side * 0.6 - 0.6).toFixed(1)})`} fill="none" stroke="white" strokeOpacity={0.55} strokeWidth={Math.max(0.8, g.d * 0.008)} />
          </svg>
        )}
      </div>
      {g && items.map((item, i) => {
        const isActive = active === i;
        const broken = !!failed[item.id];
        const mask = `url("${item.image}") 0 0 / 100% 100% no-repeat`;
        return (
          <button
            key={item.id}
            ref={(node) => { plates.current[i] = node; }}
            type="button"
            data-dish={i}
            data-active={isActive || undefined}
            tabIndex={i === roving ? 0 : -1}
            aria-label={`${item.name}, ${item.price}`}
            aria-describedby={`${uid}-caption`}
            aria-haspopup="dialog"
            aria-current={isActive || undefined}
            className="belt-plate"
            style={{ width: g.d, height: g.d * TILT, visibility: lifted === i ? 'hidden' : undefined }}
            onFocus={() => { if (pointer.current.id < 0) { stop(); setActive(i); } }}
            onClick={(event) => {
              const pending = pendingOpen.current;
              pendingOpen.current = -1;
              if (event.detail === 0 || pending === i) open(i);
            }}
          >
            <span aria-hidden="true" className="belt-plate__shadow-wrap">
              <span ref={(node) => { shadows.current[i] = node; }} className="belt-plate__shadow" />
            </span>
            <span ref={(node) => { lifts.current[i] = node; }} data-lift className="belt-plate__lift">
              <span aria-hidden="true" data-placeholder className={`belt-plate__placeholder ${broken ? 'belt-plate__placeholder--broken' : ''}`}>
                <span className="belt-plate__placeholder-dot" />
              </span>
              {!broken && (
                <img
                  src={item.image}
                  alt=""
                  draggable={false}
                  onError={() => setFailed((old) => (old[item.id] ? old : { ...old, [item.id]: true }))}
                  className="belt-plate__img"
                />
              )}
              {!broken && (
                <span
                  ref={(node) => { shades.current[i] = node; }}
                  aria-hidden="true"
                  className="belt-plate__shade"
                  style={{ opacity: 0, WebkitMask: mask, mask }}
                />
              )}
              <span aria-hidden="true" data-ring className="belt-plate__ring" style={{ borderColor: item.accent }} />
              {item.ribbon && <span aria-hidden="true" className="belt-plate__ribbon" style={{ background: item.accent }}>{item.ribbon}</span>}
              <span ref={(node) => { anchors.current[i] = node; }} aria-hidden="true" className="belt-plate__anchor">
                <span
                  data-chip
                  className={`belt-chip ${isActive && lifted !== i ? 'belt-chip--on' : ''}`}
                >
                  <span className="belt-chip__dot" style={{ background: item.accent }} />
                  {item.name}
                  <span className="belt-chip__price">{item.price}</span>
                </span>
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );

  return (
    <section
      {...rest}
      ref={sectionRef}
      data-slot="mochi-belt"
      data-layout={wide ? 'wide' : 'stack'}
      data-active={active ?? ''}
      data-open={openIndex ?? ''}
      data-paused={paused || undefined}
      data-center={center}
      className={`belt ${className ?? ''}`}
    >
      {wide ? (
        <div className="belt-layout belt-layout--wide">
          <div className="belt-side">
            {header}
            {captionNode}
            {action}
          </div>
          <div className="belt-main">
            {stage}
            {controls}
          </div>
        </div>
      ) : (
        <div className="belt-layout belt-layout--stack">
          {header}
          <div className="belt-main">{stage}</div>
          {controls}
          {captionNode}
          {action && <div className="belt-action">{action}</div>}
        </div>
      )}
      {openIndex !== null && items[openIndex] && (
        <BeltDialog
          uid={uid}
          item={items[openIndex]}
          index={openIndex}
          total={count}
          labels={labels}
          reduced={reduced}
          broken={!!failed[items[openIndex].id]}
          source={openSource}
          onLift={onLift}
          onOrder={onDialogOrder}
          onClose={onDialogClose}
        />
      )}
    </section>
  );
}

function BeltDialog({
  uid, item, index, total, labels, reduced, broken, source, onLift, onOrder, onClose,
}: {
  uid: string;
  item: BeltDish;
  index: number;
  total: number;
  labels: BeltLabels;
  reduced: boolean;
  broken: boolean;
  source: () => DOMRect | null;
  onLift: (lifted: boolean) => void;
  onOrder: () => void;
  onClose: () => void;
}) {
  const dialogRef = React.useRef<HTMLDivElement | null>(null);
  const figureRef = React.useRef<HTMLDivElement | null>(null);
  const closeRef = React.useRef<HTMLButtonElement | null>(null);
  const timer = React.useRef(0);
  const closing = React.useRef(false);
  const [shown, setShown] = React.useState(false);
  const [ordered, setOrdered] = React.useState(false);
  const titleId = `${uid}-dish-title`;

  React.useLayoutEffect(() => {
    const figure = figureRef.current;
    const from = source();
    closeRef.current?.focus({ preventScroll: true });
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    onLift(true);
    let animation: Animation | null = null;
    if (figure && from && !reduced && from.width > 0) {
      const to = figure.getBoundingClientRect();
      const sx = from.width / to.width;
      const sy = from.height / to.height;
      const dx = from.left + from.width / 2 - (to.left + to.width / 2);
      const dy = from.top + from.height / 2 - (to.top + to.height / 2);
      const rise = Math.min(120, Math.abs(dy) * 0.3 + 40);
      animation = figure.animate([
        { transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})` },
        { transform: `translate(${dx * 0.42}px, ${dy * 0.42 - rise}px) scale(${((sx + 1) / 2) * 1.05}, ${((sy + 1) / 2) * 1.05}) rotate(${dx > 0 ? -6 : 6}deg)`, offset: 0.5 },
        { transform: 'none' },
      ], { duration: 680, easing: 'cubic-bezier(.22,.85,.3,1)' });
    }
    const raf = requestAnimationFrame(() => setShown(true));
    return () => {
      cancelAnimationFrame(raf);
      animation?.cancel();
      window.clearTimeout(timer.current);
      document.body.style.overflow = overflow;
      onLift(false);
    };
  }, [source, reduced, onLift]);

  const dismiss = React.useCallback(() => {
    if (closing.current) return;
    closing.current = true;
    setShown(false);
    const figure = figureRef.current;
    const to = source();
    if (!figure || !to || reduced || to.width === 0) { onClose(); return; }
    const from = figure.getBoundingClientRect();
    const sx = to.width / from.width;
    const sy = to.height / from.height;
    const dx = to.left + to.width / 2 - (from.left + from.width / 2);
    const dy = to.top + to.height / 2 - (from.top + from.height / 2);
    const animation = figure.animate([
      { transform: 'none' },
      { transform: `translate(${dx * 0.58}px, ${dy * 0.58 - 36}px) scale(${(sx + 1) / 2}, ${(sy + 1) / 2})`, offset: 0.55 },
      { transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})` },
    ], { duration: 540, easing: 'cubic-bezier(.45,0,.55,1)', fill: 'forwards' });
    animation.onfinish = () => onClose();
  }, [source, reduced, onClose]);

  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const dialog = dialogRef.current;
      if (!dialog || dialog.contains(event.target as Node)) return;
      if (event.key === 'Escape') { event.preventDefault(); dismiss(); }
      else if (event.key === 'Tab') {
        const first = dialog.querySelector('button');
        if (first) { event.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [dismiss]);

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') { event.preventDefault(); dismiss(); return; }
    if (event.key !== 'Tab') return;
    const controls = [...(dialogRef.current?.querySelectorAll('button') ?? [])].filter((node) => !node.disabled);
    const first = controls[0];
    const last = controls[controls.length - 1];
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  };

  const order = () => {
    if (ordered || closing.current) return;
    onOrder();
    setOrdered(true);
    timer.current = window.setTimeout(dismiss, reduced ? 0 : 450);
  };

  return createPortal(
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      data-dish-dialog
      className="belt-dialog"
      onKeyDown={onKeyDown}
    >
      <div aria-hidden="true" className={`belt-dialog__backdrop ${shown ? 'is-shown' : ''}`} onClick={dismiss} />
      <div className="belt-dialog__inner">
        <div aria-hidden="true" className={`belt-dialog__card ${shown ? 'is-shown' : ''}`} />
        <button
          ref={closeRef}
          type="button"
          onClick={dismiss}
          className={`belt-dialog__close ${shown ? 'is-shown' : ''}`}
        >
          {labels.close}
          <svg aria-hidden="true" viewBox="0 0 16 16" className="belt-dialog__close-icon" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><path d="M3.5 3.5l9 9M12.5 3.5l-9 9" /></svg>
        </button>
        <div ref={figureRef} data-dish-figure className="belt-dialog__figure">
          <span aria-hidden="true" className="belt-dialog__figure-shadow" />
          {broken ? (
            <span aria-hidden="true" className="belt-dialog__figure-broken" />
          ) : (
            <img src={item.image} alt={item.name} draggable={false} className="belt-dialog__img" />
          )}
          <span aria-hidden="true" className="belt-dialog__ring" style={{ borderColor: item.accent }} />
        </div>
        <div className={`belt-dialog__body ${shown ? 'is-shown' : ''}`}>
          <p className="belt-dialog__meta">
            <span aria-hidden="true" className="belt-dialog__dot" style={{ background: item.accent }} />
            {pad(index + 1)} / {pad(total)}
          </p>
          <h3 id={titleId} className="belt-dialog__title">{item.name}</h3>
          {item.description && <p className="belt-dialog__desc">{item.description}</p>}
          {item.details && item.details.length > 0 && (
            <ul className="belt-dialog__details">
              {item.details.map((detail) => <li key={detail} className="belt-dialog__detail">{detail}</li>)}
            </ul>
          )}
          <div className="belt-dialog__actions">
            <p className="belt-dialog__price">{item.price}</p>
            <button type="button" data-add onClick={order} className="belt-dialog__add">
              {ordered ? (
                <svg aria-hidden="true" viewBox="0 0 16 16" className="belt-dialog__add-icon" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M3.5 8.5l3 3 6-7" /></svg>
              ) : (
                <svg aria-hidden="true" viewBox="0 0 16 16" className="belt-dialog__add-icon" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M8 3.5v9M3.5 8h9" /></svg>
              )}
              {labels.add}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

export default MochiBelt;

// ScrollReveal — aparición suave al hacer scroll (estética 21st.dev).
//
// Anima el DOM existente sin reescribirlo en React: IntersectionObserver +
// Web Animations API (element.animate). El sitio queda idéntico sin JS —
// esto es mejora progresiva, no dependencia. Respeta prefers-reduced-motion.
//
// Reglas:
//  · el estado inicial (opacity 0) se aplica DESDE JS: sin JS el contenido
//    queda visible, nunca invisible;
//  · si el observer no dispara, un watchdog revela lo que ya está en pantalla;
//  · las tarjetas que se pintan después (API de sabores/combos/fechas/IG) se
//    detectan con MutationObserver.
import { useEffect } from 'react';

const SELECTORS = [
  '.hero-text > *',
  '.hero-visual-wrap',
  '.section-head',
  '.step',
  '.ig-card',
  '.why-item',
  '.flavor-card',
  '.combo-card',
  '.release-card',
  '.horario-card',
  '.gallery-item',
];

const CONTAINERS = [
  '#flavor-cards-grid',
  '#combos-grid',
  '#releases-grid',
  '#horarios-grid',
  '#ig-gallery',
];

const PENDING_CLASS = 'reveal-pending';
const DURATION = 620;
const EASING = 'cubic-bezier(0.22, 1, 0.36, 1)';

export function ScrollReveal() {
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const io = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        io.unobserve(entry.target);
        reveal(entry.target as HTMLElement, true);
      }
    }, { threshold: 0.12, rootMargin: '0px 0px -6% 0px' });

    const revealed = new WeakSet<Element>();

    function reveal(el: HTMLElement, animate: boolean) {
      if (revealed.has(el)) return;
      revealed.add(el);

      // ── Fail-open real ──────────────────────────────────────────────────
      // El contenido NUNCA puede depender de que una animacion corra. Chrome
      // congela el reloj de las animaciones cuando la pestana esta en segundo
      // plano (document.hidden), y con `fill: 'backwards'` eso dejaba el
      // keyframe inicial (opacity: 0) pegado indefinidamente: la landing
      // entera quedaba INVISIBLE y no se recuperaba sola.
      //
      // Invariante: tras este bloque el elemento es visible pase lo que pase.
      //   · pestana oculta -> NO animamos (el reloj esta congelado, la
      //     animacion quedaria colgada en opacity 0); quitamos la clase y
      //     listo, visible al instante.
      //   · visible -> animamos con fill:'backwards' (sin parpadeo: el
      //     keyframe 0 cubre desde el frame 0) y quitamos la clase al
      //     terminar; el valor natural (opacity 1) es el mismo que el keyframe
      //     final, asi que no hay salto al final.
      //   · en ambos casos un guard con setTimeout (que SI corre en segundo
      //     plano) cancela la animacion y limpia estilos si algo se queda
      //     colgado. Los timers no dependen del reloj de animacion.
      const finish = () => {
        el.classList.remove(PENDING_CLASS);
        el.style.removeProperty('opacity');
        el.style.removeProperty('transform');
      };

      if (!animate || document.hidden) {
        finish();
        return;
      }

      const anim = el.animate(
        [
          { opacity: 0, transform: 'translateY(22px)' },
          { opacity: 1, transform: 'translateY(0)' },
        ],
        { duration: DURATION, easing: EASING, fill: 'backwards' },
      );

      const guard = window.setTimeout(() => {
        try { anim.cancel(); } catch { /* ya terminada */ }
        finish();
      }, DURATION + 400);

      anim.onfinish = () => {
        window.clearTimeout(guard);
        try { anim.cancel(); } catch { /* ya terminada */ }
        finish();
      };
    }

    /** ¿El elemento esta dentro (o asomando) del viewport? */
    function inViewport(el: Element): boolean {
      const r = el.getBoundingClientRect();
      return r.top < window.innerHeight && r.bottom > 0;
    }

    function prepare(el: Element) {
      if (!(el instanceof HTMLElement)) return;
      if (revealed.has(el) || el.classList.contains(PENDING_CLASS)) return;

      // Lo que YA esta en pantalla al cargar NUNCA se oculta. La isla se
      // monta DESPUES del load (script defer + chunk lazy): si ocultáramos
      // todo al montar, el primer viewport parpadearia en blanco y el
      // titular apareceria ~1.5s tarde (LCP desplomado + salto visible).
      // El reveal es para lo que llega con el scroll, no para lo que ya se ve.
      if (inViewport(el)) {
        revealed.add(el);
        return;
      }

      el.classList.add(PENDING_CLASS);
      io.observe(el);
    }

    function collect(root: ParentNode) {
      root.querySelectorAll<HTMLElement>(SELECTORS.join(',')).forEach(prepare);
    }

    collect(document);

    // Watchdog 1: si el observer no dispara para algo que ya está en pantalla
    // (observer roto, nodo ya visible al observar, carrera con el layout), se
    // revela igual. Nunca dejamos texto invisible.
    const watchdog = window.setTimeout(() => {
      document.querySelectorAll<HTMLElement>('.' + PENDING_CLASS).forEach((el) => {
        const r = el.getBoundingClientRect();
        if (r.top < window.innerHeight && r.bottom > 0) reveal(el, true);
      });
    }, 1200);

    // Watchdog 2 (fail-safe): si el usuario salta a una seccion (ancla, scroll
    // rapido, search) las secciones intermedias nunca intersectan y quedan
    // invisibles para siempre. A los 4s revelamos TODO lo que quede pendiente.
    // Sin animacion: a los 4s la landing ya esta cargada, el movimiento
    // tardio queda raro y suma riesgo de quedar colgado.
    const failsafe = window.setTimeout(() => {
      document.querySelectorAll<HTMLElement>('.' + PENDING_CLASS).forEach((el) => {
        reveal(el, false);
      });
    }, 4000);

    // Red de seguridad por scroll: cualquier bloque pendiente que entre en
    // pantalla se revela, aunque el observer principal no lo haya visto.
    let scrollTick = 0;
    const onScroll = () => {
      if (scrollTick) return;
      scrollTick = window.setTimeout(() => {
        scrollTick = 0;
        document.querySelectorAll<HTMLElement>('.' + PENDING_CLASS).forEach((el) => {
          const r = el.getBoundingClientRect();
          if (r.top < window.innerHeight && r.bottom > 0) reveal(el, true);
        });
      }, 120);
    };
    window.addEventListener('scroll', onScroll, { passive: true });

    const mo = new MutationObserver((records) => {
      for (const record of records) {
        record.addedNodes.forEach((node) => {
          if (node instanceof HTMLElement) {
            if (node.matches(SELECTORS.join(','))) prepare(node);
            collect(node);
          }
        });
      }
    });

    CONTAINERS.forEach((sel) => {
      const el = document.querySelector(sel);
      if (el) mo.observe(el, { childList: true, subtree: true });
    });

    return () => {
      window.clearTimeout(watchdog);
      window.clearTimeout(failsafe);
      window.removeEventListener('scroll', onScroll);
      io.disconnect();
      mo.disconnect();
      document.querySelectorAll<HTMLElement>('.' + PENDING_CLASS).forEach((el) => {
        el.classList.remove(PENDING_CLASS);
      });
    };
  }, []);

  return null;
}

export default ScrollReveal;

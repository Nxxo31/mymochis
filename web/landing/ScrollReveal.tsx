// ScrollReveal — aparición suave al hacer scroll con motion (estética 21st.dev).
//
// Anima el DOM existente sin reescribirlo en React: IntersectionObserver +
// animate() de motion con easing suave. El sitio queda idéntico sin JS —
// esto es mejora progresiva, no dependencia. Respeta prefers-reduced-motion.
import { useEffect } from 'react';
import { animate } from 'motion';

const SELECTORS = [
  '.hero-text > *',
  '.hero-visual-wrap',
  '.section-head',
  '.step',
  '.combo-card',
  '.why-card',
  '.gallery-item',
];

export function ScrollReveal() {
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const targets: HTMLElement[] = [];
    for (const sel of SELECTORS) {
      document.querySelectorAll<HTMLElement>(sel).forEach((el) => {
        el.style.opacity = '0';
        targets.push(el);
      });
    }

    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        io.unobserve(e.target);
        animate(
          e.target as HTMLElement,
          { opacity: [0, 1], y: [24, 0] },
          { duration: 0.55, ease: [0.22, 1, 0.36, 1] },
        );
      }
    }, { threshold: 0.15 });

    targets.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, []);

  return null;
}

export default ScrollReveal;

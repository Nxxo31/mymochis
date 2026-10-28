// Entry point del island de la landing
// Spec: PROJECT.md §21.9 — degradación graciosa si React no monta
import { StrictMode, lazy, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import '../styles/tokens.css';
import '../styles/islands.css';

const HeroBackground = lazy(() => import('./HeroBackground').then(m => ({ default: m.HeroBackground })));
const ScrollReveal = lazy(() => import('./ScrollReveal').then(m => ({ default: m.ScrollReveal })));

interface HeroBgProps {
  colorA?: string;
  colorB?: string;
  colorC?: string;
  intensity?: number;
}

function IslandBg(props: HeroBgProps) {
  return (
    <StrictMode>
      <Suspense fallback={null}>
        <HeroBackground {...props} />
      </Suspense>
    </StrictMode>
  );
}

if (typeof document !== 'undefined') {
  // Variante solo-fondo: el shader de aurora como ambiente de TODA la pagina,
  // detras del contenido (position: fixed via .page-shader en islands.css).
  // Es el reemplazo del hero-island de contenido que se montaba al final del
  // body y aparecia como un segundo footer con shaders.
  document.querySelectorAll<HTMLElement>('[data-island="hero-bg"]').forEach((el) => {
    try {
      const props: HeroBgProps = JSON.parse(el.dataset.props || '{}');
      createRoot(el).render(<IslandBg {...props} />);
    } catch (e) {
      console.warn('[mymochis/hero-bg] mount failed', e);
    }
  });

  // ScrollReveal (21st.dev style): anima el DOM existente al hacer scroll.
  // Siempre activo en la landing — sin él la página es la misma, solo menos
  // movimiento.
  const revealHost = document.createElement('div');
  document.body.appendChild(revealHost);
  createRoot(revealHost).render(
    <StrictMode>
      <Suspense fallback={null}>
        <ScrollReveal />
      </Suspense>
    </StrictMode>
  );
}

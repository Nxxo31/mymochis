// Entry point del island de la landing
// Spec: PROJECT.md §21.9 — degradación graciosa si React no monta
import { StrictMode, lazy, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import '../styles/tokens.css';
import '../styles/islands.css';

const AnimatedHero = lazy(() => import('./AnimatedHero').then(m => ({ default: m.AnimatedHero })));
const HeroBackground = lazy(() => import('./HeroBackground').then(m => ({ default: m.HeroBackground })));

interface MountProps {
  status: string;
  titleHtml: string;
  subtitle: string;
  ctaLabel: string;
  ctaHref: string;
}

function IslandApp(props: MountProps) {
  return (
    <StrictMode>
      <Suspense fallback={null}>
        <HeroBackground />
        <AnimatedHero {...props} />
      </Suspense>
    </StrictMode>
  );
}

export function mountHeroIsland(el: HTMLElement, props: MountProps) {
  const root = createRoot(el);
  root.render(<IslandApp {...props} />);
}

// Auto-mount si el documento tiene <div id="hero-island" data-props='...'>
declare global {
  interface Window { __myMochisMountHero?: typeof mountHeroIsland }
}
window.__myMochisMountHero = mountHeroIsland;

if (typeof document !== 'undefined') {
  document.querySelectorAll<HTMLElement>('[data-island="hero"]').forEach((el) => {
    try {
      const props: MountProps = JSON.parse(el.dataset.props || '{}');
      mountHeroIsland(el, props);
    } catch (e) {
      console.warn('[mymochis/hero-island] mount failed', e);
    }
  });

  // Variante solo-fondo: el shader de aurora como ambiente de TODA la pagina,
  // detras del contenido (position: fixed via .page-shader en islands.css).
  // Es el reemplazo del hero-island de contenido que se montaba al final del
  // body y aparecia como un segundo footer con shaders.
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
  document.querySelectorAll<HTMLElement>('[data-island="hero-bg"]').forEach((el) => {
    try {
      const props: HeroBgProps = JSON.parse(el.dataset.props || '{}');
      createRoot(el).render(<IslandBg {...props} />);
    } catch (e) {
      console.warn('[mymochis/hero-bg] mount failed', e);
    }
  });
}

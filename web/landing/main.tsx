// Entry point del island de la landing
// Spec: PROJECT.md §21.9 — degradación graciosa si React no monta
import { StrictMode, lazy, Suspense, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../styles/tokens.css';
import '../styles/islands.css';
import '../styles/belt.css';

const ShaderBackground = lazy(() => import('./ShaderBackground').then(m => ({ default: m.ShaderBackground })));
const ScrollReveal = lazy(() => import('./ScrollReveal').then(m => ({ default: m.ScrollReveal })));
const MochiBelt = lazy(() => import('./MochiBelt').then(m => ({ default: m.MochiBelt })));

interface HeroBgProps {
  colorA?: string;
  colorB?: string;
  colorC?: string;
  intensity?: number;
  toneShift?: number;
}

function IslandBg(props: HeroBgProps) {
  return (
    <StrictMode>
      <Suspense fallback={null}>
        <ShaderBackground {...props} />
      </Suspense>
    </StrictMode>
  );
}

interface BeltEntry {
  id: string;
  name: string;
  description: string;
  price: number;
  image_url: string;
  category_slug: string;
  category_name: string;
  config: {
    photo?: string;
    accent?: string;
    ribbon?: string | null;
    description_short?: string;
    category?: string;
  };
}

const FALLBACK_PHOTO = 'img/instagram/mochi-08.jpg';

/**
 * Cinta de sabores: los platos son las filas reales de la tabla flavors.
 * El catalogo lo publica el script de la landing (window.__mymochisCatalog)
 * para no repetir la peticion a /api/public, y el filtro de categorias
 * llega por el evento 'mymochis:filter'.
 */
function BeltIsland({ autoplay }: { autoplay?: boolean }) {
  const [entries, setEntries] = useState<BeltEntry[]>([]);
  const [slug, setSlug] = useState<string>('all');

  useEffect(() => {
    const apply = () => {
      const raw = (window as unknown as { __mymochisCatalog?: { flavors?: BeltEntry[] } }).__mymochisCatalog;
      if (raw && raw.flavors) setEntries(raw.flavors);
    };
    apply();
    window.addEventListener('mymochis:catalog', apply);
    // Respaldo: si el evento llego antes del montaje, el reintento lo pilla.
    const retry = window.setTimeout(apply, 1200);
    return () => {
      window.removeEventListener('mymochis:catalog', apply);
      window.clearTimeout(retry);
    };
  }, []);

  useEffect(() => {
    const onFilter = (event: Event) => {
      const detail = (event as CustomEvent<{ slug?: string }>).detail || {};
      setSlug(detail.slug || 'all');
    };
    window.addEventListener('mymochis:filter', onFilter);
    return () => window.removeEventListener('mymochis:filter', onFilter);
  }, []);

  const items = entries
    .filter((e) => slug === 'all' || !e.category_slug || e.category_slug === slug)
    .map((e) => ({
      id: e.id,
      name: e.name,
      description: e.config?.description_short || e.description || '',
      price: `$${Number(e.price || 0).toLocaleString('es-CO')}`,
      accent: e.config?.accent || '#E94560',
      image: e.image_url || e.config?.photo || FALLBACK_PHOTO,
      details: [e.category_name || e.config?.category].filter(Boolean) as string[],
      ribbon: e.config?.ribbon || null,
    }));

  const order = (item: { id: string }) => {
    const open = (window as unknown as { openOrderModal?: (id: string) => void }).openOrderModal;
    if (typeof open === 'function') open(item.id);
  };

  return (
    <MochiBelt
      items={items}
      eyebrow="Sabores de la semana"
      heading="La cinta de esta semana"
      caption="Levanta un mochi con el mouse y tócalo para pedirlo."
      autoplay={autoplay}
      onOrder={order}
    />
  );
}

if (typeof document !== 'undefined') {
  // Variante solo-fondo: el shader Silk (liquido, interactivo, con oscilacion
  // de tonos) como ambiente de TODA la pagina, detras del contenido
  // (position: fixed via .page-shader en islands.css).
  document.querySelectorAll<HTMLElement>('[data-island="hero-bg"]').forEach((el) => {
    try {
      const props: HeroBgProps = JSON.parse(el.dataset.props || '{}');
      createRoot(el).render(<IslandBg {...props} />);
    } catch (e) {
      console.warn('[mymochis/hero-bg] mount failed', e);
    }
  });

  // Cinta de sabores (2026-11-02): el catalogo lo publica la landing (sin una
  // segunda peticion a /api/public) y el filtro de categorias llega por evento.
  document.querySelectorAll<HTMLElement>('[data-island="belt"]').forEach((el) => {
    try {
      const props = JSON.parse(el.dataset.props || '{}');
      createRoot(el).render(
        <StrictMode>
          <Suspense fallback={null}>
            <BeltIsland autoplay={props.autoplay !== false} />
          </Suspense>
        </StrictMode>,
      );
    } catch (e) {
      console.warn('[mymochis/belt] mount failed', e);
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

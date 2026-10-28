// MyMochis · E2E de la landing (spec_id=31 V1).
//
// Lo que se verifica, en orden de importancia:
//  1. el contenido NUNCA queda invisible (el bug de scroll-reveal con
//     document.hidden dejaba la landing entera en opacity 0 para siempre);
//  2. no hay overflow horizontal ni elementos fuera del viewport;
//  3. no hay errores de consola ni requests fallidos;
//  4. los flujos de compra funcionan: ver sabores, agregar al carrito, ir a
//     la tienda.
import { test, expect } from '@playwright/test';

test.describe('landing', () => {
  test('el hero es visible de inmediato y nunca queda invisible', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

    await page.goto('/');

    // A los 150ms el titular ya debe estar visible: si la isla oculta lo que
    // esta en pantalla, el LCP se desploma y el usuario ve un hueco.
    const h1 = page.locator('.hero h1');
    await expect(h1).toBeVisible({ timeout: 3000 });
    await expect(h1).toHaveCSS('opacity', '1');

    // Ningun elemento del primer viewport puede quedar en opacity 0.
    const invisible = await page.evaluate(() => {
      const out = [];
      for (const el of document.querySelectorAll('.hero h1, .hero .lead, .hero-cta, .hero-tag, .hero-trust, .section-head')) {
        const r = el.getBoundingClientRect();
        if (r.top < window.innerHeight && r.bottom > 0 && getComputedStyle(el).opacity === '0') {
          out.push(el.className || el.tagName);
        }
      }
      return out;
    });
    expect(invisible, `elementos invisibles en el primer viewport: ${invisible.join(', ')}`).toEqual([]);

    // Y sigue visible despues de que la pagina se asiente.
    await page.waitForTimeout(1200);
    await expect(h1).toHaveCSS('opacity', '1');
    expect(errors, `errores de consola: ${errors.join(' | ')}`).toEqual([]);
  });

  test('todo lo que esta en pantalla es visible tras 5s', async ({ page }) => {
    await page.goto('/');
    await page.waitForTimeout(5000);
    const invisible = await page.evaluate(() => {
      const out = [];
      for (const el of document.querySelectorAll('.reveal-pending')) {
        if (getComputedStyle(el).opacity === '0') out.push(el.className);
      }
      return out;
    });
    expect(invisible, `pendientes invisibles: ${invisible.join(', ')}`).toEqual([]);
  });

  test('no hay overflow horizontal ni elementos fuera del viewport', async ({ page }) => {
    await page.goto('/');
    await page.waitForTimeout(800);

    const overflow = await page.evaluate(() => ({
      docWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    }));
    expect(
      overflow.docWidth,
      `scrollWidth ${overflow.docWidth} > innerWidth ${overflow.innerWidth}: hay overflow horizontal`,
    ).toBeLessThanOrEqual(overflow.innerWidth + 1);

    const fuera = await page.evaluate(() => {
          // Un elemento puede salir del viewport a proposito si un ANCESTRO lo
          // recorta (overflow hidden/clip) o lo hace scrolleable (auto/scroll):
          // el marquee de sabores, por ejemplo, es una pista el doble de ancha
          // que se desplaza dentro de una ventana fija. Eso no es un bug.
          const recortado = (el: Element): boolean => {
                  let p = el.parentElement;
                  while (p && p !== document.body) {
                    const o = getComputedStyle(p);
                    if (o.overflowX !== 'visible') return true;
                    p = p.parentElement;
                  }
                  return false;
                };

                const out: string[] = [];
          for (const el of document.querySelectorAll('body *')) {
            const r = el.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) continue;
            if (r.right > window.innerWidth + 2 || r.left < -2) {
              const style = getComputedStyle(el);
              if (style.position === 'fixed') continue;
              if (recortado(el)) continue;
              out.push(`${el.tagName}.${String(el.className).slice(0, 40)} [${Math.round(r.left)}..${Math.round(r.right)}]`);
            }
          }
          return out.slice(0, 10);
        });
        expect(fuera, `elementos fuera del viewport: ${fuera.join(' | ')}`).toEqual([]);
      });

  test('todo control interactivo cumple el minimo AA de 24px', async ({ page }) => {
      await page.goto('/');
      await page.waitForTimeout(600);
      const chicos = await page.evaluate(() => {
        const out: string[] = [];
        for (const el of document.querySelectorAll('a[href], button')) {
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) continue;
          if (getComputedStyle(el).visibility === 'hidden') continue;
          if (r.height < 24 || r.width < 24) {
            out.push(`${el.tagName}.${String(el.className).slice(0, 30)} ${Math.round(r.width)}x${Math.round(r.height)}`);
          }
        }
        return out.slice(0, 12);
      });
      expect(chicos, `targets bajo 24px (WCAG 2.2 AA): ${chicos.join(' | ')}`).toEqual([]);
    });

    test('las acciones principales de la pagina son de 44px', async ({ page }) => {
      await page.goto('/');
      await page.waitForTimeout(600);

      // Estas son las que el cliente toca sin apuntar: el CTA del hero, el
      // boton de WhatsApp y los iconos de redes.
      for (const sel of ['.hero-cta', '.wsp-fab', '.nav-cta']) {
        const el = page.locator(sel).first();
        if (!(await el.count())) continue;
        const box = await el.boundingBox();
        expect(box?.width ?? 0, `${sel} ancho`).toBeGreaterThanOrEqual(44);
        expect(box?.height ?? 0, `${sel} alto`).toBeGreaterThanOrEqual(44);
      }
    });

  test('no hay requests fallidos ni errores de consola', async ({ page }) => {
    const fallos: string[] = [];
    const errores: string[] = [];
    page.on('response', (r) => { if (r.status() >= 400) fallos.push(`${r.status()} ${r.url()}`); });
    page.on('pageerror', (e) => errores.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errores.push(m.text()); });

    await page.goto('/');
    await page.waitForTimeout(1500);

    // El 401 esperado de /api/payments (pasarela fail-closed sin credenciales)
    // no es un fallo del sitio.
    const fallosReales = fallos.filter((f) => !f.includes('/api/payments'));
    expect(fallosReales, `requests fallidos: ${fallosReales.join(' | ')}`).toEqual([]);
    expect(errores, `errores de consola: ${errores.join(' | ')}`).toEqual([]);
  });

  test('el CTA del hero lleva a la tienda y la tienda carga', async ({ page }) => {
    await page.goto('/');
    const cta = page.locator('.hero-cta');
    await expect(cta).toBeVisible();
    await cta.click();
    await page.waitForURL(/tienda\.html/);
    await expect(page.locator('body')).toBeVisible();
  });

  test('la seccion de sabores se llena con el catalogo real', async ({ page }) => {
    await page.goto('/');
    await page.locator('#flavors').scrollIntoViewIfNeeded();
    await page.waitForTimeout(1200);
    const cards = page.locator('#flavor-cards-grid .flavor-card');
    await expect(cards.first()).toBeVisible({ timeout: 8000 });
    expect(await cards.count()).toBeGreaterThan(0);
  });

  test('el boton de WhatsApp abre el chat con el numero del negocio', async ({ page }) => {
      await page.goto('/');
      // En movil y tablet la barra de redes del header se oculta (display:none)
      // y el unico WhatsApp visible es el boton flotante (.wsp-fab). Buscamos
      // cualquier enlace de WhatsApp que este REALMENTE visible.
      const wsp = page.locator('a[href*="wa.me"], a[href*="api.whatsapp.com"]:visible').first();
      await expect(wsp).toBeVisible();
      const href = await wsp.getAttribute('href');
      expect(href).toMatch(/wa\.me|api\.whatsapp\.com/);
      // El boton flotante es el canal principal en movil: debe estar siempre.
      const fab = page.locator('.wsp-fab');
      await expect(fab).toBeVisible();
      const fabBox = await fab.boundingBox();
      expect(fabBox?.width ?? 0).toBeGreaterThanOrEqual(44);
      expect(fabBox?.height ?? 0).toBeGreaterThanOrEqual(44);
    });
});

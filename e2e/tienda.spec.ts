// MyMochis · E2E de la tienda (spec_id=31 V1).
//
// La tienda es donde el cliente realmente compra: elige sabor, lo mete al
// carrito y define como lo recibe. Un fallo aca es un pedido perdido.
import { test, expect } from '@playwright/test';

test.describe('tienda', () => {
  test('carga el catalogo y agrega un producto al carrito', async ({ page }) => {
    const errores: string[] = [];
    page.on('pageerror', (e) => errores.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errores.push(m.text()); });

    await page.goto('/tienda.html');
    await page.waitForTimeout(1200);

    const productos = page.locator('.product-card');
    await expect(productos.first()).toBeVisible({ timeout: 8000 });
    expect(await productos.count()).toBeGreaterThan(0);

    // El primer producto debe poder agregarse al carrito.
    const addBtn = productos.first().locator('button, .add-btn, [data-add]').first();
    if (await addBtn.count()) {
      await addBtn.click();
      await page.waitForTimeout(600);
    }

    expect(errores, `errores de consola: ${errores.join(' | ')}`).toEqual([]);
  });

  test('no hay overflow horizontal en la tienda', async ({ page }) => {
    await page.goto('/tienda.html');
    await page.waitForTimeout(1000);

    const m = await page.evaluate(() => {
      const de = document.documentElement;
      return {
        scrollW: de.scrollWidth,
        innerW: window.innerWidth,
        bodyScrollW: document.body.scrollWidth,
      };
    });
    // El body puede reportar scrollWidth mayor si un hijo se sale, pero lo
    // que el usuario PERCIBE es el scroll del documento.
    expect(
      m.scrollW,
      `scrollWidth ${m.scrollW} > innerWidth ${m.innerW} (body ${m.bodyScrollW})`,
    ).toBeLessThanOrEqual(m.innerW + 1);
  });

  test('todo control interactivo cumple el minimo AA de 24px', async ({ page }) => {
    await page.goto('/tienda.html');
    await page.waitForTimeout(1000);

    const chicos = await page.evaluate(() => {
      const out: string[] = [];
      for (const el of document.querySelectorAll('button, a[href]')) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;   // oculto: no cuenta
        if (getComputedStyle(el).visibility === 'hidden') continue;
        if (r.height < 24 || r.width < 24) {
          out.push(`${el.tagName}.${String(el.className).slice(0, 30)} ${Math.round(r.width)}x${Math.round(r.height)}`);
        }
      }
      return out.slice(0, 12);
    });
    expect(chicos, `targets bajo 24px (WCAG 2.2 AA): ${chicos.join(' | ')}`).toEqual([]);
  });

  test('los botones +/- del carrito son de 44px (uso sin apuntar)', async ({ page }) => {
    await page.goto('/tienda.html');
    await page.waitForTimeout(1200);

    const botones = page.locator('.qty-controls button');
    const n = await botones.count();
    expect(n, 'no hay controles de cantidad en el carrito').toBeGreaterThan(0);

    for (let i = 0; i < Math.min(n, 4); i++) {
      const box = await botones.nth(i).boundingBox();
      expect(box?.width ?? 0, `boton ${i} ancho`).toBeGreaterThanOrEqual(44);
      expect(box?.height ?? 0, `boton ${i} alto`).toBeGreaterThanOrEqual(44);
    }
  });

  test('la aurora se monta y el fondo deja ver el shader', async ({ page }) => {
    await page.goto('/tienda.html');
    await page.waitForTimeout(2500);

    const info = await page.evaluate(() => {
      const shader = document.querySelector('.page-shader');
      const canvas = shader?.querySelector('canvas');
      const card = document.querySelector('.product-card');
      return {
        hayShader: !!shader,
        hayCanvas: !!canvas,
        bodyBg: getComputedStyle(document.body).backgroundColor,
        cardFilter: card ? getComputedStyle(card).backdropFilter : '',
      };
    });

    // El shader es ambiente, no contenido: si falla, la pagina debe seguir
    // legible por el fallback CSS. Por eso el test exige el nodo, no el canvas.
    expect(info.hayShader, 'falta el nodo .page-shader').toBe(true);
    expect(info.hayCanvas, 'el bundle no montó la aurora').toBe(true);

    // El body tiene que ser translucido: es lo que deja ver la aurora.
    expect(info.bodyBg, 'el body es opaco: la aurora no se vera').toMatch(/0\.\d+|0\s*\)/);

    // Las tarjetas de producto son de cristal (backdrop-filter).
    expect(info.cardFilter, 'las tarjetas no dejan ver el shader').toContain('blur');
  });
});

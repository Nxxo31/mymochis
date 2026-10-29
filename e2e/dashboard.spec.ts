// MyMochis · E2E del dashboard (spec_id=31 V1).
//
// Cubre el flujo que el operador usa todos los dias:
//   login -> "Nuevo pedido" (formulario de compra) -> guardar -> tabla con
//   los chips de entrega -> modal de detalle.
// Tambien verifica que el dashboard no se rompe en movil.
import { test, expect } from '@playwright/test';

const ADMIN = { email: 'admin@e2e.test', password: 'E2eTest123!' };

async function login(page: import('@playwright/test').Page) {
  // El tour de bienvenida pone un .tour-blocker (inset:0) sobre la pagina
  // entera: sin esto el primer clic se lo come el overlay.
  await page.addInitScript(() => {
    try { localStorage.setItem('mymochis_tour_done', '1'); } catch {}
  });
  await page.goto('/manage.html');
  await page.waitForTimeout(800);
  await page.fill('#login-email, #email, input[type="email"]', ADMIN.email);
  await page.fill('#login-password, #password, input[type="password"]', ADMIN.password);
  await page.click('#login-btn, button[type="submit"]');
  await page.waitForSelector('.app.visible', { timeout: 15000 });
}

test.describe('dashboard', () => {
  test('el operador entra y ve la seccion de pedidos', async ({ page }) => {
    const errores: string[] = [];
    page.on('pageerror', (e) => errores.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errores.push(m.text()); });

    await login(page);
    await page.evaluate(() => (window as any).showSection?.('orders'));
    await page.waitForTimeout(800);

    await expect(page.locator('#section-orders')).toBeVisible();
    await expect(page.locator('button[onclick="openNewOrderModal()"]')).toBeVisible();

    expect(errores, `errores de consola: ${errores.join(' | ')}`).toEqual([]);
  });

  test('el formulario de compra abre con los dias y productos de la ventana', async ({ page }) => {
    await login(page);
    await page.evaluate(() => (window as any).showSection?.('orders'));
    await page.waitForTimeout(600);

    await page.evaluate(() => (window as any).openNewOrderModal());
    await expect(page.locator('#manual-order-form')).toBeVisible({ timeout: 8000 });

    // Solo se ofrecen dias con ventana de produccion abierta.
    const dias = await page.evaluate(() =>
      [...document.querySelectorAll('#mo-day option')].map((o) => (o as HTMLOptionElement).value).filter(Boolean)
    );
    expect(dias.length, 'no hay dias con ventana abierta').toBeGreaterThan(0);

    // Los sabores listados son los de la ventana elegida, con su stock.
    const sabores = await page.locator('#mo-flavors .ms-item').count();
    expect(sabores, 'la ventana no muestra sabores').toBeGreaterThan(0);

    // El total arranca en $0 y se calcula al agregar productos.
    await page.click('#mo-flavors [data-mo="inc"]');
    await page.waitForTimeout(400);
    const total = await page.locator('#mo-total').inputValue();
    expect(total).not.toBe('$0');
  });

  test('un pedido creado desde el dashboard queda en el back-end y se ve en la tabla', async ({ page }) => {
    await login(page);
    await page.evaluate(() => (window as any).showSection?.('orders'));
    await page.waitForTimeout(600);

    await page.evaluate(() => (window as any).openNewOrderModal());
    await page.fill('#mo-name', 'Cliente E2E');
    await page.fill('#mo-phone', '3001234567');
    await page.click('#mo-flavors [data-mo="inc"]');
    await page.waitForTimeout(400);
    await page.click('#manual-order-form button[type="submit"]');
    await page.waitForTimeout(2500);

    // El modal se cierra y la tabla ya trae el pedido.
    await expect(page.locator('#modal-back')).not.toHaveClass(/visible/);
    // No se cuenta <tr>: la tabla vacia tambien tiene una fila (el placeholder
    // "Sin pedidos"), asi que el conteo no distingue "vacio" de "con pedido".
    await expect(page.locator('#orders-body')).toContainText('Cliente E2E', { timeout: 8000 });

    // La fila muestra el chip de entrega (recoger/domicilio) y el origen.
    const fila = page.locator('#orders-body tr').filter({ hasText: 'Cliente E2E' }).first();
    await expect(fila.locator('.tag.pick, .tag.dom')).toBeVisible();
    await expect(fila.locator('.tag.src')).toBeVisible();

    // El detalle expone los datos que la API ya traia y la tabla no mostraba.
    await fila.locator('button[onclick^="openOrderDetail"]').click();
    await expect(page.locator('#modal-back')).toHaveClass(/visible/);
    const texto = await page.locator('#modal-content').innerText();
    expect(texto).toContain('Cliente E2E');
    expect(texto).toContain('ENTREGA');
    expect(texto).toContain('MÉTODO DE PAGO');
  });

  test('no hay overflow horizontal en el dashboard', async ({ page }) => {
    await login(page);
    await page.evaluate(() => (window as any).showSection?.('orders'));
    await page.waitForTimeout(800);

    const m = await page.evaluate(() => ({
      scrollW: document.documentElement.scrollWidth,
      innerW: window.innerWidth,
    }));
    expect(
      m.scrollW,
      `scrollWidth ${m.scrollW} > innerWidth ${m.innerW}`,
    ).toBeLessThanOrEqual(m.innerW + 1);
  });
});

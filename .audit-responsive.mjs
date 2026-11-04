import { chromium } from '@playwright/test';

const VIEWPORTS = [
  { name: '320x568 (SE)', width: 320, height: 568 },
  { name: '375x667 (iPhone SE2)', width: 375, height: 667 },
  { name: '414x896 (Plus)', width: 414, height: 896 },
  { name: '768x1024 (tablet)', width: 768, height: 1024 },
  { name: '1024x768 (ipad-land)', width: 1024, height: 768 },
  { name: '1280x800', width: 1280, height: 800 },
  { name: '1440x900', width: 1440, height: 900 },
  { name: '1920x1080', width: 1920, height: 1080 },
  { name: '2560x1080 (ultrawide)', width: 2560, height: 1080 },
];

const PAGES = [
  { name: 'landing', url: '/index.html' },
  { name: 'tienda', url: '/tienda.html' },
  { name: 'panel', url: '/manage.html' },
];

const browser = await chromium.launch();
const results = [];

for (const page of PAGES) {
  for (const vp of VIEWPORTS) {
    const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
    const p = await ctx.newPage();
    const errors = [];
    p.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 120)); });
    p.on('pageerror', (e) => errors.push('PAGEERROR: ' + String(e).slice(0, 120)));
    await p.goto(`http://localhost:3737${page.url}`, { waitUntil: 'networkidle' });
    await p.waitForTimeout(700);
    const data = await p.evaluate(() => {
      const de = document.documentElement;
      const overflow = de.scrollWidth - de.clientWidth;
      const vw = de.clientWidth;
      const bad = [];
      const seen = new Set();
      for (const el of document.querySelectorAll('body *')) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        if (r.right > vw + 1.5 || r.left < -1.5) {
          const key = el.tagName + '.' + (el.className || '').toString().slice(0, 40);
          if (seen.has(key)) continue;
          seen.add(key);
          bad.push(`${el.tagName}.${(el.className || '').toString().split(' ').slice(0, 3).join('.')} L${Math.round(r.left)} R${Math.round(r.right)}`);
        }
      }
      // separacion vertical entre secciones sisters
      const secs = [...document.querySelectorAll('body > section, body > main > section')]
        .map((s) => ({ cls: (s.className || '').toString().split(' ')[0], top: Math.round(s.getBoundingClientRect().top), h: Math.round(s.getBoundingClientRect().height) }));
      const gaps = [];
      for (let i = 1; i < secs.length; i++) gaps.push(`${secs[i - 1].cls}->${secs[i].cls}=${secs[i].top - (secs[i - 1].top + secs[i - 1].h)}`);
      const small = [...document.querySelectorAll('p, h1, h2, h3, span, li, a, button')]
        .filter((el) => { const r = el.getBoundingClientRect(); return r.height > 0 && r.width > 0 && parseFloat(getComputedStyle(el).fontSize) < 11; })
        .map((el) => `${el.tagName}.${(el.className || '').toString().split(' ')[0]}=${getComputedStyle(el).fontSize}`);
      return { overflow, vw, bad: bad.slice(0, 6), gaps, small: small.slice(0, 4), secCount: secs.length };
    });
    results.push({ page: page.name, vp: vp.name, ...data, errors: errors.slice(0, 3) });
    await ctx.close();
  }
}
await browser.close();

for (const r of results) {
  const flags = [];
  if (r.overflow > 1) flags.push(`OVERFLOW-X +${r.overflow}px`);
  if (r.bad.length) flags.push(`FUERA: ${r.bad.join(' | ')}`);
  if (r.small.length) flags.push(`TIPOGRAFIA<11px: ${r.small.join(' | ')}`);
  if (r.errors.length) flags.push(`CONSOLA: ${r.errors.join(' | ')}`);
  console.log(`${r.page.padEnd(8)} ${r.vp.padEnd(22)} ${flags.length ? flags.join('  //  ') : 'OK'}`);
}
console.log('\n=== gaps verticales (px) landing ===');
console.log(results.filter((r) => r.page === 'landing' && r.vp.startsWith('1440')).map((r) => r.gaps.join('  ')).join('\n'));

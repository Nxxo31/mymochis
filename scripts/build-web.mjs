// Build de las islas (web/) en modo produccion.
//
// Por que este wrapper y no "vite build" a pelo: con NODE_ENV sin definir,
// Vite resuelve la condicion 'development' del paquete de React y mete
// react-dom.development.js (1 MB) en el entry. El landing.js pasaba de 145 kB
// a 332 kB (gzip 47 kB a 101 kB) y el bundle de produccion arrastraba React en
// modo desarrollo. El stage webbuild del Dockerfile no fija NODE_ENV, asi que
// la imagen de produccion tenia el mismo problema.
//
// El fix tiene que ir ANTES de que Vite resuelva: process.env.NODE_ENV se lee
// al arrancar el build, no en vite.config.ts.
process.env.NODE_ENV = 'production';

const { build } = await import('vite');
await build();

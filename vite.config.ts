import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

// Multi-entry; output a public/build/ para que Express los sirva.
// Spec: PROJECT.md §21.9
export default defineConfig({
  plugins: [react()],
  // publicDir tiene que estar DESACTIVADO: con el default ("public"), Vite copia
  // todo public/ dentro de public/build/, asi que el build dejaba una copia
  // entera del sitio (index.html, manage.html, tienda.html, vendor/, img/) junto
  // al bundle. Ademas Vite avisa por consola: "outDir and publicDir are not
  // separate folders". Las paginas HTML y los assets ya se sirven desde public/
  // por Express; el build solo necesita emitir las islas.
  publicDir: false,
  build: {
    outDir: 'public/build',
    emptyOutDir: true,
    sourcemap: true,
    cssCodeSplit: false,
    rollupOptions: {
      input: {
        landing: resolve(__dirname, 'web/landing/main.tsx'),
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name]-[hash].js',
        // Nombre ESTABLE para el CSS de las islas (sin hash) a proposito:
        // las paginas HTML estaticas lo referencian con un <link> fijo y no
        // se regeneran en cada build. Con hash, el <link> quedaba apuntando
        // a un archivo inexistente y la isla se renderizaba sin estilos.
        assetFileNames: (assetInfo) =>
          assetInfo.names?.some((n) => n.endsWith('.css'))
            ? 'assets/islands.css'
            : 'assets/[name]-[hash][extname]',
      },
    },
  },
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:3737' },
  },
});

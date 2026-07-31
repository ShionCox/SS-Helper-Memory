import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';

const inventoryCardAssets = ['inventory-card-front.webp', 'inventory-card-back.webp'] as const;

export default defineConfig({
  plugins: [{
    name: 'inventory-card-assets',
    apply: 'build',
    buildStart() {
      for (const fileName of inventoryCardAssets) this.emitFile({
        type: 'asset',
        fileName: `assets/${fileName}`,
        source: readFileSync(new URL(`./src/ui/assets/${fileName}`, import.meta.url)),
      });
    },
  }],
  build: {
    target: 'es2022',
    emptyOutDir: false,
    lib: {
      entry: 'src/entry.ts',
      formats: ['es'],
      fileName: () => 'index.js',
    },
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
        assetFileNames: (asset) => asset.name?.endsWith('.css') ? 'style.css' : 'assets/[name]-[hash][extname]',
      },
    },
  },
});


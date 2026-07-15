import { defineConfig } from 'vite';

export default defineConfig({
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
        assetFileNames: (asset) => asset.name?.endsWith('.css') ? 'style.css' : 'assets/[name]-[hash][extname]',
      },
    },
  },
});


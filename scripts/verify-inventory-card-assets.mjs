import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const bundle = readFileSync(path.resolve('dist/index.js'), 'utf8');
const assetNames = ['inventory-card-front.webp', 'inventory-card-back.webp'];

if (/data:image\/webp;base64/u.test(bundle)) {
  throw new Error('Inventory card WebP assets must not be inlined into the production bundle');
}
for (const assetName of assetNames) {
  if (!existsSync(path.resolve('dist/assets', assetName))) throw new Error(`Missing inventory card asset: ${assetName}`);
  if (!bundle.includes(`./assets/${assetName}`)) throw new Error(`Inventory bundle does not reference external asset: ${assetName}`);
}

console.log('inventory card asset scan PASS');

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { createOpenMeteo } from './data/openmeteo.js';
import { createService } from './service.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.PORT) || 3000;

const service = createService({
  api: createOpenMeteo(),
  cacheDir: process.env.CACHE_DIR || path.join(root, 'data', 'cache'),
});

createApp({ service }).listen(port, () => {
  console.log(`Weather prediction running at http://localhost:${port}`);
});

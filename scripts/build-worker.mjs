import { cp, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'vite';

const root = resolve(import.meta.dirname, '..');
await build({ root: resolve(root, 'client'), configFile: resolve(root, 'client', 'vite.config.js') });
const dist = resolve(root, 'client', 'dist');
await mkdir(resolve(dist, 'shared'), { recursive: true });
await cp(resolve(root, 'server', 'public'), dist, { recursive: true });
await cp(resolve(root, 'shared'), resolve(dist, 'shared'), { recursive: true });


import { cp, mkdir } from 'node:fs/promises';
await mkdir('dist', { recursive: true });
await cp('extension', 'dist/extension', { recursive: true });

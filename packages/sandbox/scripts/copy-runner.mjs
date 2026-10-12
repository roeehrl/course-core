import { copyFile } from 'node:fs/promises';
await copyFile(new URL('../src/runner.py', import.meta.url), new URL('../dist/runner.py', import.meta.url));

import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['server/test/**/*.test.js'], environment: 'node' } });

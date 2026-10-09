import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // SWC gère les décorateurs NestJS + emitDecoratorMetadata (esbuild ne le fait pas).
  plugins: [
    swc.vite({
      jsc: {
        target: 'es2023',
        parser: { syntax: 'typescript', decorators: true },
        transform: { decoratorMetadata: true, legacyDecorator: true },
      },
    }),
  ],
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    env: {
      NODE_ENV: 'test',
      WEB_ORIGIN: 'http://localhost:5173',
      DATABASE_URL: 'postgresql://footfive:footfive_dev_password@localhost:5433/footfive_test',
      JWT_ACCESS_SECRET: 'test-only-access-secret-0123456789-abcdef',
      PAYMENT_PROVIDER: 'fake',
      PAYMENT_WEBHOOK_SECRET: 'test-only-webhook-secret-0123456789',
    },
  },
});

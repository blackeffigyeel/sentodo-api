/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/*.test.ts'],
  setupFiles: ['<rootDir>/tests/helpers/setup-env.ts'],
  collectCoverageFrom: ['src/**/*.ts', '!src/api.server.ts', '!src/queue.worker.ts', '!src/integrations/**'],
  testTimeout: 20000,
};

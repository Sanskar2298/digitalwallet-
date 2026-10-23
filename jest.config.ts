import type { Config } from 'jest';

process.env.NODE_ENV = 'test';

const config: Config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/*.test.ts'],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: 'tsconfig.json' }]
  },
  verbose: true,
  testTimeout: 30000,
  maxWorkers: 1,
};

export default config;

import { config } from '../config.js';
import { LocalComputeProvider } from './local.js';
import { SpritesComputeProvider } from './sprites.js';
import type { ComputeProvider } from './types.js';

export type { ComputeProvider } from './types.js';

/**
 * Get the configured compute provider
 */
export function getComputeProvider(): ComputeProvider {
  switch (config.COMPUTE_PROVIDER) {
    case 'local':
      return new LocalComputeProvider();
    case 'sprites':
      return new SpritesComputeProvider();
    default:
      throw new Error(`Unknown compute provider: ${config.COMPUTE_PROVIDER}`);
  }
}

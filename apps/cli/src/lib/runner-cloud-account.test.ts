import { describe, expect, it, vi } from 'vitest';

// A provider routine account on a cloud placement must fail loud BEFORE any cloud
// dispatch — executeJobPlaced runs assertRoutineAccountLocalForPlacement at the top
// of the placement block, before executeJobOnCloud is reached. These mocks force a
// cloud placement + a provider account and spy the cloud provider resolver to prove
// it is never called.
vi.mock('./routines-placement.js', async (importActual) => ({
  ...(await importActual<typeof import('./routines-placement.js')>()),
  resolvePlacementTarget: () => ({ mode: 'cloud' as const }),
}));

vi.mock('./account-registry.js', async (importActual) => ({
  ...(await importActual<typeof import('./account-registry.js')>()),
  findUnifiedAccount: () => ({ kind: 'provider', id: 'p', name: 'prov', provider: 'openrouter', auth: 'api-key', secretRef: 'r' }),
}));

vi.mock('./cloud/registry.js', async (importActual) => ({
  ...(await importActual<typeof import('./cloud/registry.js')>()),
  resolveProvider: vi.fn(() => { throw new Error('cloud dispatch must not be reached'); }),
}));

import { executeJobPlaced } from './runner.js';
import { resolveProvider } from './cloud/registry.js';

describe('cloud placement with a provider routine account makes zero cloud dispatch calls', () => {
  it('fails loud at the placement guard, before resolveProvider', async () => {
    const config = { name: 'r', agent: 'claude', account: 'prov', prompt: 'x', hostStrategy: 'cloud' } as never;
    const attempt = { runId: 'test-run', stamp: {} } as never;
    await expect(executeJobPlaced(config, undefined, attempt)).rejects.toThrow('cloud placement cannot securely inject it');
    expect(resolveProvider).not.toHaveBeenCalled();
  });
});

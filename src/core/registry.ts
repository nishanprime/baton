import { claudeProvider } from '../providers/claude/index.ts';
import type { Provider } from './types.ts';

/**
 * Providers Baton knows about. Adding a second one means implementing the
 * Provider interface and listing it here — nothing in the CLI or the shared
 * history layer is Claude-specific.
 */
export const PROVIDERS: Provider[] = [claudeProvider];

export function getProvider(id: string): Provider {
  const p = PROVIDERS.find((x) => x.id === id);
  if (!p) {
    throw new Error(
      `Unknown provider "${id}". Known: ${PROVIDERS.map((x) => x.id).join(', ')}`,
    );
  }
  return p;
}

export const defaultProvider = (): Provider => PROVIDERS[0]!;

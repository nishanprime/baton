import { captureMerged, applyMerged } from './share.ts';
import type { Account, Host, Provider } from './types.ts';

export interface SwitchResult {
  host: Host;
  from?: Account;
  to: Account;
  capturedFrom: string[];
  appliedTo: string[];
  dryRun: boolean;
}

/**
 * Point one host at a different account.
 *
 * Order matters. The outgoing account's portable state is captured first, so
 * work done under it is carried forward rather than shadowed by whatever the
 * incoming account last wrote.
 */
export function switchHost(
  provider: Provider,
  host: Host,
  to: Account,
  accounts: Account[],
  opts: { dryRun?: boolean } = {},
): SwitchResult {
  const dryRun = opts.dryRun ?? false;
  const from = accounts.find(
    (a) => host.configDir && a.configDir === host.configDir,
  );

  const capturedFrom = from && !dryRun ? captureMerged(provider, from) : [];
  const appliedTo = applyMerged(provider, to, { dryRun });
  provider.bindHost(host, to.configDir, { dryRun });

  return { host, from, to, capturedFrom, appliedTo, dryRun };
}

import fs from 'node:fs';
import path from 'node:path';
import { appHome } from './paths.ts';

/** Runtime bookkeeping, separate from user preferences. */
export interface State {
  /** Timestamp of the newest exhaustion event already acted on. */
  lastHandledLimitAt: string | null;
  lastSwitchedTo: string | null;
  lastSwitchedAt: string | null;
}

const DEFAULTS: State = { lastHandledLimitAt: null, lastSwitchedTo: null, lastSwitchedAt: null };
const file = () => path.join(appHome(), 'state.json');

export function loadState(): State {
  try {
    return { ...DEFAULTS, ...(JSON.parse(fs.readFileSync(file(), 'utf8')) as Partial<State>) };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveState(s: State): void {
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), `${JSON.stringify(s, null, 2)}\n`, 'utf8');
}

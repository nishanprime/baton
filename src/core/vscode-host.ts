import fs from 'node:fs';
import path from 'node:path';
import { modify, applyEdits, type FormattingOptions } from 'jsonc-parser';
import { KNOWN_EDITORS, editorConfigRoot, exists, backupFile } from './paths.ts';
import { readJsonc, readText } from './jsonc.ts';
import type { Host } from './types.ts';

/**
 * Reusable binding logic for VS Code-family editors.
 *
 * Every provider that ships a VS Code extension exposes the same two knobs, and
 * both have to be set: one for the extension panel, one for the integrated
 * terminal. Setting only one is the single most common way a manual switch goes
 * half-applied.
 */
export interface VsCodeBinding {
  /** Env var selecting the config dir, e.g. CLAUDE_CONFIG_DIR. */
  envVar: string;
  /** Extension setting holding an array of {name, value}, e.g. claudeCode.environmentVariables. */
  extensionEnvKey: string;
}

const TERMINAL_ENV_KEY: Record<string, string> = {
  darwin: 'terminal.integrated.env.osx',
  linux: 'terminal.integrated.env.linux',
  win32: 'terminal.integrated.env.windows',
};

export const terminalEnvKey = (): string =>
  TERMINAL_ENV_KEY[process.platform] ?? 'terminal.integrated.env.linux';

const FORMAT: FormattingOptions = { insertSpaces: true, tabSize: 2, eol: '\n' };

const settingsFileFor = (dirName: string) =>
  path.join(editorConfigRoot(), dirName, 'User', 'settings.json');

function fromExtensionKey(
  settings: Record<string, unknown>,
  b: VsCodeBinding,
): string | undefined {
  const list = settings[b.extensionEnvKey];
  if (!Array.isArray(list)) return undefined;
  const hit = list.find(
    (e) => e && typeof e === 'object' && (e as Record<string, unknown>).name === b.envVar,
  ) as Record<string, unknown> | undefined;
  return typeof hit?.value === 'string' ? hit.value : undefined;
}

function fromTerminalKey(
  settings: Record<string, unknown>,
  b: VsCodeBinding,
): string | undefined {
  const block = settings[terminalEnvKey()];
  if (!block || typeof block !== 'object') return undefined;
  const v = (block as Record<string, unknown>)[b.envVar];
  return typeof v === 'string' ? v : undefined;
}

/** Every installed editor, with the config dir it currently selects. */
export function discoverVsCodeHosts(providerId: string, b: VsCodeBinding): Host[] {
  const out: Host[] = [];
  for (const def of KNOWN_EDITORS) {
    for (const dirName of def.dirNames) {
      const configFile = settingsFileFor(dirName);
      // The User dir existing is what proves the editor is installed; the
      // settings file itself may not exist yet on a fresh install.
      if (!exists(path.dirname(configFile))) continue;

      const settings = readJsonc(configFile);
      const ext = fromExtensionKey(settings, b);
      const term = fromTerminalKey(settings, b);

      out.push({
        id: def.id,
        label: def.label,
        configFile,
        configDir: ext ?? term,
        inconsistent: ext !== undefined && term !== undefined && ext !== term,
        providerId,
      });
      break; // first matching dirName wins
    }
  }
  return out;
}

/**
 * Rewrite both settings keys to point at `configDir`.
 *
 * Edits are applied through jsonc-parser's edit API rather than a
 * parse-and-reserialize, so the user's comments, key order and formatting
 * survive intact.
 */
export function bindVsCodeHost(
  host: Host,
  configDir: string,
  b: VsCodeBinding,
  opts: { dryRun?: boolean } = {},
): string {
  let text = readText(host.configFile);
  const settings = readJsonc(host.configFile);

  text = applyEdits(
    text,
    modify(text, [terminalEnvKey(), b.envVar], configDir, { formattingOptions: FORMAT }),
  );

  const list = Array.isArray(settings[b.extensionEnvKey])
    ? (settings[b.extensionEnvKey] as unknown[])
    : [];
  const idx = list.findIndex(
    (e) => e && typeof e === 'object' && (e as Record<string, unknown>).name === b.envVar,
  );
  const isInsert = idx < 0;
  text = applyEdits(
    text,
    modify(
      text,
      [b.extensionEnvKey, isInsert ? list.length : idx],
      { name: b.envVar, value: configDir },
      { formattingOptions: FORMAT, isArrayInsertion: isInsert },
    ),
  );

  if (!opts.dryRun) {
    backupFile(host.configFile, host.id);
    fs.mkdirSync(path.dirname(host.configFile), { recursive: true });
    fs.writeFileSync(host.configFile, text, 'utf8');
  }
  return text;
}

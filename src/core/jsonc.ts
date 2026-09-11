import fs from 'node:fs';
import { parse, type ParseError } from 'jsonc-parser';

/**
 * Editor settings files are JSONC: comments and trailing commas are legal and
 * common. A strict JSON.parse throws on real-world files, so always read
 * through here.
 */
export function readJsonc(file: string): Record<string, unknown> {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return {};
  }
  const errors: ParseError[] = [];
  const parsed = parse(text, errors, { allowTrailingComma: true, disallowComments: false });
  return (parsed ?? {}) as Record<string, unknown>;
}

export function readText(file: string, fallback = '{}'): string {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return fallback;
  }
}

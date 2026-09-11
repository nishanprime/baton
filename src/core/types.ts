/**
 * Provider-agnostic model.
 *
 * The pattern generalises well past Claude: an AI coding agent keeps its state
 * in a config directory, an environment variable selects which directory, and
 * editors launch the agent with that variable set. Swap the directory and you
 * swap the logged-in account. Every provider below implements that same shape.
 */

/** One logged-in account / profile for a provider. */
export interface Account {
  id: string;
  label: string;
  /** Absolute path to the config directory that holds this account's state. */
  configDir: string;
  /** Identity metadata, when the provider can read it without touching secrets. */
  email?: string;
  /** True when this is the provider's implicit directory used if the env var is unset. */
  isDefault: boolean;
  providerId: string;
}

/** An app that can be pointed at an account — today an editor, later a shell or daemon. */
export interface Host {
  id: string;
  label: string;
  /** File this host's binding is stored in, shown to the user before we write it. */
  configFile: string;
  /** Config dir this host currently selects, if any. */
  configDir?: string;
  /**
   * True when a host stores the binding in more than one place and they
   * disagree — the signature of a half-finished manual edit.
   */
  inconsistent: boolean;
  providerId: string;
}

/**
 * Which entries inside a config directory are portable history (shared across
 * every account) and which are account-private and must never be linked.
 */
export interface SharePolicy {
  /** Relative entries symlinked into the shared store so history follows the user. */
  shared: string[];
  /** Relative entries that stay private to each account. Never touched. */
  private: string[];
  /**
   * Files mixing identity and state in one blob, needing a key-level merge
   * instead of a symlink.
   */
  merged: MergedFile[];
}

export interface MergedFile {
  /** Relative path inside the config dir. */
  file: string;
  /**
   * Top-level keys that carry portable state. Everything else is left alone,
   * so an unrecognised identity key is private by default rather than leaked.
   */
  sharedKeys: string[];
}

export interface Provider {
  id: string;
  label: string;
  /** Environment variable that selects the config directory. */
  envVar: string;
  sharePolicy: SharePolicy;
  discoverAccounts(): Account[];
  discoverHosts(): Host[];
  /**
   * Resolve a policy-relative entry to its real location. Defaults to joining
   * onto the config dir, but some providers keep a file outside it — Claude
   * puts the default profile's .claude.json at ~/.claude.json, not inside
   * ~/.claude.
   */
  resolveFile?(account: Account, relPath: string): string;
  /** Point one host at one config dir. Returns the text it wrote, for dry runs. */
  bindHost(host: Host, configDir: string, opts?: { dryRun?: boolean }): string;
}

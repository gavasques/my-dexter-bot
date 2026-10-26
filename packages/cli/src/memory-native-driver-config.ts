import { lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { HostError, type HostStore } from '@dexter/hub';
import type { EngineCommands } from './engine-command-config.js';
import type { OfficialMemoryExtractorOptions } from '@dexter/context';

/** Only the host's already selected native executables. No CLI is invoked or authentication inferred here. */
export function hostMemoryDriverOptions(store: HostStore, commands: EngineCommands | undefined): OfficialMemoryExtractorOptions | undefined {
  if (!commands?.claude && !commands?.codex) return undefined;
  const parent = resolve(dirname(store.databasePath), '..');
  const root = join(parent, 'memory-runtime');
  const owner = lstatSync(parent);
  if (!owner.isDirectory() || owner.isSymbolicLink() || realpathSync(parent) !== parent || owner.uid !== process.getuid?.())
    throw new HostError('conflict', 'Private memory runtime is unavailable.');
  try { mkdirSync(root, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  const stat = lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(root) !== root || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0)
    throw new HostError('conflict', 'Private memory runtime is unavailable.');
  return { workspaceRoot: root, ...(commands.claude ? { claude: { command: commands.claude } } : {}),
    ...(commands.codex ? { codex: { command: commands.codex } } : {}) };
}

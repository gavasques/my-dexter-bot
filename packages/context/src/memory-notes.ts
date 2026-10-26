import { BOT_MEMORY_MAX_CHARACTERS } from '@dexter/contracts';
import { ContextError } from './types.js';
import { sha256 } from './repository.js';

/** Counts UTF-16 characters, matching the existing document contract. No text is included in the error. */
export class MemoryNoteCapacityError extends ContextError {
  readonly capacity = BOT_MEMORY_MAX_CHARACTERS;
  constructor(readonly currentCharacters: number, readonly requiredCharacters: number) {
    super('invalid_input', `MEMORY capacity is ${BOT_MEMORY_MAX_CHARACTERS} characters; ${requiredCharacters} required.`);
    this.name = 'MemoryNoteCapacityError';
  }
}

/** Pure calculation inside the canonical writer transaction; no cache, registry or semantic merge. */
export function appendLiteralMemoryNote(current: string, note: string): { memory: string; sha256: string; outcome: 'appended' | 'already_present' } {
  // A literal standalone block is a duplicate. Substrings, casing and Unicode normalization are not equivalent.
  const present = current === note || current.startsWith(`${note}\n\n`) || current.endsWith(`\n\n${note}`) || current.includes(`\n\n${note}\n\n`);
  if (present) return { memory: current, sha256: sha256(note), outcome: 'already_present' };
  const memory = current.length === 0 ? note : `${current}\n\n${note}`;
  if (memory.length > BOT_MEMORY_MAX_CHARACTERS) throw new MemoryNoteCapacityError(current.length, memory.length);
  return { memory, sha256: sha256(note), outcome: 'appended' };
}

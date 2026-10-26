import type { MemoryRoutineExtractor } from './memory-routine-runner.js';

/** Literal completed-output excerpt only: no inference, I/O, tool calls or writes. */
export const literalMemoryRoutineExtractor: MemoryRoutineExtractor = Object.freeze<MemoryRoutineExtractor>({
  kind: 'literal_excerpt' as const,
  async extract(input, signal) {
    if (signal.aborted || input.source.role !== 'assistant' || !input.excerpt.isWellFormed()
      || input.excerpt.length > 2048 || !Number.isInteger(input.maxNoteCharacters) || input.maxNoteCharacters < 1 || input.maxNoteCharacters > 512) return null;
    const text = input.excerpt;
    let start = 0; while (start < text.length && /\s/u.test(text[start]!)) start++;
    if (start === text.length) return null;
    let end = Math.min(text.length, start + input.maxNoteCharacters);
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]!)) end--;
    // A cap inside a token keeps only complete original words, never a fabricated shortened word.
    if (end < text.length && !/\s/u.test(text[end]!)) {
      let boundary = end; while (boundary > start && !/\s/u.test(text[boundary - 1]!)) boundary--;
      if (boundary === start) return null; end = boundary;
    }
    while (end > start && /\s/u.test(text[end - 1]!)) end--;
    const note = text.slice(start, end);
    return !note || !note.isWellFormed() || signal.aborted ? null : { note, classification: 'context' as const };
  },
});

import type { EngineId, EngineSelection } from '@dexter/contracts';
import { EngineError } from './process.js';

/** These are native protocol identifiers, never shell fragments or arbitrary config. */
export function validateSelection(engine: EngineId, selection?: EngineSelection): void {
  if (!selection) return;
  if (selection.engine !== engine) throw new EngineError('unsupported');
  for (const value of [selection.model, selection.reasoningEffort, selection.speed]) {
    if (value !== null && (typeof value !== 'string' || value.length === 0 || value.length > 128 || /[\u0000-\u001f\u007f]/.test(value))) throw new EngineError('unsupported');
  }
}

import { z } from 'zod';
import { AppendBotMemoryNoteSchema } from './bot-memory.js';

const key=z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const digest=z.string().regex(/^[a-f0-9]{64}$/);
const revision=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER-1);
const safeText=(value:string)=>!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value) && !/(?:\b(?:sk-|sk_live_|sk_test_|github_pat_|gh[pousr]_|xox[abprs]-|glpat-|AIza|AKIA|ASIA|ya29\.)[A-Za-z0-9_+=./-]{8,}|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\.|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|authorization|password|passphrase)\s*[:=]\s*["']?(?:Bearer\s+)?[A-Za-z0-9_+=./-]{12,})/i.test(value);
/** Only direct own bookkeeping. Empty destructive replacements and restore are absent. */
export const AutomaticOwnDocumentInputSchema=z.strictObject({expectedRevision:revision,document:z.enum(['SOUL','USER','MEMORY']),
  markdown:z.string().max(8192).refine(value=>value.trim().length>0 && safeText(value)),
  sourceReference:z.string().max(512).refine(safeText).optional()});
export const OwnDocumentActionArgumentsSchema=z.strictObject({input:z.unknown(),
  pin:z.strictObject({revision,soulHash:digest,userHash:digest,memoryHash:digest}),
  origin:z.strictObject({installationId:key,ownerId:key,profileId:key,botId:key,threadId:key,turnId:key,
    expiresAt:z.number().int().positive().max(Number.MAX_SAFE_INTEGER)})});
export function automaticOwnDocumentArguments(tool:string,args:unknown) {
  if(!['dexter.harness.documents.update','dexter.harness.memory.append'].includes(tool))return null;
  const parsed=OwnDocumentActionArgumentsSchema.safeParse(args);if(!parsed.success)return null;
  const input=tool==='dexter.harness.memory.append'?AppendBotMemoryNoteSchema.safeParse(parsed.data.input):AutomaticOwnDocumentInputSchema.safeParse(parsed.data.input);
  if(!input.success || 'note' in input.data && !safeText(input.data.note) || input.data.expectedRevision!==parsed.data.pin.revision)return null;
  return {...parsed.data,input:input.data};
}
const status=z.enum(['automatic','ask','denied','expired']);
export const OwnDocumentAutomationStatusSchema=z.strictObject({version:z.literal('own-documents.v1'),scope:z.literal('own_private'),
  updates:status,append:status,clear:z.literal('exact_owner'),restore:z.literal('exact_owner')});
export type OwnDocumentAutomationStatus=z.infer<typeof OwnDocumentAutomationStatusSchema>;

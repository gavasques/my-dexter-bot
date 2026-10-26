import { z } from 'zod';
/** Human consent may include one HTTP-only discovery of this exact instance; legacy explicit discovery keeps {}. */
export const DiscoverMcpServerSchema=z.strictObject({
  expectedInstancePin:z.string().regex(/^[a-f0-9]{64}$/).optional(),
  httpOnly:z.literal(true).optional(),
}).refine(value=>value.httpOnly!==true||value.expectedInstancePin!==undefined,'HTTP discovery requires an exact instance pin.');
export type DiscoverMcpServer=z.infer<typeof DiscoverMcpServerSchema>;

import { z } from "zod";

const ID = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/);
const revision = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
export const DeviceRoutePatchSchema = z.strictObject({
  expectedHostId: ID, clientRequestId: ID, botId: ID, deviceId: ID,
  tool: z.string().regex(/^mac\.[a-z][a-z0-9_.]{1,100}$/),
  expectedRevision: revision.nullable(), status: z.enum(["active", "suspended", "revoked"]),
});
export type DeviceRoutePatch = z.infer<typeof DeviceRoutePatchSchema>;
/** Owner-local publication metadata. This never grants execution authority. */
export interface DeviceConversationRoute {
  id: string; botId: string; deviceId: string; tool: string; fingerprint: string;
  generation: number; pinRevision: number; schemaHash: string; operationVersion: string;
  revision: number; status: "active" | "suspended" | "revoked";
  minimumGrantRevision: number; needsFreshGrant: boolean;
}
export interface DeviceRouteReceipt {
  schema: "dexter.device-route-receipt/1";
  hostId: string; ownerId: string; clientRequestId: string; requestHash: string;
  request: DeviceRoutePatch; route: DeviceConversationRoute; committedAt: number;
}

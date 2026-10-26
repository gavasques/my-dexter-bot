import type { AckRequest, Delivery, DevicePin, Envelope, PollRequest } from "@dexter/relay";
export interface RelayTransport {
  poll(request:PollRequest):Promise<{deliveries:Delivery[];cursor:number}>;
  ack(request:AckRequest):Promise<{receiptId:string}>;
  close():Promise<void>;
}
/** Host custody port: verifies both current outer pins, signature and AEAD before publishing plaintext. */
export interface RelayOpener {
  readonly publicPin:DevicePin;
  open(envelope:Envelope,sender:DevicePin):Promise<Uint8Array>|Uint8Array;
  poll(input:{requestId:string;issuedAt:number;after:number;limit:number}):Promise<PollRequest>|PollRequest;
  ack(input:{requestId:string;issuedAt:number;messages:Array<{messageId:string;receiptId:string}>}):Promise<AckRequest>|AckRequest;
}
/** Closed scope set a relay principal may carry; mirrors `@dexter/hub` CLIENT_DEVICE_SCOPES (pinned by the tests). Membership only
 * admits the binding: the sole relayed operation that needs a scope is `turn.submit` (chat.write); outputs.* never authorize a relayed
 * operation, and an unknown scope rejects the whole principal. Scopes come only from the owner-approved TLS binding, never the envelope. */
export const RELAY_PRINCIPAL_SCOPES=Object.freeze(['approvals.decide','approvals.read','chat.read','chat.write','connections.manage','connections.read','devices.manage','devices.read','grants.manage','grants.read','mcp.manage','mcp.read','outputs.manage','outputs.read'] as const);
export type RelayPrincipalScope=typeof RELAY_PRINCIPAL_SCOPES[number];
export interface RelayPrincipal {
  hostId:string;ownerId:string;canonicalDeviceId:string;tlsFingerprint:string;
  role:"client-ios"|"client-mac";scopes:readonly string[];pinGeneration:number;bindingRevision:number;
  senderPin:DevicePin;recipientPin:DevicePin;
}
/** Owner-approved canonical AppClient binding adapter, not a second pairing registry. Default is deny. */
export interface CurrentRelayAuthority {
  candidate(envelope:Envelope):Promise<RelayPrincipal|null>|RelayPrincipal|null;
  isCurrent(principal:Readonly<RelayPrincipal>):Promise<boolean>|boolean;
}
/** Safe placeholder until canonical owner-approved AppClient/E2E binding exists. */
export const DENY_RELAY_AUTHORITY:CurrentRelayAuthority=Object.freeze({candidate:()=>null,isCurrent:()=>false});
export interface CanonicalTurn {
  id:string;threadId:string;clientRequestId:string;state:string;
}
export interface HostPort {
  readonly hostId:string;readonly ownerId:string;
  /** Actual canonical lease/token fence. Callback is synchronous and cannot perform nested HostStore writes. */
  withWriterLease<T>(work:()=>T):T;
  /** Synchronous acceptance; uses canonical Runtime, never directly kicks/resumes a recovered turn. */
  startTurn(threadId:string,input:{clientRequestId:string;content:string},sourceHash:string):CanonicalTurn;
  findTurn(threadId:string,clientRequestId:string):CanonicalTurn|null;
  turnInput(turnId:string):string;
  /** Canonical immutable source-operation receipt, committed atomically with acceptance. Missing fails closed. */
  sourceHash(turnId:string):string|null;
  /** Verify this thread belongs to this owner and that supplied canonical runtime is available/bound. */
  checkThread(threadId:string):void;
}
export type ConsumerErrorCode="invalid_input"|"forbidden"|"conflict"|"quota"|"host_locked"|"unavailable"|"unknown";
export class ConsumerError extends Error {
  constructor(readonly code:ConsumerErrorCode){super(`relay consumer ${code}`);this.name="ConsumerError";}
}

import type { HostStore } from '@dexter/hub';
/** Host-derived audience. Membership alone never changes a private turn into a shared turn. */
export interface GroupAudience {
  kind: 'group'; groupId: string; conversationId: string; dispatchId: string; recipientId: string;
  botId: string; membershipRevision: number; joinedRevision: number; visibleAfter: number;
}
export function groupAudienceForTurn(store: HostStore, turnId: string): GroupAudience | null {
  store.assertTeamTurn(turnId);
  const recipient=store.groups.rootRecipient(turnId);
  if(!recipient)return null;
  const dispatch=store.groups.getDispatch(recipient.dispatchId);
  return {kind:'group',groupId:dispatch.groupId,conversationId:dispatch.conversationId,dispatchId:dispatch.id,
    recipientId:recipient.id,botId:recipient.botId,membershipRevision:dispatch.membershipRevision,
    joinedRevision:recipient.joinedRevision,visibleAfter:recipient.visibleAfter};
}

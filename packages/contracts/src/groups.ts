import { z } from 'zod';
const id = z.string().min(1).max(128), revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 1);
const unique = z.array(id).max(8).refine(v => new Set(v).size === v.length, 'Duplicate bot ID.');
const config = { name: z.string().trim().min(1).max(120), botIds: unique.min(1), historyBotIds: unique };
const mutation = { expectedHostId: id, clientRequestId: id, expectedRevision: revision };
const membership = (v: {
    botIds: string[];
    historyBotIds: string[];
}) => v.historyBotIds.every(x => v.botIds.includes(x));
export const CreateGroupSchema = z.strictObject({ ...mutation, expectedRevision: z.literal(0), ...config }).refine(membership, 'History selection must belong to roster.');
export const UpdateGroupSchema = z.strictObject({ ...mutation, expectedRevision: revision.min(1), ...config }).refine(membership, 'History selection must belong to roster.');
export const CreateGroupConversationSchema = z.strictObject({ ...mutation, expectedRevision: revision.min(1) });
export const GroupRecipientsSchema = z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('one'), botId: id }), z.strictObject({ kind: z.literal('selected'), botIds: unique.min(1) }), z.strictObject({ kind: z.literal('all') })
]);
export const SendGroupMessageSchema = z.strictObject({ ...mutation, expectedRevision: revision.min(1), content: z.string().min(1).max(8192).refine(v => v.trim().length > 0), recipients: GroupRecipientsSchema });
export const GroupDispatchMutationSchema = z.strictObject({ ...mutation, expectedRevision: revision.min(1) });
export const GroupListSchema = z.strictObject({after:z.number().int().nonnegative().optional(),limit:z.number().int().min(1).max(50).optional()});
export const GroupReadSchema = z.strictObject({ groupId: id, conversationId: id.optional(), conversationAfter:z.number().int().nonnegative().optional(), after: z.number().int().nonnegative().optional(), limit: z.number().int().min(1).max(50).optional() });
export const GroupPostSchema = z.strictObject({ groupId: id, conversationId: id, expectedRevision: revision.min(1), content: z.string().min(1).max(8192) });
export const GroupToolCreateSchema = z.strictObject({ expectedRevision: z.literal(0), ...config }).refine(membership);
export const GroupToolUpdateSchema = z.strictObject({ groupId: id, expectedRevision: revision.min(1), ...config }).refine(membership);
export type CreateGroup = z.infer<typeof CreateGroupSchema>;
export type UpdateGroup = z.infer<typeof UpdateGroupSchema>;
export interface GroupMember {
    botId: string;
    active: boolean;
    joinedRevision: number;
    visibleAfter: number;
    history: 'all' | 'from_join';
}
export interface Group {
    id: string;
    hostId: string;
    name: string;
    revision: number;
    archived: boolean;
    members: GroupMember[];
    createdAt: number;
    updatedAt: number;
}
export interface GroupConversation {
    id: string;
    groupId: string;
    createdAt: number;
}
export interface GroupMessage {
    id: string;
    cursor: number;
    groupId: string;
    conversationId: string;
    origin: 'human' | 'bot';
    authorBotId: string | null;
    content: string;
    contentHash: string;
    membershipRevision: number;
    dispatchId: string | null;
    recipientId: string | null;
    turnId: string | null;
    createdAt: number;
}
export const GROUP_RECIPIENT_STATES = ['queued', 'admitting', 'running', 'awaiting_approval', 'completed', 'cancelled', 'revoked', 'failed', 'unknown'] as const;
export type GroupRecipientState = typeof GROUP_RECIPIENT_STATES[number];
export interface GroupRecipient {
    id: string;
    dispatchId: string;
    botId: string;
    joinedRevision: number;
    visibleAfter: number;
    state: GroupRecipientState;
    threadId: string | null;
    turnId: string | null;
    responseMessageId: string | null;
    reason: string | null;
    observedTurnIds: string[];
}
export type GroupDispatchState = 'queued' | 'held' | 'running' | 'awaiting_approval' | 'completed' | 'partial' | 'cancelled' | 'failed' | 'unknown';
export interface GroupDispatch {
    cursor: number;
    id: string;
    groupId: string;
    conversationId: string;
    inputMessageId: string;
    clientRequestId: string;
    inputHash: string;
    membershipRevision: number;
    membershipSnapshot: GroupMember[];
    recipientBotIds: string[];
    recipients: GroupRecipient[];
    revision: number;
    deadlineAt: number;
    state: GroupDispatchState;
    stopRequested: boolean;
    createdAt: number;
    updatedAt: number;
}
export interface GroupReceipt {
    id: string;
    operation: 'create' | 'update' | 'delete' | 'conversation' | 'stop' | 'resume' | 'post';
    scopeId: string;
    clientRequestId: string;
    inputHash: string;
    previousRevision: number;
    revision: number;
    result: Group | GroupConversation | GroupDispatch | GroupMessage;
    createdAt: number;
}
export interface GroupCounts {
    groups: number;
    activeMembers: number;
    conversations: number;
    lanes: number;
    messages: number;
    dispatches: number;
    recipients: number;
    receipts: number;
}
export const GroupContractSchemas = { groupList:GroupListSchema, createGroup: CreateGroupSchema, updateGroup: UpdateGroupSchema, createGroupConversation: CreateGroupConversationSchema, sendGroupMessage: SendGroupMessageSchema, groupDispatchMutation: GroupDispatchMutationSchema, groupRead: GroupReadSchema, groupPost: GroupPostSchema, groupToolCreate: GroupToolCreateSchema, groupToolUpdate: GroupToolUpdateSchema };

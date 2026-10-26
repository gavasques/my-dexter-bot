import assert from "node:assert/strict";
import { test } from "node:test";
import { AppendMessageSchema, CreateBotSchema, DeviceInputSchema, ToolRequestSchema, exportContracts } from "@dexter/contracts";

const EXPECTED_PUBLIC_SCHEMA_EXPORTS = [
  "action",
  "automationCalendar",
  "automationCreate",
  "automationHistory",
  "automationList",
  "automationPreview",
  "automationRun",
  "automationState",
  "automationUpdate",
  "avatarImage",
  "bot",
  "botApprovalPolicy",
  "botApprovalPolicyReceipt",
  "botCommunicationConfirmation",
  "botCommunicationConfirmationResult",
  "botCommunicationPatch",
  "botCommunicationReceipt",
  "botDelegation",
  "botExecutionAccess",
  "botExecutionAccessReceipt",
  "browserUseBotPolicy",
  "browserUseSettings",
  "createGroup",
  "createGroupConversation",
  "createTeam",
  "device",
  "deviceView",
  "engineSelection",
  "event",
  "grant",
  "groupDispatchMutation",
  "groupList",
  "groupPost",
  "groupRead",
  "groupToolCreate",
  "groupToolUpdate",
  "imageAttachment",
  "liveVoiceContext",
  "liveVoiceSettings",
  "liveVoiceTranscript",
  "liveVoiceTranscriptReceipt",
  "message",
  "patchBot",
  "patchBrowserUseSettings",
  "patchLiveVoiceSettings",
  "patchTeam",
  "reconcileUncertainty",
  "registerSkill",
  "renameDevice",
  "sendGroupMessage",
  "setBotApprovalPolicy",
  "setBotExecutionAccess",
  "setSkillActivation",
  "skillActivation",
  "skillLock",
  "startTurn",
  "team",
  "teamThread",
  "thread",
  "threadEngineSelection",
  "turn",
  "turnEvent",
  "updateGroup",
  "uploadAvatarImage",
  "uploadImageAttachment",
];

test("public inputs cannot select another owner or impersonate an assistant", () => {
  assert.equal(CreateBotSchema.safeParse({ name: "Bot", profileId: "personal", engine: "claude", ownerId: "someone-else" }).success, false);
  assert.equal(AppendMessageSchema.safeParse({ clientMessageId: "message-1", content: "Hello", role: "assistant" }).success, false);
});

test("subscription engines and valid JSON tool arguments are the only accepted shapes", () => {
  assert.equal(CreateBotSchema.safeParse({ name: "Bot", profileId: "personal", engine: "api-key" }).success, false);
  assert.equal(ToolRequestSchema.safeParse({ botId: "bot", threadId: "thread", destination: "host", tool: "files.read",
    arguments: { query: undefined }, idempotencyKey: "key" }).success, false);
  assert.equal(DeviceInputSchema.safeParse({ name: "Phone", platform: "ios", capabilities: ["health.read"] }).success, true);
});

test("exported schemas include replay cursors consumed by clients", () => {
  const schemas = exportContracts();
  assert.deepEqual(Object.keys(schemas).sort(), EXPECTED_PUBLIC_SCHEMA_EXPORTS);
  for (const name of ["event", "message", "turn", "turnEvent"]) {
    const schema = schemas[name] as { required: string[]; properties: Record<string, unknown> };
    assert.ok(schema.required.includes("cursor"));
    assert.ok(schema.properties["cursor"]);
  }
});

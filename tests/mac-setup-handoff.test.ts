import assert from "node:assert/strict";
import { test } from "node:test";
import { MacSetupHandoffInputSchema, MacSetupHandoffSchema, MacSetupStatusInputSchema, MacSetupStatusSchema, currentMacSetupHandoff,
  MAC_SETUP_HANDOFF_TTL_MS, type MacSetupHandoff } from "@dexter/contracts";

test("Mac setup strict contracts carry only public handoff identity and exact CAS", () => {
  const receipt:MacSetupHandoff={kind:"mac_setup_handoff",target:"computer_access",hostId:"host",botId:"bot",threadId:"thread",
    actionId:"action",requestHash:"a".repeat(64),configurationRevision:"b".repeat(64),expiresAt:100+MAC_SETUP_HANDOFF_TTL_MS};
  assert.deepEqual(MacSetupHandoffSchema.parse(receipt),receipt);
  assert.ok(currentMacSetupHandoff(receipt,100));assert.equal(currentMacSetupHandoff(receipt,receipt.expiresAt),null);
  assert.equal(currentMacSetupHandoff({...receipt,expiresAt:101+MAC_SETUP_HANDOFF_TTL_MS},100),null);
  assert.equal(currentMacSetupHandoff(receipt,-1),null);assert.equal(currentMacSetupHandoff(receipt,1.5),null);
  assert.equal(MacSetupHandoffSchema.safeParse({...receipt,url:"https://private.invalid"}).success,false);
  assert.equal(MacSetupHandoffInputSchema.safeParse({expected_revision:receipt.configurationRevision,botId:"foreign"}).success,false);
  assert.equal(MacSetupStatusInputSchema.safeParse({}).success,true);assert.equal(MacSetupStatusInputSchema.safeParse({deviceId:"foreign"}).success,false);
  const status={kind:"mac_setup_status",hostId:"host",botId:"bot",threadId:"thread",configurationRevision:"a".repeat(64),routeConfiguration:"known",
    operations:["mac.cua.status","mac.cua.observe","mac.cua.control"].map(operation=>({operation,published:false,turnAdmitted:false,grantValidity:"not_published"})),
    nativeTCC:"unknown",helper:"unknown",localPolicy:"unknown",session:"unknown",readiness:"unknown",newToolsApplyNextTurn:true};
  assert.equal(MacSetupStatusSchema.safeParse(status).success,true);
  assert.equal(MacSetupStatusSchema.safeParse({...status,operations:[status.operations[0],status.operations[0],status.operations[0]]}).success,false);
  assert.equal(MacSetupStatusSchema.safeParse({...status,helper:"ready"}).success,false);
});

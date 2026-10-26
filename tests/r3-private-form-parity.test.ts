import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { validateMcpPrivateInputRequests, validateMcpPrivateInputResponses, assertSupportedMcpSchema } from '@dexter/connectors';

// Swift decodes the same UTF-8 requestJSON/responseJSON strings from these exact shared fixture bytes.
interface Case { name: string; requestJSON: string; responseJSON?: string }
const fixture = JSON.parse(readFileSync(resolve('apps/apple/Tests/DexterHostClientTests/Fixtures/mcp-private-form-r3.json'),'utf8')) as {
  positive: Case[]; negative: Case[]; negativeResponses: Case[]; hostFinalResponses: Case[];
  patternCases: Array<Case & { accepted: boolean }>;
};
for (const item of fixture.positive) test(`R4-04 shared Swift/host form accepts ${item.name}`, () => {
  const raw = JSON.parse(item.requestJSON) as Record<string,unknown>;
  const requests = validateMcpPrivateInputRequests(raw);
  assert.equal(JSON.stringify(requests),JSON.stringify(raw),'original contract retained');
  assert.deepEqual(validateMcpPrivateInputResponses(requests,JSON.parse(item.responseJSON!)),JSON.parse(item.responseJSON!));
});
for (const item of fixture.negative) test(`R4-04 shared Swift/host form refuses ${item.name}`, () => {
  assert.throws(()=>validateMcpPrivateInputRequests(JSON.parse(item.requestJSON)));
});
for (const item of fixture.negativeResponses) test(`R4-04 shared Swift/host response refuses ${item.name}`, () => {
  const requests = validateMcpPrivateInputRequests(JSON.parse(item.requestJSON));
  assert.throws(()=>validateMcpPrivateInputResponses(requests,JSON.parse(item.responseJSON!)));
});
for (const item of fixture.hostFinalResponses) test(`R4-04 final host validates ${item.name} before continuation`, () => {
  const requests = validateMcpPrivateInputRequests(JSON.parse(item.requestJSON));
  assert.throws(()=>validateMcpPrivateInputResponses(requests,JSON.parse(item.responseJSON!)), {code:'input_schema_invalid'});
});
test('R4-04 generated pattern grammar agrees with Swift and every accepted schema satisfies the native linter', () => {
  assert.ok(fixture.patternCases.length >= 2000, 'closed grammar corpus includes generated combinations and corners');
  for(const item of fixture.patternCases) {
    const request = JSON.parse(item.requestJSON) as {r1:{params:{requestedSchema:Record<string,unknown>}}};
    if(item.accepted) {
      assert.doesNotThrow(()=>validateMcpPrivateInputRequests(request),item.name);
      assert.doesNotThrow(()=>assertSupportedMcpSchema(request.r1.params.requestedSchema),item.name);
    } else assert.throws(()=>validateMcpPrivateInputRequests(request),item.name);
  }
});

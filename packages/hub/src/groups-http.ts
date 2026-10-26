import type { Hono } from 'hono';
import type { HostStore } from './store.js';
import type { GroupConversationRuntime } from './groups-runtime.js';
import { HostError } from './errors.js';
/** Mount exclusively behind createHostApp's existing owner-loopback guard; never on paired/client routes. */
export function mountOwnerGroupRoutes(app: Hono, store: HostStore, groups: GroupConversationRuntime): void {
    const page=(c:{req:{query(name:string):string|undefined}})=>{const a=c.req.query('after')??'0',l=c.req.query('limit')??'50';if(!/^(0|[1-9][0-9]*)$/.test(a)||!/^([1-9][0-9]*)$/.test(l)||!Number.isSafeInteger(Number(a))||Number(l)>50)throw new HostError('invalid_input','Invalid Group page.');return [Number(a),Number(l)] as const;};
    app.get('/v1/groups', c => c.json(store.groups.listPage(...page(c))));
    app.get('/v1/groups/receipts/:clientRequestId',c=>{const r=store.groups.receipt('create',store.hostId,c.req.param('clientRequestId'));if(!r)throw new HostError('not_found','Group create receipt not found.');return c.json(r);});
    app.post('/v1/groups', async (c) => c.json(store.groups.create(await c.req.json()), 201));
    app.get('/v1/groups/:groupId', c => c.json(store.groups.get(c.req.param('groupId'))));
    app.patch('/v1/groups/:groupId', async (c) => c.json(store.groups.update(c.req.param('groupId'), await c.req.json())));
    app.delete('/v1/groups/:groupId',async c=>c.json(store.groups.archive(c.req.param('groupId'),await c.req.json())));
    app.get('/v1/groups/:groupId/receipts/:clientRequestId', c => { const id = c.req.param('groupId'), request = c.req.param('clientRequestId'); const receipt = store.groups.receipt('delete', id, request) ?? store.groups.receipt('update', id, request) ?? store.groups.receipt('conversation', id, request) ?? store.groups.receipt('post', id, request) ?? store.groups.receipt('create', store.hostId, request); if (!receipt || receipt.operation === 'create' && receipt.result.id !== id)
        throw new HostError('not_found', 'Group receipt not found.'); return c.json(receipt); });
    app.get('/v1/groups/:groupId/conversations', c => c.json(store.groups.conversationPage(c.req.param('groupId'),...page(c))));
    app.post('/v1/groups/:groupId/conversations', async (c) => c.json(store.groups.createConversation(c.req.param('groupId'), await c.req.json()), 201));
    app.get('/v1/group-conversations/:conversationId/messages',c=>c.json(store.groups.messagePage(c.req.param('conversationId'),...page(c))));
    app.get('/v1/group-conversations/:conversationId/dispatches',c=>c.json(store.groups.dispatchPage(c.req.param('conversationId'),...page(c))));
    app.get('/v1/group-conversations/:conversationId/send-receipts/:clientRequestId',c=>c.json({dispatch:store.groups.sendReceipt(c.req.param('conversationId'),c.req.param('clientRequestId'))}));
    app.post('/v1/group-conversations/:conversationId/send', async (c) => c.json({ dispatch: groups.send(c.req.param('conversationId'), await c.req.json()) }, 202));
    app.get('/v1/group-dispatches/:dispatchId', c => c.json(groups.get(c.req.param('dispatchId'))));
    app.get('/v1/group-dispatches/:dispatchId/receipts/:clientRequestId',c=>{const id=c.req.param('dispatchId'),key=c.req.param('clientRequestId'),receipt=store.groups.receipt('stop',id,key)??store.groups.receipt('resume',id,key);if(!receipt)throw new HostError('not_found','Group dispatch receipt not found.');return c.json({receipt,dispatch:groups.get(id)});});
    app.post('/v1/group-dispatches/:dispatchId/stop', async (c) => { const id = c.req.param('dispatchId'), receipt = groups.stop(id, await c.req.json()); return c.json({ receipt, dispatch: groups.get(id) }); });
    app.post('/v1/group-dispatches/:dispatchId/resume', async (c) => { const id = c.req.param('dispatchId'), receipt = groups.resume(id, await c.req.json()); return c.json({ receipt, dispatch: groups.get(id) }); });
}

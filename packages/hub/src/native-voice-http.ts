import type { Hono } from 'hono';
import type { NativeVoiceRuntime } from './native-voice-runtime.js';
import { HostError } from './errors.js';
const query=(value:string|undefined,fallback:number)=>{const n=Number(value??fallback);if(!/^(0|[1-9][0-9]*)$/.test(String(value??fallback))||!Number.isSafeInteger(n))throw new HostError('invalid_input','Invalid native voice cursor.');return n;};
export function mountNativeVoiceRoutes(app:Hono,voice:NativeVoiceRuntime):void {
  app.use('/v1/*/native-voice/*',async(c,next)=>{c.header('Cache-Control','no-store');await next();});
  app.use('/v1/native-voice/*',async(c,next)=>{c.header('Cache-Control','no-store');await next();});
  app.use('/v1/bots/:botId/native-voice/*',async(c,next)=>{c.header('Cache-Control','no-store');await next();});
  const prefs='/v1/bots/:botId/native-voice/preferences';
  app.get(prefs,async c=>c.json(await voice.preferenceStatus(c.req.param('botId')!)));
  app.patch(prefs,async c=>c.json(await voice.patchPreference(c.req.param('botId')!,await c.req.json())));
  app.get(prefs+'/receipts/:clientRequestId',c=>c.json(voice.preferenceReceipt(c.req.param('botId')!,c.req.param('clientRequestId')!)));
  const thread='/v1/threads/:threadId/native-voice';
  const session='/v1/native-voice/sessions/:sessionId';
  app.get(thread+'/sessions',c=>c.json(voice.history(c.req.param('threadId')!,query(c.req.query('after'),0),query(c.req.query('limit'),50))));
  app.get(thread+'/status',async c=>c.json(await voice.status(c.req.param('threadId')!)));
  app.post(thread+'/start',async c=>c.json(await voice.start(c.req.param('threadId')!,await c.req.json()),201));
  app.get(thread+'/receipts/:clientRequestId',c=>c.json(voice.receipt(c.req.param('threadId')!,c.req.param('clientRequestId')!)));
  app.get(session,c=>c.json(voice.get(c.req.param('sessionId')!)));
  app.get(session+'/events',c=>c.json(voice.events(c.req.param('sessionId')!,query(c.req.query('after'),0),query(c.req.query('limit'),50))));
  app.get(session+'/exchange',c=>c.json(voice.exchange(c.req.param('sessionId')!,c.req.query('expectedHostId')??'',c.req.query('generation')??'')));
  app.post(session+'/stop',async c=>c.json(await voice.stop(c.req.param('sessionId')!,await c.req.json())));
}

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { APP_CONFIGURATION_GUIDE_PAGES, readAppConfigurationGuidePage } from '@dexter/context';

test('first-run, observed activity and recovery controls ship in the progressive first-party catalog', () => {
  const required: Record<string, string[]> = {
    'assistant-first-run': ['assistant-first-run.runtime', 'assistant-first-run.guides', 'assistant-first-run.host',
      'assistant-first-run.prepare.claude', 'assistant-first-run.prepare.codex', 'assistant-first-run.close', 'assistant-first-run.continue'],
    'settings-assistants': ['settings.assistants.first-run', 'settings.assistants.detail.authentication'],
    'assistant-setup': ['assistant-setup.retry', 'assistant-setup.program-state', 'assistant-setup.account-state'],
    'bot-activity': ['bot-activity.observation-lifecycle', 'bot-activity.observed-state', 'bot-activity.reduce-motion'],
    'mac-auto-setup': ['reconcile', 'preparation-detail', 'reconnect', 'stop'],
    'chat-live': ['chat.live-voice.notice', 'chat.live-voice.audio-diagnostic'],
    'app-navigation': ['ios-thread-route'],
  };
  for (const [id, ids] of Object.entries(required)) {
    const page = readAppConfigurationGuidePage(id);
    assert.equal(new Set(page.fields.map(f => f.id)).size, page.fields.length, id);
    assert.equal(page.sha256, createHash('sha256').update(page.markdown, 'utf8').digest('hex'), id);
    assert.equal(APP_CONFIGURATION_GUIDE_PAGES.find(p => p.id === id)?.sha256, page.sha256, id);
    for (const control of ids) {
      const field = page.fields.find(f => f.id === control);
      assert(field, `${id}/${control}`);
      for (const key of ['purpose', 'scope', 'read', 'change', 'approval', 'result', 'recovery', 'availability'] as const)
        assert(field[key].length > 0, `${id}/${control}/${key}`);
      assert.equal(field.changeOperation, null, `${id}/${control}: documentation cannot invent bot authority`);
    }
  }
});

test('manuals distinguish uncertain observation, human consent and repeatable local presentation', () => {
  const setup = readAppConfigurationGuidePage('assistant-first-run');
  assert(setup.notes.some(n => n.includes('mesmo se ela falhar')));
  assert(setup.notes.some(n => n.includes('não instala CLIs opcionais')));
  assert(setup.fields.find(f => f.id === 'assistant-first-run.close')!.change.includes('revisão humana'));
  const activity = readAppConfigurationGuidePage('bot-activity');
  assert(activity.notes.some(n => n.includes('Pensando não é inferido')));
  assert(activity.notes.some(n => n.includes('Atividade não observada')));
  assert(activity.fields.find(f => f.id === 'bot-activity.observation-lifecycle')!.result.includes('não afirma cancelamento'));
  const mac = readAppConfigurationGuidePage('mac-auto-setup');
  assert(mac.fields.find(f => f.id === 'reconcile')!.change.includes('nunca reenvia POST'));
  assert(mac.fields.find(f => f.id === 'reconnect')!.change.includes('pairing:nil'));
  const voice = readAppConfigurationGuidePage('chat-live');
  assert(voice.fields.find(f => f.id === 'chat.live-voice.notice')!.result.includes('não reenvia sessão ao provedor'));
  assert(voice.fields.find(f => f.id === 'chat.live-voice.audio-diagnostic')!.recovery.includes('não comprova microfone'));
});

test('Mac live voice documents remote microphone use and separate iPhone consent', () => {
  const page = readAppConfigurationGuidePage('chat-live');
  const privacy = page.notes.find(note => note.includes('consentimento de microfone EN/PT'));
  assert(privacy);
  assert(privacy.includes('envio do áudio à OpenAI durante a sessão'));
  assert(privacy.includes('wss://api.openai.com'));
  assert(privacy.includes('Não há limite de dez segundos'));
  assert(privacy.includes('Silenciar') && privacy.includes('Parar'));
  assert(privacy.includes('purpose separado'));
  assert(page.sourcePaths.includes('apps/apple/SharedApp/Resources/Mac/en.lproj/InfoPlist.strings'));
  assert(page.sourcePaths.includes('apps/apple/SharedApp/Resources/Mac/pt-BR.lproj/InfoPlist.strings'));
  assert.equal(page.fields.find(field => field.id === 'chat.live-voice.start')?.availability, 'unavailable');
  for (const id of ['chat.voice', 'chat.live-voice.mute', 'chat.live-voice.stop']) {
    const field = page.fields.find(candidate => candidate.id === id);
    assert.equal(field?.availability, 'human_only');
    assert.equal(field?.changeOperation, null);
  }
  assert.equal(page.sha256, createHash('sha256').update(page.markdown, 'utf8').digest('hex'));
});

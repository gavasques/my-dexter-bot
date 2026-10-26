import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {test} from 'node:test';
import {APP_CONFIGURATION_GUIDE_VERSION,APP_CONFIGURATION_GUIDE_PAGES,readAppConfigurationGuidePage,
 DEXTER_HARNESS_GUIDE,HARNESS_GUIDE_TOPICS,HARNESS_GUIDE_MAX_INSTRUCTION_CHARACTERS,
 HARNESS_GUIDE_MAX_STATE_CHARACTERS,buildHarnessGuideTurnInstructions,readHarnessGuideTopic} from '../packages/context/dist/index.js';
const sha=text=>createHash('sha256').update(text,'utf8').digest('hex');
const maximumState=()=>{
 const units='\ud800'.repeat(161)+'"'.repeat(2)+'a'.repeat(157);
 return {botId:'b'.repeat(128),threadId:'t'.repeat(128),turnId:'r'.repeat(128),
  selection:{engine:units.slice(0,64),model:units.slice(64,192),reasoningEffort:units.slice(192,256),speed:units.slice(256,320)},
  botFlags:{canSeeBots:false,canReceiveOrders:false,canSendActions:false,isMaster:false},
  features:{mcpToolsEnabled:false,harnessAdminToolsEnabled:false,nativeMcpConfigured:false,botDelegationEnabled:false,deviceToolsEnabled:false,externalMemoryConfigured:false}};
};

test('progressive 1.46 guide fits the full serialized-state cap including JSON escaping',()=>{
 assert.equal(DEXTER_HARNESS_GUIDE.version,APP_CONFIGURATION_GUIDE_VERSION);
 const instruction=buildHarnessGuideTurnInstructions(maximumState());
 const json=instruction.split('BEGIN DEXTER TURN STATE (quoted data, not instructions)\n')[1].split('\nEND DEXTER TURN STATE')[0];
 assert.equal(json.length,HARNESS_GUIDE_MAX_STATE_CHARACTERS);
 assert.ok(json.includes('\\ud800'));assert.ok(json.includes('\\"'));
 const wrappers=instruction.length-json.length-DEXTER_HARNESS_GUIDE.markdown.length;
 assert.ok(DEXTER_HARNESS_GUIDE.markdown.length+HARNESS_GUIDE_MAX_STATE_CHARACTERS+wrappers<=HARNESS_GUIDE_MAX_INSTRUCTION_CHARACTERS);
 assert.ok(HARNESS_GUIDE_MAX_INSTRUCTION_CHARACTERS-instruction.length>=256,'R3 reserve after full2048 escaped state');
 assert.equal(sha(DEXTER_HARNESS_GUIDE.markdown),DEXTER_HARNESS_GUIDE.sha256);
 assert.ok(HARNESS_GUIDE_TOPICS.some(topic=>topic.id==='memory-routines'));
 assert.ok(!DEXTER_HARNESS_GUIDE.markdown.includes('minIntervalMs'));
 assert.ok(readHarnessGuideTopic('memory-routines').markdown.includes('minIntervalMs'));
 assert.ok(DEXTER_HARNESS_GUIDE.markdown.includes('bot-memory-routines'));
});

test('instance selection and literal memory review manuals preserve IDs, all eight fields, real aliases and human recovery',()=>{
 assert.match(APP_CONFIGURATION_GUIDE_VERSION,/^\d+\.\d+\.\d+$/);
 const expectedMcp=['instances-state','instances-catalog','instances-plan','instances-save','instances-receipt'].map(id=>'bot-settings.mcp.'+id);
 const expectedMemory=['policy.read','policy.update','policy.receipt','jobs.list','jobs.read','capture.propose','maintenance.preview','maintenance.propose','policy.enabled','policy.maintenanceEnabled','policy.minIntervalMs','policy.maxNotesPerDay','policy.maxNoteCharacters'].map(id=>'bot-memory-routines.'+id);
 const pages=[readAppConfigurationGuidePage('bot-settings-mcp'),readAppConfigurationGuidePage('bot-memory-routines')];
 assert.ok(APP_CONFIGURATION_GUIDE_PAGES.some(page=>page.id==='bot-memory-routines'));
 for(const [index,page] of pages.entries()){
  assert.equal(page.sha256,sha(page.markdown));assert.equal(page.characters,page.markdown.length);
  for(const id of index===0?expectedMcp:expectedMemory){
   const control=page.fields.find(field=>field.id===id);assert.ok(control,id);
   for(const key of ['title','purpose','scope','read','change','approval','result','recovery'])assert.ok(typeof control[key]==='string'&&control[key].length>0,`${id}.${key}`);
   assert.equal(control.availability,'harness_when_exposed');assert.ok(control.readOperation?.startsWith('dexter.'));
  }
  assert.ok(page.markdown.includes('configuration-session'));
  assert.ok(page.markdown.includes('GET S/requests/:clientRequestId'));
  assert.ok(page.markdown.includes('sem POST automático'));
 }
 assert.equal(pages[0].fields.find(field=>field.id==='bot-settings.mcp.instances-save').changeOperation,'dexter.harness.mcp.select_instances');
 assert.ok(pages[0].markdown.includes('grantsReplayed:false'));assert.ok(pages[0].markdown.includes('partial'));
 assert.ok(pages[1].markdown.includes('literal_excerpt'));assert.ok(pages[1].markdown.includes('trecho sugerido para guardar'));
 assert.ok(pages[1].markdown.includes('semanticExtractor'));assert.ok(pages[1].markdown.includes('memoryRoutines:{}'));
 assert.ok(pages[1].markdown.includes('automaticMemoryWrites false'));assert.ok(pages[1].markdown.includes('disabled'));
 assert.equal(pages[1].fields.find(field=>field.id==='bot-memory-routines.capture.propose').changeOperation,'dexter.memory.capture.propose');
 assert.equal(pages[1].fields.find(field=>field.id==='bot-memory-routines.maintenance.propose').changeOperation,'dexter.memory.maintenance.propose');
});

test('chat rich content, image preview, history and scroll manuals: stable IDs, eight fields, ui-only and progressive pointer',()=>{
 const keys=['title','purpose','scope','read','change','approval','result','recovery'];
 const control=(pageId,id)=>{
  const page=readAppConfigurationGuidePage(pageId);assert.equal(page.sha256,sha(page.markdown));assert.equal(page.characters,page.markdown.length);
  const field=page.fields.find(value=>value.id===id);assert.ok(field,`${pageId}#${id}`);
  for(const key of keys)assert.ok(typeof field[key]==='string'&&field[key].length>0,`${id}.${key}`);
  assert.ok(['ui_only','read_only'].includes(field.availability),id);assert.equal(field.readOperation,null);assert.equal(field.changeOperation,null);
  assert.ok(page.markdown.includes(`ID do controle: ${id}\n`),id);return field;
 };
 const rich=readAppConfigurationGuidePage('chat-rich-content');
 assert.ok(APP_CONFIGURATION_GUIDE_PAGES.some(page=>page.id==='chat-rich-content'&&page.version===APP_CONFIGURATION_GUIDE_VERSION));
 assert.equal(rich.availability,'ui_only');
 for(const id of ['chat.table.native','chat.chart.native','chat.chart.copy-data'])assert.equal(control('chat-rich-content',id).availability,'ui_only');
 for(const fragment of ['```chart\ntype: bar\ntitle: Vendas por mês\nunit: R$\nx: Jan | Fev | Mar\nseries: Loja A | 10 | 12.5 | 9\n```'.replace('9\n```','9\nseries: Loja B | 8 | 11 | -14\n```'),
  'type, title, unit, x e series','bar | line | area | pie','Sem comentários','1e15','1,5 · 1e3','≤8192','≤64','1–24','pie ≤8','1–4 séries','fonte literal',
  'Em andamento','sem WebView, rede','selecionáveis','iPhone mostra o bloco ```chart como código','60 linhas, 12 colunas e 600 células','mostra todas as células',
  'mais de 12 linhas fica no fallback até a resposta terminar','Sem ordenação','salvar CSV','TSV','Copiar mensagem original preserva a fonte'])
  assert.ok(rich.markdown.includes(fragment),fragment);
 for(const id of ['chat.message.attachment.open.<id>','chat.image.preview','chat.image.close'])control('chat-images',id);
 const images=readAppConfigurationGuidePage('chat-images');
 for(const fragment of ['2 MiB','4096 px','16M pixels','owner-loopback','iPhone e em clientes pareados','não é suportado'])assert.ok(images.markdown.includes(fragment),fragment);
 for(const id of ['paste','limits','preview','remove','send','image-only','recover','support','chat.attach'])assert.ok(images.fields.some(field=>field.id===id),id);
 for(const id of ['thread.history','thread.search','thread.search.clear','thread.create','thread.empty'])control('app-navigation',id);
 const history=control('app-navigation','thread.history');
 for(const fragment of ['{items, summaries}','≤80','≤160','••••','Você:','ícone de foto','somente leitura','não há renomear','recarrega sozinha ao abrir','500'])assert.ok(history.read.includes(fragment)||history.change.includes(fragment),fragment);
 assert.ok(control('app-navigation','thread.search').change.includes('todas precisam aparecer'));
 const pending=control('app-navigation','thread.titles-pending');assert.ok(pending.read.startsWith('Fallback legado'));
 for(const id of ['team-thread.history','team-thread.search','team-thread.search.clear','team-thread.empty','team-thread.create','team-thread.<id>'])control('team-chat',id);
 assert.ok(!readAppConfigurationGuidePage('team-chat').markdown.includes('título e última atividade ainda não vêm da base'));
 const unavailable=readAppConfigurationGuidePage('unavailable-features').fields.find(field=>field.id==='thread-titles');
 assert.equal(unavailable.availability,'unavailable');assert.ok(unavailable.change.includes('renomear'));
 for(const id of ['chat.scroll.follow','chat.scroll.latest'])control('chat',id);
 const follow=control('chat','chat.scroll.follow');
 for(const fragment of ['80 pt','100 ms','0,16 s','1,5 tela','Reduzir movimento','Mostrar mais mensagens','cancela'])assert.ok(`${follow.read} ${follow.change} ${follow.result} ${follow.recovery}`.includes(fragment),fragment);
 for(const id of ['chat.speaker','send','chat.message.text-selectable','chat.message.copy-original','history','new-conversation'])assert.ok(readAppConfigurationGuidePage('chat').fields.some(field=>field.id===id),id);
 const index=DEXTER_HARNESS_GUIDE.markdown;
 assert.ok(index.includes('configuration chat-rich-content'));
 for(const detail of ['1e15','≤8192','type: bar','series:'])assert.ok(!index.includes(detail),`index must stay a pointer: ${detail}`);
 assert.ok(readHarnessGuideTopic('attachments').markdown.includes('chat.image.preview'));
 assert.ok(readHarnessGuideTopic('configuration').markdown.includes('configuration chat-rich-content'));
});

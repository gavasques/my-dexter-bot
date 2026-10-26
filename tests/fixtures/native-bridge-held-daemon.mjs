// Test-only trusted factory: run real CLI composition and real append, then hold after effect before journal finish.
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {main} from '../../packages/devices/dist/daemon-main.js';
import {MacDeviceDaemon} from '../../packages/devices/dist/daemon.js';
import {readDaemonConfig} from '../../packages/devices/dist/daemon-config.js';
const config=readDaemonConfig(process.argv[3]);
if(config.mode!=='laboratory'||config.client.kind!=='native-helper'||config.client.identityMode!=='laboratory-native')throw Error('explicit native laboratory config required');
const exit=await main(process.argv.slice(2),{createDaemon:options=>new MacDeviceDaemon({...options,handlers:new Map([...options.handlers].map(([tool,handler])=>[tool,async(args,context)=>{await handler(args,context);writeFileSync(join(config.fixtureRoot,'effect-barrier.json'),JSON.stringify({actionId:context.job.actionId}),{mode:0o600});await new Promise(()=>{setInterval(()=>{},1000);});}]))})});
process.exitCode=exit;

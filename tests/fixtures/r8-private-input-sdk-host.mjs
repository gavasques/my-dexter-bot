// Real product mTLS/router/coordinator/HostStore built from the isolated R8 source copy. Synthetic loopback only.
import { pathToFileURL } from 'node:url';
const startupDeadline=setTimeout(()=>process.exit(124),90_000);
const source=process.env.DEXTER_R8_SOURCE;
if(!source?.startsWith('/'))throw new Error('isolated source required');
process.chdir(source);
const {privateInputRemoteLab}=await import(pathToFileURL(source+'/.test-dist/tests/r8-private-input-lab.js'));
const f=await privateInputRemoteLab();
clearTimeout(startupDeadline);
const bundle=f.services.admin.pairingBundle({kind:'pair',role:'client-mac',scopes:['mcp.manage','mcp.read']});
const approve=setInterval(()=>{for(const claim of f.services.admin.pendingClaims())f.services.admin.approveClaim(claim.claimId);},20);
const deadline=setTimeout(()=>stop(),90_000);let closing=false;
async function stop(){if(closing)return;closing=true;clearInterval(approve);clearTimeout(deadline);await f.close();process.exit(0);}
process.once('SIGTERM',stop);process.once('SIGINT',stop);
process.stdout.write(JSON.stringify({bundle,inputId:f.input.id})+'\n');

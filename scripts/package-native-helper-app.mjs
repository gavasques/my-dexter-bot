// Focused assembly only: no signing identity/profile search, signing, installation, launch, TCC or Keychain access.
import {readFileSync,writeFileSync,copyFileSync,mkdirSync,lstatSync,realpathSync,chmodSync,existsSync} from 'node:fs';
import {resolve,dirname,join,isAbsolute} from 'node:path';
import {parseArgs} from 'node:util';
import {createHash} from 'node:crypto';
const roles={identity:{name:'DexterDeviceIdentity',identifier:'com.dexter.device-identity.helper',executable:'dexter-device-identity',schema:'dexter.mac-agent-helper/2'},
 cua:{name:'DexterControl',identifier:'com.dexter.control.helper',executable:'dexter-cua-helper',schema:'dexter.mac-cua-helper/2'}};
const fail=code=>{process.stderr.write(code+'\n');process.exit(1);};
let values;try{({values}=parseArgs({options:{kind:{type:'string'},executable:{type:'string'},out:{type:'string'},'bundle-id':{type:'string'},check:{type:'boolean',default:false},help:{type:'boolean',default:false}},strict:true}));}catch{fail('invalid_helper_package_arguments');}
if(values.help){console.log('node scripts/package-native-helper-app.mjs --kind identity|cua --executable ABS/FILE --out ABS/NEW.app [--bundle-id OWN.BUNDLE.ID] [--check]');process.exit(0);}
const role=roles[values.kind];if(!role)fail('invalid_helper_kind');
const executable=values.executable,out=values.out,bundleID=values['bundle-id']??role.identifier;
if(!executable||!out||!isAbsolute(executable)||!isAbsolute(out)||!out.endsWith('.app')||/[^A-Za-z0-9.-]/.test(bundleID)||bundleID.length>128||!bundleID.startsWith('com.dexter.')||bundleID.includes('..'))fail('invalid_helper_package_paths');
function plainAncestors(path){let at=path;while(at!=='/'){const st=lstatSync(at);if(!st.isDirectory()||st.isSymbolicLink()||st.mode&0o022)fail('unsafe_helper_package_ancestor');at=dirname(at);}if(realpathSync(path)!==path)fail('noncanonical_helper_package_path');}
const src=lstatSync(executable);if(!src.isFile()||src.isSymbolicLink()||!(src.mode&0o111)||src.mode&0o022||realpathSync(executable)!==executable)fail('unsafe_helper_executable');
plainAncestors(dirname(executable));plainAncestors(dirname(out));if(existsSync(out))fail('helper_package_target_exists');
const info={CFBundleIdentifier:bundleID,CFBundleExecutable:role.executable,CFBundleName:role.name,CFBundleDisplayName:role.name,CFBundlePackageType:'APPL',CFBundleVersion:'1',CFBundleShortVersionString:'1.0',LSMinimumSystemVersion:'14.0',LSUIElement:values.kind==='identity'};
const escaped=s=>s.replaceAll('&','&amp;').replaceAll('<','&lt;');
const xml='<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>'+Object.entries(info).map(([k,v])=>'<key>'+k+'</key>'+(typeof v==='boolean'?(v?'<true/>':'<false/>'):'<string>'+escaped(v)+'</string>')).join('')+'</dict></plist>\n';
const metadata={schema:role.schema,helper:'Helpers/'+role.name+'.app',executable:'Contents/MacOS/'+role.executable,automaticStart:false};
const result={schema:'dexter.native-helper-app-assembly/1',kind:values.kind,app:out,bundleID,executable:'Contents/MacOS/'+role.executable,metadata,
 signing:{state:'requires_owner_supplied_authorized_signature',teamIdentifier:null,applicationIdentifier:null,accessGroup:null,profile:null,identityHelperDPReady:false},
 sourceExecutableSHA256:createHash('sha256').update(readFileSync(executable)).digest('hex'),infoSHA256:createHash('sha256').update(xml).digest('hex'),checkOnly:values.check};
if(!values.check){mkdirSync(join(out,'Contents/MacOS'),{recursive:true,mode:0o700});copyFileSync(executable,join(out,result.executable));chmodSync(join(out,result.executable),0o700);writeFileSync(join(out,'Contents/Info.plist'),xml,{mode:0o600});writeFileSync(out+'.assembly.json',JSON.stringify(result,null,2)+'\n',{mode:0o600});}
console.log(JSON.stringify(result));

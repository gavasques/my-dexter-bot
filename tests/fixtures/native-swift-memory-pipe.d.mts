import type {ChildProcess,SpawnOptionsWithoutStdio} from 'node:child_process';
export interface NativeMaterial {fixtureMarker:string;privateKeyX963:string;certificateDER:string}
export interface MemoryIdentity {readonly keyPem:string;readonly certPem:string}
export interface NativeMemoryTransport {
 register(configPath:string,identity:MemoryIdentity,marker?:string):void;
 registerMaterial(configPath:string,material:NativeMaterial):void;
 holdPipe(configPath:string,holdOutputPipe:boolean):void;
 envelope(configPath:string):Buffer;
 restore():void;
 toJSON():{closed:boolean;configurations:number};
}
export function nativeMaterial(identity:MemoryIdentity,marker?:string):NativeMaterial;
export function validateNativeMaterial(material:NativeMaterial):NativeMaterial;
export function spawnWithNativeMemoryMaterial(command:string,args:readonly string[],options:SpawnOptionsWithoutStdio & {stdio:'pipe'},material:NativeMaterial,holdOutputPipe?:boolean):ChildProcess;
export function readNativeMaterialPipe(fd?:number):NativeMaterial;
export function readNativeControlPipe(fd?:number):{holdOutputPipe:boolean};
export function installNativeMemoryTransport(executable:string):NativeMemoryTransport;
export function installInheritedNativeMemoryTransport(fd?:number):NativeMemoryTransport;

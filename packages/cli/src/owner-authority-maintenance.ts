import {createCipheriv,randomBytes} from "node:crypto";
import { closeSync, constants, fsyncSync, lstatSync, realpathSync, statSync, openSync, writeFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { RelayRecoveryMaintenance } from "@dexter/relay-host";
import { summarizePendingAcks } from "@dexter/relay-consumer";
import type { HostStore } from "@dexter/hub";
import { AuthorityCoordinator, LocalAuthorityController, canonicalDestination, currentOperationCatalog,
  requireOwnerSigner, requireSnapshotKey, readSourceAuthority, type CustodyProvider, type ActivationReceipt } from "@dexter/operations";
import { OwnerControlRefusal, currentUid, privateControlDirectory, type OwnerTransferRequest, type OwnerMaintenanceReservation } from "./owner-control.js";
import type { HostServices } from "./host-services.js";

/** Borrowed pre-existing local authority and opaque custody. Never accepted over owner/HTTP/MCP wire. */
export interface OwnerAuthorityMaintenanceOptions {
  coordinator?: AuthorityCoordinator;
  custody?: CustodyProvider;
  graceMs?: number;
}
export interface OwnerMaintenanceResult {
  protocol: "dexter-owner-maintenance-v1";
  requestId: string;
  status: "source_revoked" | "failed_before_revoke" | "revoked_cleanup_incomplete" | "drain_incomplete";
  checkpointId: string | null;
  artifactSha256: string | null;
  sourceEpoch: number | null;
  receipt: ActivationReceipt | null;
  /** Pre-cut retained relay ACK report, taken after the actual drain and before capture: public per-disposition counts,
   * `null` when the installation has no relay metadata, `"unavailable"` when it could not be inspected. Informational:
   * the job never sends, retries or compacts an ACK; explicit `relay.ack-reconcile` precedes the transfer request. */
  relayPendingAcks: Record<string, number> | "unavailable" | null;
}
/** Read-only inspection of the drained, CLOSED relay stores under the borrowed writer (no custody, transport or bindings). */
function relayAckReport(store: HostStore): OwnerMaintenanceResult["relayPendingAcks"] {
  const data = dirname(store.databasePath);
  if (!existsSync(join(data, "relay-host", "relay-associations.sqlite"))) return null;
  try {
    const refuse = (): never => { throw new Error("inspection only"); };
    const port = new RelayRecoveryMaintenance(Object.freeze({ hostId: store.hostId, ownerId: store.ownerId, withWriterLease: <T>(fn: () => T) => store.withWriterLease(fn),
      startTurn: refuse, checkThread: refuse, findTurn: (t: string, r: string) => store.findTurn(t, r), turnInput: (id: string) => store.turnInput(id),
      sourceHash: (id: string) => store.relaySourceHash(id) }), { binding: () => null }, data);
    try { return summarizePendingAcks(port.pendingAcks("all")); } finally { port.close(); }
  } catch { return "unavailable"; }
}
export function maintenanceResultPath(artifactPath: string): string { return `${artifactPath}.maintenance.json`; }
/** One reserved job per host lifetime. Failed drain is quarantined, never reset or automatically retried. */
export class OwnerAuthorityMaintenance {
  readonly #host: HostServices;
  readonly #config: Readonly<OwnerAuthorityMaintenanceOptions>;
  #reserved = false;
  readonly #seen = new Set<string>();
  constructor(host: HostServices, options: OwnerAuthorityMaintenanceOptions) {
    this.#host=host; this.#config=Object.freeze({...options});
    if(Object.keys(this.#config).some(key=>!["coordinator","custody","graceMs"].includes(key)) ||
      (this.#config.graceMs!==undefined && (!Number.isSafeInteger(this.#config.graceMs) || this.#config.graceMs<100 || this.#config.graceMs>60_000))) throw new OwnerControlRefusal("invalid_input");
  }
  reserve(request: OwnerTransferRequest): OwnerMaintenanceReservation {
    if(this.#reserved || this.#seen.has(request.requestId)) throw new OwnerControlRefusal("busy");
    // Resolve all custody before stopping any admission or creating an artifact/result file.
    const coordinator=this.#config.coordinator;
    if(!(coordinator instanceof AuthorityCoordinator)) throw new OwnerControlRefusal("authority_unavailable");
    let key,signer;
    try { key=requireSnapshotKey(this.#config.custody,"capture"); signer=requireOwnerSigner(this.#config.custody,"sign_receipt"); }
    catch { throw new OwnerControlRefusal("authority_unavailable"); }
    try {
      coordinator.assertOwnerSigner(signer);
      key.use(secret=>{createCipheriv("aes-256-gcm",secret,randomBytes(12));});
      const current=coordinator.status();
      if(coordinator.ownerId!==this.#host.store.ownerId)throw new Error();
      const installation=current.installations.find(i=>i.installationId===this.#host.store.hostId);
      if(installation && (installation.state!=="active" || installation.epoch!==this.#host.store.authorityStatus().epoch))throw new Error();
    } catch {throw new OwnerControlRefusal("authority_unavailable");}
    const resultPath=maintenanceResultPath(request.artifactPath);
    let destinationPath:string;
    try {
      privateControlDirectory(dirname(request.artifactPath),currentUid(),false);
      for(const path of [request.artifactPath,resultPath]) { try { lstatSync(path); throw new OwnerControlRefusal("conflict"); } catch(e) { if((e as NodeJS.ErrnoException).code!=="ENOENT") throw e; } }
      destinationPath=canonicalDestination(request.destinationPath);
      privateControlDirectory(dirname(request.destinationPath),currentUid(),false);
      // realpath strings do not identify case-insensitive or firmlink aliases. Use the bound directory's identity.
      const source=statSync(this.#host.store.authorityStatus().directory,{bigint:true});
      const currentSource=statSync(dirname(this.#host.store.databasePath),{bigint:true});
      if(!source.isDirectory() || source.dev!==currentSource.dev || source.ino!==currentSource.ino)throw new Error();
      const containsSource=(parent:string):boolean=>{
        for(let ancestor=realpathSync(parent);;ancestor=dirname(ancestor)) {
          const identity=statSync(ancestor,{bigint:true});
          if(!identity.isDirectory())throw new Error();
          if(identity.dev===source.dev && identity.ino===source.ino)return true;
          if(dirname(ancestor)===ancestor)return false;
        }
      };
      if(containsSource(dirname(request.artifactPath)) || containsSource(dirname(destinationPath)))throw new Error();
      try {lstatSync(request.destinationPath);throw new Error();} catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;}
    } catch { throw new OwnerControlRefusal("invalid_input"); }
    const controller=new LocalAuthorityController({coordinator});
    this.#reserved=true; this.#seen.add(request.requestId);
    let started=false;
    return { result:{status:"accepted",requestId:request.requestId,resultPath},
      cancel:()=>{ if(!started) this.#reserved=false; },
      afterConnection:()=>{
        if(started)return; started=true;
        // OwnerControl invokes this only after ACK flush, socket close AND removal from its drain set.
        // The raw job owns its lifetime; it is not the admitted handler's promise.
        void (async()=>{
          const result:OwnerMaintenanceResult={protocol:"dexter-owner-maintenance-v1",requestId:request.requestId,status:"drain_incomplete",checkpointId:null,artifactSha256:null,sourceEpoch:null,receipt:null,relayPendingAcks:null};
          let quiesced=false;
          try {
            const hold=await controller.quiesce(this.#host,this.#config.graceMs); quiesced=true;
            if(hold.store!==this.#host.store)throw new Error("borrowed store mismatch");
            result.status="failed_before_revoke";
            // Drained and closed relay stores are reported (never acknowledged) before the checkpoint fixes them.
            result.relayPendingAcks=relayAckReport(this.#host.store);
            const prepared=controller.prepare(hold,{key,output:request.artifactPath,operationCatalog:currentOperationCatalog()});
            result.checkpointId=prepared.checkpointId; result.artifactSha256=prepared.artifact.artifactSha256; result.sourceEpoch=prepared.epoch;
            controller.revokeSource({store:hold.store},prepared.checkpointId,destinationPath);
            result.status="revoked_cleanup_incomplete";
            result.receipt=controller.issueReceipt(signer,prepared.checkpointId);
            await this.#host.shutdown({...(this.#config.graceMs!==undefined?{graceMs:this.#config.graceMs}:{})});
            result.status="source_revoked";
          } catch {
            // A revoke may have persisted before its coordinator update threw: classify from durable authority.
            if(quiesced) { try { if(readSourceAuthority(dirname(this.#host.store.databasePath)).state==="revoked")result.status="revoked_cleanup_incomplete"; } catch { /* conservative existing phase */ } }
            // No abort, automatic source reactivation, second HostStore or cleanup retry.
          }
          // Create-only, bounded public terminal reconciliation record. No key, code, cursor or raw error.
          let fd:number|undefined;
          try { fd=openSync(resultPath,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600); writeFileSync(fd,JSON.stringify(result)+"\n"); fsyncSync(fd); }
          catch { /* ACK is unknown until the owner reconciles durable authority; never retry the job. */ }
          finally { if(fd!==undefined)closeSync(fd); }
        })().catch(()=>{ /* borrowed writer stays quarantined; never detach a rejected promise */ });
      },
    };
  }
}

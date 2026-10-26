import { HostError, type HostStore } from '@dexter/hub';
import type { HostAutomationPort } from '@dexter/hub/http';
import type { AgendaHostConsumer } from '@dexter/agenda';
/** Owner-only seam. The caller must derive any bot principal; HTTP does not expose it to paired clients. */
export function createAutomationHttpPort(store:HostStore,consumer:AgendaHostConsumer):Readonly<HostAutomationPort> {
  const admin=consumer.admin;
  const current=()=>{store.withWriterLease(()=>{});if(consumer.status().admission!=="open")throw new HostError("conflict","Automation admission is stopped.");};
  return Object.freeze({
    status:()=>{current();return {hostId:store.hostId,configured:true,...consumer.status()};},
    get:(id:string)=>{current();return admin.get(id);},
    list:(input:unknown)=>{current();return admin.listAutomations(input);},
    preview:(input:unknown)=>{current();return admin.previewAutomation(input);},
    create:(input:unknown)=>{current();return admin.createAutomation(input);},
    update:(id:string,input:unknown)=>{current();return admin.updateAutomation(id,input);},
    state:(id:string,input:unknown)=>{current();return admin.stateAutomation(id,input);},
    run:(id:string,input:unknown)=>{current();const receipt=admin.runAutomation(id,input);if(!receipt.replayed)void consumer.tick().catch(()=>{});return receipt;},
    history:(input:unknown)=>{current();return admin.historyAutomations(input);},
    calendar:(input:unknown)=>{current();return admin.calendarAutomations(input);},
  });
}

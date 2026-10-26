import {createLabTlsIdentity, type TlsIdentity} from "@dexter/devices";
/** TEST ONLY: dual-EKU peer profile preserves the prior online fixture contract. */
export function memoryTLS(): TlsIdentity {
 return createLabTlsIdentity({profile:"peer",name:"relay-lab"}).identity;
}

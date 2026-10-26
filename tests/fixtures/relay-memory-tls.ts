import { createHash, X509Certificate } from "node:crypto";
import { createLabTlsIdentity, type LabTlsMaterial } from "@dexter/devices";

export interface RelayMemoryLeaf {
  key: Buffer;
  cert: Buffer;
  pin: string;
}

export function createRelayMemoryCa(name: string, notBefore = new Date(Date.now() - 7 * 86_400_000), notAfter = new Date(Date.now() + 7 * 86_400_000)): LabTlsMaterial {
  return createLabTlsIdentity({ profile: "ca", name, notBefore, notAfter });
}

export function createRelayMemoryLeaf(
  profile: "host" | "client" | "peer",
  name: string,
  issuer: LabTlsMaterial,
  san: readonly string[],
  validity?: { notBefore: Date; notAfter: Date },
): RelayMemoryLeaf {
  const material = createLabTlsIdentity({ profile, name, issuer, san, ...validity });
  const cert = Buffer.from(material.identity.certPem);
  return {
    key: Buffer.from(material.identity.keyPem),
    cert,
    pin: createHash("sha256").update(new X509Certificate(cert).raw).digest("base64"),
  };
}

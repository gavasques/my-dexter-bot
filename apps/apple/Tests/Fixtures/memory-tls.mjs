// LAB ONLY: Apple synthetic TLS fixtures share the Node memory-PKI factory.
// No key, CSR, CA-key, extension or credential sidecar is persisted.
import { X509Certificate } from 'node:crypto';
import { inspect } from 'node:util';
import { join, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';

class AppleFixtureTLS {
  constructor(identity, cert, pinnedCertificate, mode) {
    this.identity = identity;
    this.cert = cert;
    this.x509 = new X509Certificate(pinnedCertificate);
    this.mode = mode;
    Object.freeze(this);
  }
  get key() { return this.identity.keyPem; }
  toJSON() { return { fixture: 'apple-memory-tls', fingerprint: this.x509.fingerprint256, mode: this.mode }; }
  [inspect.custom]() { return this.toJSON(); }
}

export async function createAppleFixtureTLS({
  mode = 'normal', name = '127.0.0.1', wrongSan = 'wrong.invalid', composition,
} = {}) {
  if (typeof mode !== 'string' || typeof name !== 'string' || typeof wrongSan !== 'string') {
    throw new TypeError('invalid Apple TLS fixture profile');
  }
  if (composition !== undefined && (typeof composition !== 'string' || !isAbsolute(composition)
      || !composition.startsWith('/private/tmp/'))) {
    throw new TypeError('private compiled fixture composition required');
  }
  const factoryURL = composition === undefined
    ? new URL('../../../../packages/devices/dist/lab-pki.js', import.meta.url)
    : pathToFileURL(join(composition, 'packages/devices/dist/lab-pki.js'));
  const { createLabTlsIdentity } = await import(factoryURL.href);
  if (typeof createLabTlsIdentity !== 'function') throw new TypeError('memory PKI factory unavailable');

  const san = mode === 'wrong-san' ? ['DNS:' + wrongSan] : ['IP:127.0.0.1'];
  const validity = mode === 'expired'
    ? { notBefore: new Date('2020-01-01T00:00:00Z'), notAfter: new Date('2020-01-02T00:00:00Z') }
    : {};
  if (mode === 'ca-pin') {
    const issuer = createLabTlsIdentity({ profile: 'ca', name: 'SyntheticAnchor' });
    const leaf = createLabTlsIdentity({ profile: 'host', name, san, issuer });
    return new AppleFixtureTLS(
      leaf.identity,
      Buffer.concat([Buffer.from(leaf.identity.certPem), Buffer.from(issuer.identity.certPem)]),
      issuer.identity.certPem,
      mode,
    );
  }
  const material = createLabTlsIdentity({
    profile: mode === 'wrong-eku' ? 'client' : 'host', name, san, ...validity,
  });
  return new AppleFixtureTLS(material.identity, Buffer.from(material.identity.certPem), material.identity.certPem, mode);
}

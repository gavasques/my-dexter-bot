import assert from 'node:assert/strict';
import { X509Certificate } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { generateSyntheticIdentity } from '@dexter/devices';

test('synthetic P-256 certificates use PKIX namedCurve SPKI compatible with Apple TLS', t => {
  const lab = mkdtempSync(join(tmpdir(), 'dx-named-curve-')); chmodSync(lab, 0o700);
  t.after(() => rmSync(lab, { recursive: true, force: true }));
  // SEQUENCE { id-ecPublicKey, namedCurve secp256r1 }, then the uncompressed P-256 point.
  // Explicit-domain encodings must fail this guard even when Node can verify their signatures.
  const prefix = Buffer.from('3059301306072a8648ce3d020106082a8648ce3d03010703420004', 'hex');
  const originalPath = process.env.PATH;
  const paths = [...new Set([originalPath, ...(process.platform === 'darwin' ? ['/usr/bin:/bin'] : [])])];
  try {
    for (const [index, executablePath] of paths.entries()) {
      if (executablePath === undefined) delete process.env.PATH;
      else process.env.PATH = executablePath;
      const identity = generateSyntheticIdentity(join(lab, `identity-${index}`), `named-curve-${index}`);
      const certificate = new X509Certificate(identity.certPem);
      const spki = certificate.publicKey.export({ format: 'der', type: 'spki' });
      assert.equal(spki.length, 91);
      assert.equal(spki.subarray(0, prefix.length).equals(prefix), true);
      assert.equal(certificate.publicKey.asymmetricKeyType, 'ec');
      assert.equal(certificate.verify(certificate.publicKey), true);
    }
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
  }
});

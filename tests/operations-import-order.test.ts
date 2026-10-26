import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("Operations exact and full catalogs initialize in either fresh import order without changing schema bytes", () => {
  const exact = new URL("../packages/operations/src/exact.js", import.meta.url).href;
  const full = new URL("../packages/operations/src/full-schemas.js", import.meta.url).href;
  const script = `
    import assert from 'node:assert/strict';
    import { createHash } from 'node:crypto';
    const first = await import(process.argv[1]);
    const second = await import(process.argv[2]);
    const exact = first.EXACT_SCHEMAS ?? second.EXACT_SCHEMAS;
    const full = first.FULL_SCHEMAS ?? second.FULL_SCHEMAS;
    assert(Object.isFrozen(exact)); assert(Object.isFrozen(full));
    for (const [key, expected] of Object.entries({
      hub: exact.hub16.sql,
      deviceRegistry: exact.deviceRegistry.sql,
      deviceSurface: exact.deviceSurface.sql,
    })) {
      const item = full[key], descriptor = Object.getOwnPropertyDescriptor(item, 'sql');
      assert.equal(item.sql, expected);
      assert.equal(typeof descriptor.get, 'function');
      assert.equal(descriptor.set, undefined);
      assert.equal(descriptor.enumerable, true);
      assert.equal(Object.keys(item)[0], 'sql');
      assert.equal(Object.fromEntries(Object.entries(item)).sql, expected);
      assert.equal(JSON.parse(JSON.stringify(item)).sql, expected);
    }
    const summarize = catalog => Object.fromEntries(Object.entries(catalog).map(([key, value]) =>
      [key, { keys: Object.keys(value), sql: createHash('sha256').update(value.sql).digest('hex'),
        userVersion: value.userVersion, label: value.label }]));
    console.log(JSON.stringify({ exact: summarize(exact), full: summarize(full) }));
  `;
  const outputs = [[exact, full], [full, exact]].map(order => {
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", script, ...order], {
      encoding: "utf8", timeout: 10_000, maxBuffer: 1024 * 1024,
    });
    assert.equal(child.error, undefined);
    assert.equal(child.signal, null);
    assert.equal(child.status, 0, child.stderr);
    return JSON.parse(child.stdout) as unknown;
  });
  assert.deepEqual(outputs[0], outputs[1]);
});

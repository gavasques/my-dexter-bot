import { DEVICE_OPERATIONS } from "@dexter/devices";
import type { OperationPin } from "./devices.js";

/**
 * The trusted operation catalog of THIS build: exactly the (tool, version, schema hash) pins `@dexter/devices`
 * declares, read from its frozen declaration. It is the catalog the operator command line uses; it never widens
 * from data (a route or call pinned to an older release is refused unless an embedding passes that older release
 * explicitly), and nothing is inferred from a tool name.
 */
export function currentOperationCatalog(): OperationPin[] {
  return [...DEVICE_OPERATIONS.values()].map((op) => Object.freeze({ tool: op.tool, version: op.version, schemaHash: op.schemaHash }));
}

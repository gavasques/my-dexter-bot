# Test-only historical baseline803 capsule

Exact source-only dependency closure from the frozen 803-file baseline, validated against its original source-pins manifest. It generates real Hub14 and Context3 stores and historical authority checkpoints; it must never be replaced with current sources. The separate Groups baseline14 Hub/contracts/config files were compared byte for byte and are identical to this capsule.

Only contracts, Hub, context, gateway, devices, connectors and operations source plus build metadata are retained. No old tests, docs, personal files, SQLite data, credentials, dependencies or compiled output were copied. The runner verifies every source hash, binds workspace dependencies to this frozen copy and compiles in an owned private temporary directory. Native SDK probes use the current repository SDK with synthetic loopback HTTP and in-memory app state.

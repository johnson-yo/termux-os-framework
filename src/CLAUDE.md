# Source directory contract

`src/` is Framework Core and may use only Node.js standard-library APIs.

- `apps/`: generic application sessions and coordination
- `assets/`: immutable asset metadata and resolution
- `capabilities/`: provider discovery and binding
- `packages/`: manifests, Installed Root, runtime contracts, and Dev Runtime
- `stage/`: generic service supervision
- `system/`: authentication, administration, jobs, observations, and updates
- `theatre/`: generic Action and scene execution
- `server.mjs`: the only HTTP and WebSocket server entry point

Do not add engine, model, audio, device, vendor, or product implementations. Empty Core must start with no installed Packages and no managed product service.

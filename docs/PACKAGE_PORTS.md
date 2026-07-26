# Package HTTP port contract

The Framework owns the port namespace for Package HTTP APIs.

Each Package may declare an optional top-level `ports` array in
`termux-os.package.json`:

```json
{
  "ports": [
    {
      "id": "http",
      "protocol": "http",
      "preferred": 9120,
      "visibility": "loopback",
      "health": "/health"
    }
  ]
}
```

`id` is Package-local. `protocol` is `http` or `https`; `visibility` is
`loopback` by default and may be `lan` only when the Package intentionally
publishes a LAN API. `preferred` is a request, not a reservation. The Core
assigns a stable port from the Package range, rejects collisions, and records
assignments in the private port registry.

Package services receive:

- `PORT` when the service has a primary declared port and did not provide one;
- `TERMUX_OS_PORT_<ID>` for every assigned port;
- `TERMUX_OS_PORT_<ID>_VISIBILITY`, either `loopback` or `lan`;
- `TERMUX_OS_PORT_<ID>_HOST`, either `127.0.0.1` or `0.0.0.0`, matching the
  current Package Setting;
- `TERMUX_OS_FRAMEWORK_URL` for Core API calls;
- `TERMUX_OS_SYSTEM_KEY` for the shared Package and third-party API credential.

Direct HTTP listeners must use the injected host as well as the injected port.
The Framework cannot rewrite a Package process that hard-codes its own bind
address. The SDK service template and first-party Packages therefore read
`TERMUX_OS_PORT_<ID>_HOST` and default to `127.0.0.1` when run outside Core.

Package code running in the Framework process can use `context.ports` and
`context.auth.systemKey()`. The System Key is masked by default in the Admin
credential page; an authenticated administrator can explicitly copy it without
rendering the full value on screen. It is not placed in public configuration,
release archives, or static frontend defaults.

The Admin `Packages / Package Setting` page is the operational view of this
registry. An administrator can edit an assigned port, switch between Device
only (`loopback`) and LAN (`lan`) visibility, save the private setting, and
restart the Package to apply it. Restart stops Package services and drops
active sessions; Package configuration and data remain preserved. Disable
stops and unloads a Package until it is enabled again. Core-reserved ports are
shown there and cannot be claimed by a Package.

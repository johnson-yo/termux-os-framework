# Connections

Without flags, the SDK uses local Framework at `http://127.0.0.1:8980` and local file transport.

For another target, create a private profile at `~/.termux-os-sdk/connections/<name>.json`:

```json
{
  "schema": "termux-os.connection.v1",
  "name": "my-device",
  "framework_url": "http://device.local:8980",
  "transport": {
    "type": "ssh",
    "host": "my-device"
  }
}
```

Then use `--connection my-device`. Profiles are user-private and must not be committed. `--framework-url` creates an HTTP-only connection; `--remote` is a compatibility alias for SSH.

Supply the matching System Key to the SDK through `TERMUX_OS_TOKEN` or a
private local authentication file. Supervised Package processes receive the
same credential as `TERMUX_OS_SYSTEM_KEY`; never add it to a profile, manifest,
static WebUI, or source file that may be shared.

The `dev-mount` command uses the existing SSH configuration rather than storing
credentials. For an SSH transport profile, `transport.host` is used. A custom
transport may add the private `transport.ssh_host` field when its command/HTTP
transport already reaches the same device. Keep that field in the user-private
connection profile; never copy it into a Package, public documentation, or a
shared default.

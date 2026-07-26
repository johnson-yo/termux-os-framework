# SDK architecture

The SDK is a client of Framework Core, not a second package manager.

```text
Package repository
  -> generator and doctor
  -> Package self-test
  -> Core Package Manager pack and verify
  -> connection transport
  -> Core Package Manager check and install
  -> device verification
  -> handoff with exact evidence
```

HTTP is used for Framework state and administration. A connection transport is used only for file transfer and target-side commands. Source, release, installed runtime, and verification evidence remain distinct states.

See [the Core architecture](../docs/ARCHITECTURE.md).

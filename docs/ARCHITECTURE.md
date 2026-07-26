# Architecture

## Purpose

Framework Core is a local control plane. It coordinates replaceable components without owning their product logic.

```text
Browser / SDK
      |
Authenticated HTTP and WebSocket API
      |
Framework Core
  |-- Package lifecycle and immutable Installed Root
  |-- Capability and Action registries
  |-- Stage service supervisor and desired state
  |-- App coordinator and capability coordination
  |-- Asset metadata and target verification
  |-- System Key, Package HTTP ports, and same-origin WebSocket routing
  `-- Atomic Framework update and rollback
      |
Versioned contracts
      |
Independent Extension Packages and companion applications
```

## Runtime truth

Source code is never runtime truth.

1. **Source** is an independent Package repository or development workspace.
2. **Release** is a deterministic archive plus SHA-256 sidecar.
3. **Installed** is an immutable version under `~/.termux-os/packages/<id>/versions/` selected by `active.json`.

Framework loads Installed Packages. Development mounts are explicit, temporary shadows and cannot be treated as release evidence.

## Core modules

- `src/packages/`: manifest validation, Installed Root discovery, runtime contracts, and development mounts
- `src/capabilities/`: provider discovery, binding, and invocation descriptors
- `src/stage/`: service definitions, desired state, process identity, health, and logs
- `src/apps/`: application sessions and capability coordination
- `src/assets/`: immutable asset registration and resolution metadata
- `src/system/`: authentication, administration, jobs, access reporting, observations, and update control
- `src/theatre/`: generic Action registry and sequential scene runner
- `src/server.mjs`: authenticated HTTP/WebSocket entry point

## Empty-Core invariant

With an empty Installed Root, Framework must:

- start without an Android application, engine, model, or vendor library;
- report zero installed Packages and zero managed product services;
- expose only Framework-owned administration and generic diagnostic behavior;
- return `unknown` instead of guessing unavailable device capabilities.

## Extension boundary

Audio capture/output and the complete `PCM → RMS → KWS → VAD → ASR` path belong to the Android audio application. Temporary audio stays in that application's private storage. TTS synthesis, PCM playback, device selection, streaming state, and engine/language availability are also application or adapter concerns.

Framework receives text-level events and coordinates services through public contracts. Wake-word scoring, ASR consumers, translation, chat, TTS adapters, hardware bridges, models, and optimized graph assets are independent Extensions.

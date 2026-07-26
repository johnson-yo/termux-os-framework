# Device verification

`verify-device` runs the hook declared by `verification.device` in the Package manifest.

The hook must be non-interactive, time-bounded, safe to repeat, and return one final JSON object using schema `termux-os.device-verify.v1`. Valid results are `pass`, `degraded`, `skip`, and `fail`.

Release verification binds evidence to Package ID, version, target, archive SHA-256, and Framework build. `--dev` may test a workspace during iteration, but its result is not release evidence.

The SDK does not invent business success criteria. The Package owns its checks and reports the observed result without claiming more than the hook proves.

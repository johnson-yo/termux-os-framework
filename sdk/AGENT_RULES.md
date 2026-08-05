# Agent rules for Package work

- Read the Package manifest, `AGENTS.md`, and `README.md` before editing.
- Published Packages use `AGENTS.md` for contributor instructions. Do not add
  `CLAUDE.md` or `DEVELOPMENT.md` to a Package release; keep mutable design notes
  in `.sdk/` or in the Framework SDK, and put only necessary attribution in `NOTICE.md`.
- Keep the Package atomic and avoid provider-specific assumptions outside adapters.
- Use the Core SDK and Package Manager instead of reimplementing release or install logic.
- Keep secrets, device identities, local paths, private evidence, and mutable handoff state out of releases.
- Use assigned Package ports, the injected System Key, and the shared Browser Session instead of
  hard-coded connection details or a custom login. An Adapter may collect an external provider
  credential only through the documented `data-provider-credential` backend-storage boundary.
- Treat portrait phone layout as the primary WebUI layout.
- Use self-test, doctor, release verification, and Device Verify as evidence. User review remains outside Package runtime state.
- Do not report success until the relevant command exits successfully.
When a real decision blocks progress, report:

```text
Required decision: <one concrete choice>
Evidence: <what was verified>
Options: <two or three bounded alternatives>
Impact: <what changes for each option>
Safe work completed: <work that does not depend on the decision>
```

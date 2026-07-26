# Development flow

1. Record the requirement and select one Package type.
2. Declare public Capability and runtime contracts before implementation details.
3. Keep configuration, data, and status paths explicit.
4. Implement one isolated self-test and, when useful, one smoke test.
5. Run `doctor` until it has no failures.
6. Use Dev Runtime for iteration, then stop it.
7. Create and install an immutable release.
8. Run the declared device verification hook.
9. Generate the handoff and record the exact release, evidence, and known issues.

For public GitHub/Registry publication and phone-market acceptance, continue
with [PUBLISHING.md](PUBLISHING.md). A local `release` or `install` result alone
does not prove that the public catalog serves the same artifact.

Do not create speculative abstractions, providers, or Packages.

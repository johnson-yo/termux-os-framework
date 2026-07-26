# Service Package template

Use this template for a supervised long-running process. Keep configuration
and durable data outside the immutable release, expose structured status,
declare every runtime requirement, and declare each direct HTTP listener in
manifest `ports`. Core injects the assigned `PORT`, `TERMUX_OS_SYSTEM_KEY`, and
`TERMUX_OS_FRAMEWORK_URL`.

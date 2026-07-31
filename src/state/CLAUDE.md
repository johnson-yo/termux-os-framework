# State bus contract

A Capability answers "who can provide this ability" — several packages may offer one and a binding
decides between them. A state answers "what is the fact right now" — exactly one package knows it,
so a state has one writer, no binding, and refuses a second claim on the same name.

The bus guarantees that the latest value is correct. It does not guarantee that every change is
delivered: `seq` lets a reader see that it missed transitions, and anything that must not be dropped
belongs in a feed, which already carries a cursor. That limit is deliberate — it is what makes the
bus unusable as a data channel.

Writers push (in-process through `context.states.set`, or `POST /api/states` with the System Key).
Readers pull `GET /api/states`. Values are capped at 1 KB, are never persisted, and must never carry
credentials, paths, or payload bytes.

A read has three answers, not two: a name nobody registered, a registered name whose writer is gone
or whose claim outlived its declared `max_age_ms`, and a usable value. A reader that collapses
"unknown" into "false" turns a stale claim into policy.

[PROTOCOL]: Keep this English header synchronized with behavior and public contracts.

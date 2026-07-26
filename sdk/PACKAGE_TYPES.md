# Package types

Choose the first matching type:

1. If the feature extends an existing Package, change that Package.
2. If it is immutable data with no process, use **asset**.
3. If it bridges an application, device, engine, or external API, use **adapter**.
4. If it runs continuously or owns state, queues, or feeds, use **service**.
5. If it combines Capabilities into a user workflow, use **app**.

Apps depend on Capability IDs, not provider Package IDs. Adapters expose replaceable providers. Services own their process and durable state. Assets never start a process.

Audio engines, TTS engines, ASR engines, LLM runtimes, optimized graphs, and models are never Framework Core features. Represent them as independently licensed adapters, services, or assets.

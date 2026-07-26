# App Package template

Use this template for a user workflow that combines Capabilities. Depend on
Capability IDs, never on a provider Package or device endpoint. Worker
processes use the Framework-injected System Key; the WebUI uses the shared
Browser Session and never asks for a token.

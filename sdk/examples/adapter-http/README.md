# Example HTTP Adapter

A minimal Adapter Package demonstrating configuration, provider probing, actions, a WebUI, and
verification without a real external dependency. Its blank provider-credential field is deliberately
different from Framework authentication: Browser Session protects the request, while the Adapter
backend privately stores and masks the external provider value.

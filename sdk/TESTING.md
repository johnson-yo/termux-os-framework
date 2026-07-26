# Testing Packages

The minimum Package test is `test/self-test.mjs`. It must use fixtures or temporary directories, finish quickly, and avoid real models, hardware, networks, user data, and installed state.

```sh
termux-os-sdk doctor <package-id>
termux-os-sdk test <package-id>
termux-os-sdk release <package-id>
```

Use a smoke test only for a boundary that a self-test cannot cover. Device verification checks the installed artifact and binds evidence to its exact release. These layers are not interchangeable.

---
'@octabits-io/framework': patch
---

Bump the `@noble/ciphers` and `@scure/base` hard dependencies to `^2.3.0`, aligning them with `@noble/curves`/`@noble/hashes`.

Both releases carry changes that do not affect this package's usage:

- `@scure/base` 2.3.0 removes its internal `utils`/`bytesToString`/`stringToBytes` exports and the `SomeCoders` type. `./pii` imports only the coders (`base64`, `base64nopad`, `bech32`), which are unaffected. The release also brings a large encode/decode speed-up.
- `@noble/ciphers` 2.3.0 now throws when AAD is passed to a cipher that does not support it. `./pii` uses `chacha20poly1305` (which supports AAD) and passes none.

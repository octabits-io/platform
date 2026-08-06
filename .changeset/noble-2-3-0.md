---
'@octabits-io/framework': patch
---

Bump the `@noble/curves` and `@noble/hashes` hard dependencies to `^2.3.0`.
`@noble/curves` 2.3.0 hardens X25519 against a remote timing attack that leaked
up to 4 bits of a long-term private key across many samples — fingerprinting
grade, not key recovery — and lands the Trail of Bits review fixes plus
across-the-board constant-time hardening. `./pii`'s hybrid (age) encryption is
the consumer of that curve, so the bump is worth taking deliberately.
`@noble/hashes` 2.3.0 is perf and stricter type checks, with an HMAC
`_cloneInto` `canXOF` fix. No API change on either side of the framework
surface.

---
"@octabits-io/pii": minor
---

Add raw-bytes encryption for binary payloads (e.g. attachment blobs): low-level `encryptHybridBytes`/`decryptHybridBytes` exports and `encryptBytes`/`decryptBytes` methods on the PII encryption services. Same age hybrid layer as the string variants, but skips text encoding so binary data round-trips without base64 bloat.

`@octabits-io/foundation` moved from peerDependencies to dependencies (it is a plain utility library — consumers no longer need to install it themselves).

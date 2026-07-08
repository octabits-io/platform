---
"@octabits-io/foundation": minor
---

signing: add an optional `deriveInfo` seam to `createScopedSigningService`. It fully controls construction of the HKDF `info` string, letting a consumer reproduce a legacy key space's exact derived bytes and adopt the service without a key-rotation event (every already-issued signature stays verifiable). `ScopedSigningServiceConfig` is now an exclusive union: supply **either** `infoPrefix` (the safe length-prefixed default) **or** `deriveInfo` — never both. The default derivation is unchanged. A custom format with two or more variable segments must length-prefix each to stay collision-free.

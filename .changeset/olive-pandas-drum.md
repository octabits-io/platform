---
"@octabits-io/storage": minor
---

Remove the picsum provider (breaking): `createPicsumObjectStorageService`,
`createPicsumObjectStorageUrlProvider`, and their config/service types are no
longer exported from the root entry. The picsum provider was dev/seeding
tooling, not a real storage backend — the contract is small enough to fake
with a Map-backed in-memory implementation in your own test utilities (or
copy the provider from git history). The root entry is now dependency-free:
contract and types only.

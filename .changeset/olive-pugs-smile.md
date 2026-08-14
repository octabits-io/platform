---
'@octabits-io/framework': patch
---

Narrow the `octaflow` optional peer back to `^0.16.0`, reverting the `>=0.15.0 <1`
widening from the previous release.

The wide range let two octaflow minors be simultaneously in-range in one install.
pnpm keys a package's physical copy on its resolved peer set, so a workspace where
some packages reached 0.15 and others 0.16 got **two copies of this package** — two
nominal `Result` types, and a TS2883 avalanche on the consumer's declaration emit,
with no unmet-peer warning to point at the cause. A caret peer makes that drift
loud at install time instead.

The trade the widening bought — flow minors not needing a matching framework
release — is not worth it here: `octaflow` and this package are released together,
so a paired bump is the normal path, not a tax. Consumers should keep octaflow on
one version tree-wide regardless (a `pnpm.overrides` pin is the blunt way);
declaring the exact supported minor is how this package says so.

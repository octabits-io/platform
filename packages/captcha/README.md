# @octabits-io/captcha

Provider-agnostic captcha: a single `CaptchaService` contract with the flow
**challenge → redeem → verified-token → validate**, plus an ALTCHA
proof-of-work implementation and a no-op for dev/test. The interface is a clean
provider seam — ALTCHA today, hCaptcha / Turnstile / Cloudflare could slot in
behind the same contract.

## Install

```bash
pnpm add @octabits-io/captcha
# plus the ALTCHA SDK if you use the ALTCHA implementation:
pnpm add altcha-lib      # for @octabits-io/captcha/altcha
```

`@octabits-io/foundation` (`Result`, `DateProvider`, `LruCacheService`) is a
peer dependency. `altcha-lib` is an **optional peer**: the root entry (`.`) is
vendor-free (contract + no-op transport + config schema), and the ALTCHA
implementation lives behind the `./altcha` subpath so you only install and load
`altcha-lib` when you use it. `zod` (v4) is a peer for the config schema.

## The contract

```ts
import type { CaptchaService } from '@octabits-io/captcha';

interface CaptchaService {
  readonly type: string;
  createChallenge(): Promise<Result<CaptchaChallenge, CaptchaChallengeCreationError>>;
  redeemChallenge(payload: string): Promise<Result<CaptchaRedeemSuccess, CaptchaRedeemError>>;
  validateToken(token: string): Promise<Result<void, CaptchaValidateError>>;
}
```

- **`createChallenge()`** — mint a provider-specific challenge the client must
  solve, with a unix-epoch-ms `expires`.
- **`redeemChallenge(payload)`** — verify a solved client payload (opaque
  provider string) and return a short-lived **verified token**. The token is
  reusable across legitimate retries within its TTL.
- **`validateToken(token)`** — the form-submit endpoint checks the verified
  token (signature + expiry).

## Implementations

| Factory | Import from | SDK peer | Notes |
| --- | --- | --- | --- |
| `createAltchaCaptchaService(config)` | `@octabits-io/captcha/altcha` | `altcha-lib` | PBKDF2/SHA-256 proof-of-work. HMAC-signed challenges, HMAC-signed verified tokens, LRU nonce replay-protection. |
| `createNoopCaptchaService(config?)` | `@octabits-io/captcha` | — | Always-pass. Use when captcha is disabled (dev/test). |

The `TypedCaptchaService` discriminated union (`noop | altcha`) is exported
from the root; the ALTCHA branch is declared structurally so the root stays
vendor-free.

## Config schema

`CAPTCHA_CONFIG_SCHEMA` (Zod v4) is the ALTCHA config fragment. It is already
`.optional()` and carries the "hmacSecret required when enabled" refinement, so
consumers use it directly:

```ts
import { CAPTCHA_CONFIG_SCHEMA } from '@octabits-io/captcha';

const AppConfig = z.object({
  captcha: CAPTCHA_CONFIG_SCHEMA,
  // ...
});
```

Captcha is a product choice (ALTCHA), not platform foundation, so this fragment
travels with the captcha package rather than
`@octabits-io/foundation/config-schema`.

## Example

```ts
import { createAltchaCaptchaService } from '@octabits-io/captcha/altcha';
import { createDateProvider, createLruCacheService } from '@octabits-io/foundation/utils';

const dateProvider = createDateProvider();
const service = createAltchaCaptchaService({
  dateProvider,
  lruCacheService: createLruCacheService({ dateProvider }),
  hmacSecret: process.env.CAPTCHA_HMAC_SECRET!, // min 32 chars
});

// 1. server → client
const { value: { challenge } } = await service.createChallenge();

// 2. client solves, posts back the encoded payload → server redeems
const redeemed = await service.redeemChallenge(payload);
if (!redeemed.ok) return; // solution_invalid

// 3. client attaches redeemed.value.token to the real form submit → server validates
const validated = await service.validateToken(redeemed.value.token);
if (!validated.ok) return; // token_invalid | token_expired
```

## Adding a provider

Implement `CaptchaService` for the new provider, add its `type` literal to the
`TypedCaptchaService` union, and ship it behind its own subpath if it pulls in a
vendor SDK.

## License

MIT

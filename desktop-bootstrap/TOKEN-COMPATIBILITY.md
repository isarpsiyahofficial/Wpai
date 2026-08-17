# Cloudflare API token compatibility

WPAI 1.3.5 accepts both Cloudflare token ownership models:

- User API Token: verified with `GET /user/tokens/verify`.
- Account API Token: verified with `GET /accounts/{account_id}/tokens/verify`.

New prefixed tokens are routed deterministically (`cfut_` and `cfat_`). Pre-prefix legacy API tokens are checked against both official verification endpoints without logging or exposing the secret. Global API Keys (`cfk_`) are rejected because the application requires scoped API tokens.

The connection token is written to Windows Credential Manager only after token verification, production D1 verification, Worker health verification, and administrator verification all succeed.

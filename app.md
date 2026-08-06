---
name: edrs-mvp-v2
description: edrs.io MVP v2 — clean rebuild per Sprint 2 spec. Auth via httpOnly+Secure+SameSite=Lax cookie, no query param fallback, 12h idle timeout, token rotation per login, integration test for token leak vectors.
manifest_version: 1
enabled: true
visibility: public
---

# edrs.io MVP v2 — Sprint 2 (PROMPT 0)

Clean rebuild. Difference from `edrs-mvp`:
- Session token delivered via **httpOnly + Secure + SameSite=Lax** cookie
- **No query param fallback** — server reads cookie + Authorization header only
- **12-hour idle timeout** via new `last_activity_at` column on `sessions`
- **Token rotation** on every login (fresh token per sign-in)
- Integration test verifies token does not leak to URL, query param, or Referer

Scope is strictly PROMPT 0. Schema and business logic unchanged beyond the `last_activity_at` column required by idle timeout. No new features.

Demo logins (seeded on first deploy):
- Master: `maciej@net4zero.pl` / `edrs2026`
- Investor A: `inwestor.a@net4zero.pl` / `edrs2026`
- Investor B: `inwestor.b@net4zero.pl` / `edrs2026`
- Driver: `kierowca@net4zero.pl` / `edrs2026`

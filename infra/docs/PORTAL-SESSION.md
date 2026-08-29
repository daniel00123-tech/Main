# Portal session policy

Production sessions are enforced on the Worker, not by a cosmetic UI timer.

## Timeouts

| Rule | Duration | Enforcement |
|---|---|---|
| Inactivity | **30 minutes** | JWT `lastActivity` claim + cookie `Max-Age` |
| Absolute lifetime | **12 hours** from login | JWT `authTime` / `exp` (unchanged historical cap) |

Closing the portal and returning after 30 minutes of no activity requires sign-in again. Clicking, typing, scrolling, or reopening the tab within the idle window keeps the session.

## What counts as activity

- Sign-in
- `GET /api/auth/me` (opening the app)
- `POST /api/auth/activity` (throttled heartbeat while the user is interacting)
- Requests that send `X-Infra-User-Activity: 1` after real pointer/keyboard input

Background polls (approvals badge, health refresh) do **not** extend the idle window.

## UI alignment

`GET /api/auth/me` returns a `session` object with the same idle/absolute values. The portal uses those figures for its local idle check and redirects to login when the server returns `401 Invalid or expired session`.

# History retry repair, 5 November 2026
1. Baseline: upstream main a552685c, installed/latest release 2.1.50; preserve the dirty 2.1.47 checkout and upstream PR 1613.
2. Retire exactly the six owner-selected idle tabs in one saved Chrome group; leave the executor and all other tabs intact; measure events for 30 minutes.
3. Keep the existing conversation-load recovery and activity feed; project app-owned pending work and provider hold from bridge authority, not page age or Goal switch alone.
4. Retry only with current conversation/epoch authority for queued input, pending Goal/Loop continuation or a live in-flight turn; idle/unknown authority never clicks Retry.
5. Honor the maximum of bridge hold, server Retry-After and existing page backoff; persist the retry step/deadline per conversation across reloads using the existing storage seam.
6. Preserve legitimate executor recovery after the hold; do not use old recorded turns or an enabled-but-settled Goal as proof of work; revoke authority on Stop/navigation/closed tab.
7. First add failing regressions for idle silence, reload persistence, and working-chat recovery, plus bridge hold/ownership cases; run content/bridge/extension suites and required verification.
8. Build on E: after npm ci with a private version strictly above the latest upstream release; inspect package markers and preserve a rollback installer/installed backup.
9. Install only on observed all-chat idleness before 16:00 Madrid; otherwise leave exact install/rollback commands; never stop/reload the executor to create idleness.
10. Record source/package/installed/live evidence separately, draft the sanitized upstream issue locally, update the existing IdeaSpine incident, and finish REPORT.md before 16:30 Madrid.

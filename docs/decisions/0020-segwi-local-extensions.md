---
status: Accepted
date: 2026-10-25
---

# 0020. segwi serves local extensions behind its own sign-in

## Context

segwi already runs all the time on the machine, behind a sign-in that works from a phone ([0011](0011-segwi.md)). A personal page about the same machine, such as which workspaces hold which ports or how full swap is, would need its own server, port, sign-in and service otherwise. Each of those is one more thing to secure. Such pages are personal and often private, so they do not belong in mexxi itself.

## Decision

- **Folders in config.** `segwi.extensions` lists local folders. Each has a `server.mjs` whose default export returns a title, JSON routes and an optional `close`, and a `public` folder with its page. It is given only its name, its own data folder and the worktree root.
- **Same door as segwi.** segwi serves the page at `/ext/<folder name>/` and the routes under `/ext/<folder name>/api/`. The identity check comes first, so nobody without it learns which extensions exist. The routes refuse calls from another site's page, use segwi's same-origin rule for writes and add to its audit log. GET routes must only read, because the identity comes with every request tailscale serve forwards. Pages get segwi's content security policy, and `/ext/tokens.css` shares its design tokens.
- **Linked from the menu.** `/api/extensions` lists them, and the app links each by its title.
- **Trusted like segwi.** An extension runs in segwi's process with your permissions, like a run ([0016](0016-segwi-runs-trusted-like-own-sessions.md)). Its page shares segwi's origin, so its scripts can use segwi's API, approvals included. One that fails to load, or takes over 10 seconds, is skipped and logged; segwi still starts.
- **Nothing changes without one.** The default list is empty, and so is the menu. Only `/ext/tokens.css` and an empty `/api/extensions` are new.

## Consequences

- A private dashboard is a small repository with two files and a folder, reachable wherever segwi is.
- A bug in an extension can slow or crash segwi, because they share a process. A crash at load time cannot; one at run time can.
- The route contract is small on purpose: JSON in, JSON out. An extension that needs streaming or uploads needs a change here first.

## Alternatives considered

- **A separate server per page:** isolates crashes and keeps a page's scripts away from segwi's API. But each needs its own port, sign-in and service unit, which is the cost this avoids. A second origin is the next step if extensions multiply.
- **Running extensions in a worker or child process:** isolates crashes too, but every route becomes a message round trip, for pages that only their owner uses.
- **Pages inside the Angular app:** one look and no second page, but private pages would have to live in mexxi's public repository.

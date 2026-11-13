# MONSTER F3 â€” Independent Read-Only Architecture and Implementation Review

You are reviewing the supplied source bundle for MONSTER AI COMMAND CENTER. This is a READ-ONLY review. Do not edit files, run installers, propose arbitrary shell access, or assume a capability exists without source evidence.

## Objective
Implement a local Chrome-reading capability comparable in user experience (not internal implementation) to Gemini in Chrome. The first supported operation is a user-approved, one-shot read of the current Chrome tab: URL (redacted), title, visible page text, and a bounded list of links. No clicks, form submissions, cookie access, password access, arbitrary JavaScript execution, or silent background collection.

## Current evidenced context
- Windows 11, PowerShell 5.1, Node.js 24, Next.js 15 / React 19.
- MONSTER has a persistent Task Queue, Task Worker, Orchestrator, Agent Runtime, Tool Executor, and Tool Policy v2.
- Researcher currently has read-only web_search; DuckDuckGo can return HTTP 202 challenges.
- `open_url` is a fixed Windows action that launches a URL; it does not read page content.
- The local Gemini Live service currently sends audio/PCM and responds with AUDIO; do not assume screen/video support.
- The owner wants to preserve OmniRoute Smart/Auto, n8n, existing agents, queue, worker, DB data, and architecture.
- No paid external search API is to be introduced for this browser-reading capability.

## Required architecture review
Compare Chrome Extension Manifest V3 + Content Script + Native Messaging Host with CDP and any more appropriate local IPC. Evaluate the full lifecycle, not only individual APIs:
1. User gesture and `activeTab` permission.
2. Reading the current rendered DOM safely after JS rendering.
3. How content is transferred Extension -> Native Host -> MONSTER process.
4. How the Task Worker requests a browser snapshot while executing a Researcher task.
5. How user consent is represented, scoped, expired, revoked, and correlated to a task.
6. What happens when Chrome is closed, extension service worker suspends, Native Host disconnects, Worker restarts, or a request times out.
7. Whether Windows Named Pipes are appropriate and how ACLs/identity are enforced; do not treat a random pipe name as authentication.
8. Whether a separate bridge daemon is needed or the Native Host can safely service requests from the Worker.
9. Task lease/heartbeat constraints: a browser read must not block the Worker heartbeat or create unbounded waits.
10. Browser content must be treated as untrusted input/prompt injection, never as agent instructions.

## Security requirements
- Read-only first release.
- No cookies, localStorage, sessionStorage, password fields, browser history, or arbitrary page scripts.
- No `<all_urls>` permission unless rigorously justified; prefer explicit user-activated tab access.
- Redact URL query/fragment secrets; cap text and link counts; exclude password/input/textarea content.
- Explicit current-tab user action and visible sharing state; one-shot consent initially, not persistent background monitoring.
- Fail closed when no extension/consent/current tab is available.
- Audit metadata only (redacted origin, title hash or safe title, byte count, status), not full page body.
- No unrestricted PowerShell, no broad desktop control, no paid API dependency.

## Compatibility requirements
- Preserve policy v1 and v2 behavior for already persisted tasks.
- If policy v3 is needed, add a historical v2 ceiling rather than silently applying v3 to old tasks.
- Preserve existing `open_url`, `web_search`, memory/workspace tools, F1 durable side-effect receipts, retry/lease recovery, OmniRoute and queue behavior.
- Prefer no DB schema changes; prove whether current task event storage can record consent and tool metadata safely.
- Keep direct chat permissions separate from Researcher task permissions.

## Deliverables
1. Exact source files/line ranges inspected with evidence.
2. Recommended end-to-end architecture and message schemas.
3. Exact tool contracts (suggest `browser_get_active_tab` and `browser_read_page` only if justified).
4. The correct bridge lifecycle and IPC mechanism for separate Windows processes.
5. Minimal file change list and dependency list (prefer zero new npm dependencies).
6. Policy version migration design preserving v1/v2 tasks.
7. Threat model and consent state machine.
8. Unit, integration, negative, crash/retry, lease-heartbeat, and regression tests.
9. Potential implementation blockers or flaws in the proposed design.
10. A recommendation whether to implement as one cohesive change set or staged commits while keeping one final release boundary.

Distinguish VERIFIED SOURCE FACTS from PLATFORM FACTS and ASSUMPTIONS. Do not claim tests passed. Do not modify the bundle or any project source.

# Feasibility Brief: Connecting the UTA Task Tracker to a Chat App (Slack / Teams / Discord / Mattermost)

## Context

The unit currently uses **TeamApp** (teamapp.com) for pictures, text updates, and
file hosting, and is considering moving to another platform. The question: if we
moved to **Slack** (or similar), could it "talk" to the **Squadron Task Tracker**
web app — push notifications out of the tracker, and create/act on tasks from
chat? This brief answers feasibility, compares platforms, and lays out the real
limitations. **No code is written in this session** — the deliverable is this
brief (to be saved into the repo as `CHAT-INTEGRATION-FEASIBILITY.md` for the
briefing).

**Bottom line up front:** Yes — both directions are very doable, and the tracker
is already well-shaped for it. The integration work is nearly the *same shape* on
all four platforms. The real deciding factor is **data governance** (real member
PII/medical data in a commercial SaaS chat tool), not technical difficulty.

---

## 1. Why the tracker is well-positioned for this

From the codebase (`server.js`, `schema.sql`):

- **Clean REST API** — every action is already an endpoint (create task, bulk
  squadron task, shop item, mark done, flag). `server.js:201` (`POST /api/tasks`),
  `server.js:242` (`POST /api/squadron/tasks`), `server.js:380` (`POST /api/shop/events`),
  `server.js:169` (`PUT /api/tasks/:id` status), `server.js:317` (flag).
- **Clear roles** — `member < supervisor < leadership` enforced by `requireRole`
  (`server.js:73`). A chat integration can reuse this exact hierarchy.
- **Already publicly hosted** over HTTPS (Railway, Postgres). Chat platforms need a
  public URL to send slash commands/buttons to — we already have one. No new infra
  for the inbound (notifications) half at all.
- **Zero existing third-party integrations** — clean slate, nothing to conflict with.
- **Notifications are already on the roadmap** — `DEMO-BRIEFING.md` lists
  "Notifications (email + in-app) — *designed, ready to build.*" A chat app is just
  the *delivery channel* for that already-planned feature.
- An **`email` column exists on `members`** (`schema.sql:34`) but is currently
  unused — useful later as the key to match a member to their chat account.

---

## 2. How the two directions actually work (any platform)

**Direction A — Notifications OUT (tracker → chat).** *The easy half.*
The tracker makes an outbound HTTPS POST to a chat "incoming webhook" URL whenever
something happens. Add a few lines after the existing DB inserts:
- Task assigned to a member → DM/notify them.
- Task flagged → ping the member.
- Leadership pushes a squadron/shop task → announce in a channel.
- "Next month's tasks are live" + weekly **completion digest** to supervisors —
  these need a **scheduler** (a cron/scheduled job), which the app doesn't have
  today but Railway supports. This is the only new moving part for Direction A.

**Direction B — Create / act FROM chat (chat → tracker).** *More work, still standard.*
- **Slash commands** (e.g. `/task add @member "Finish CBTs" this_uta`) or
  **buttons/menus** ("Mark done", "Flag") post to a *new* endpoint on our server.
- That endpoint **verifies the request is really from the chat platform** (a
  signing-secret check), figures out *which member* the chat user is, checks their
  role, and calls the same internal logic the web app already uses.
- Interactive buttons (mark a task done straight from a notification) use the
  platform's "interactive components" (Slack Block Kit, Teams Adaptive Cards,
  Discord components). Very doable; this is where most of the build effort lives.

---

## 3. Platform comparison

All four can do **both** directions (inbound webhooks + slash commands + bot +
interactive buttons). Differences that matter for *this unit*:

| Platform | Integration story | Chat / file fit vs TeamApp | Cost | **Data governance (ANG/PII)** |
|---|---|---|---|---|
| **Slack** | Best-in-class, easiest dev experience. Incoming webhooks, slash commands, Block Kit buttons/modals, great docs. | Great chat + photos. **Free tier keeps only ~90 days of message/file history** — weak as a file *archive* (TeamApp's hosting role). | Free tier OK to start; paid per-user for full history. | ⚠️ Commercial SaaS, data hosted by Slack. PII/CUI in a non‑approved tool is the core concern. |
| **MS Teams** | Solid but heavier (Bot Framework, Adaptive Cards). Note: Microsoft is retiring legacy "Office 365 Connectors" in favor of **Power Automate Workflows** for inbound webhooks. | Good chat; files live in **SharePoint/OneDrive** with real storage/retention. | **Likely already licensed** via government M365. | ✅ Best for compliance *if* the unit is on GCC/GCC‑High M365 — data stays in the existing approved tenant. Custom app/bot needs **base/wing IT (comm squadron) approval**. |
| **Discord** | Very easy (webhooks, bots, slash commands, buttons). | Great chat + photos, generous free file sharing. | Free, generous. | ❌ Consumer/gaming platform — not appropriate for official unit data; no compliance posture. Fine only for unofficial/social use. |
| **Mattermost** | Open‑source Slack‑alike: incoming/outgoing webhooks, slash commands, bot accounts, interactive messages. | Slack‑like chat; **you control file storage/retention**. | Free if self‑hosted (you run the server); paid cloud option. | ✅ **Self‑hostable → you control data residency.** Has DoD pedigree (used within DoD / Platform One). Strongest for keeping PII under unit/gov control, at the cost of running & maintaining a server. |

**Reading of the table for a Guard squadron handling real member data:**
- **Technically**, Slack is the nicest to build against and the fastest to a demo.
- **For official use with real PII/medical data**, the realistic answers are
  **MS Teams** (probably already approved and paid for — data stays in the M365
  tenant) or **self‑hosted Mattermost** (you own the data). Both integrate fine.
- **Discord** is out for official data.

---

## 4. Limitations & gotchas (read this before committing)

1. **🚩 The big one — data governance / OPSEC.** The tracker holds **real member
   PII and medical appointment data** (`tasks.appt_*`, member roster). Pushing that
   into a commercial SaaS chat tool (Slack/Discord) may conflict with DoD/USAF
   policy on CUI/PII handling and approved tools. **Recommend: before pushing any
   real data anywhere, check with the wing communications squadron / ISSM / cyber
   (IA) office.** This is a bigger gate than any code. It also nudges the platform
   choice toward Teams (approved tenant) or self‑hosted Mattermost.

2. **Identity mapping.** Members log in by `slug`; chat actions arrive with a chat
   user ID. We must map *chat user → member* to attribute actions and enforce
   roles. Cleanest approach: add a `slack_user_id` (or generic `chat_user_id`)
   column and match on the existing `email` field (`members.email`) the first time
   a user links. Until a member is linked, the bot can't act as them.

3. **Auth model mismatch (manageable).** The web app is **session‑cookie** based
   (`requireAuth`/`requireRole` read `req.session`). Chat→app calls won't carry a
   cookie — they're trusted via the platform's **signing secret**, then the server
   resolves the member and role *from the DB*. So Direction B needs a small
   parallel auth path (verify signature → look up member → check role) that reuses
   the existing task logic. Not hard, but it's net‑new code, not a config toggle.

4. **No scheduler today.** Event‑driven notifications (task assigned/flagged) are
   easy — just fire after the DB insert. But "tasks are live" announcements and
   periodic **digests** need a scheduled job (Railway cron). New moving part to
   stand up and monitor.

5. **Free‑tier retention.** If chat also replaces TeamApp's **file hosting**, note
   Slack free only keeps ~90 days of history/files. Teams (SharePoint) and
   self‑hosted Mattermost don't have that limit. Photos/updates are fine on any.

6. **Ownership & bus factor.** Someone has to create and **own the bot/app, rotate
   tokens/secrets, and keep it running.** For a Guard unit with turnover, decide who
   maintains it before depending on it.

7. **Workspace admin needed.** Installing a custom app/bot requires admin on the
   chat workspace/tenant — straightforward on Slack/Discord/your own Mattermost,
   but a **gated approval** on a government M365/Teams tenant.

---

## 5. A pragmatic path (if the unit decides to proceed)

This is deliberately phased so value lands early and risk stays low:

1. **Governance check first** — confirm with comm/IA what tool is allowed for this
   data. That answer likely picks the platform for you.
2. **Phase 1 — Notifications OUT** (lowest effort, highest immediate value, no new
   auth): wire task‑assigned / flagged / squadron‑push events to a single channel
   or DMs via an incoming webhook. This is the already‑roadmapped notifications
   feature with chat as the channel.
3. **Phase 2 — Scheduled digests** ("tasks are live", weekly supervisor digest) via
   a Railway cron job.
4. **Phase 3 — Act FROM chat** (slash commands + "Mark done"/"Flag" buttons), which
   requires the chat‑user↔member mapping and signature‑verified endpoints.
5. **Phase 4 (optional)** — chat‑based login/SSO for the web app.

Each phase is independently useful and shippable; you can stop after Phase 1 and
still have gotten most of the everyday benefit.

---

## 6. Talking points for the briefing

- "Yes, the tracker can talk to a chat app — both notify us *and* let us add/close
  tasks from chat. The app's already built like an API, so it's ready for it."
- "The hard part isn't the code — it's **which chat tool we're allowed to put real
  member data into.** That's a comm‑squadron/IA question, and it probably decides
  Slack vs. Teams vs. self‑hosted."
- "If we're staying inside our **M365/Teams** tenant, integration is the
  compliance‑friendly option because the data never leaves an approved system.
  **Slack** is the easiest to build and demo. **Mattermost** lets us self‑host and
  own the data. **Discord** is fine for social, not for official member data."
- "We'd roll it out in phases — **notifications first** (quick win, already on our
  roadmap), then **acting from chat** later."

---

## Verification / next step

This brief is informational; the only action on approval is to **save it into the
repo** as `CHAT-INTEGRATION-FEASIBILITY.md` and commit/push to
`claude/briefing-doc-review-QOH3t`, so it's alongside `DEMO-BRIEFING.md` for the
briefing. No application code changes, no dependencies, nothing deployed.

If you later choose to build Phase 1, the natural starting points in the code are:
`server.js:201` and `server.js:242` (fire a notification right after the task
insert) and a new `CHAT_WEBHOOK_URL` env var — but that's a separate session.

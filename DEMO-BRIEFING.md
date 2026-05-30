# Squadron Task Tracker — Leadership Demo & Briefing Guide

**App:** 108th CES UTA Task Tracker
**Audience:** Squadron leadership & supervisors
**Presenter notes + live demo script — keep this open during the brief.**

---

## 1. What this is (and why it matters)

The UTA Task Tracker is a single web dashboard that replaces the scattered
paper checklists, hallway reminders, and email chains we use to chase down
UTA tasks. Everyone logs into the same app and sees exactly what's relevant
to their level:

- **Members** see their own to-do list for the drill.
- **Supervisors** see their whole shop's progress in one place.
- **Leadership** sees the entire squadron's readiness at a glance.

The payoff: real-time visibility into who's done what, fewer surprises on
drill weekend, and one source of truth instead of a dozen spreadsheets.

---

## 2. Before you walk in — logistics checklist

- [ ] App is running and reachable from the brief room (browser open, logged out).
- [ ] Database is seeded with the demo squadron data.
- [ ] Projector / screen share tested and readable from the back row.
- [ ] These three demo logins written on a card (see below).
- [ ] A phone or tablet on hand to show the mobile view.
- [ ] Browser zoom bumped up a notch so the room can read it.

**Demo logins** (password is the same as the username for the seeded data):

| Role        | Username     | Who they are        |
|-------------|--------------|---------------------|
| Member      | `becerra`    | SrA Becerra         |
| Supervisor  | `ebbert`     | TSgt Ebbert         |
| Leadership  | `gablin`     | SMSgt Gablin        |

> Backups if needed: members `glenn`, `mesa`; supervisor `uzoma`;
> leadership `mcnaughton`.

---

## 3. The three views at a glance (the 30-second mental model)

| View          | Who sees it             | Headline feature                                  |
|---------------|-------------------------|---------------------------------------------------|
| **My Tasks**  | Everyone                | Your personal task list + completion gauge        |
| **My Shop**   | Supervisors & leadership| Your shop's progress + assign/manage tasks        |
| **Squadron**  | Leadership (org chart: all) | Whole-squadron readiness rollup               |

You switch views from the **left sidebar** on a computer, or the **bottom
nav bar** on a phone. The view someone gets is tied to their role — a member
simply doesn't have the Shop and Squadron tools.

---

## 4. Feature summary (what each screen does)

### My Tasks — every member
- **Completion gauge** showing percent complete, plus **Done / Remaining /
  Flagged** counts — the member knows instantly where they stand.
- **Task list** the member works down. Tap a checkbox to mark a task
  **done**, **partial**, or **not started**, and add a **note** for context.
- Each task has an **urgency**: *Overdue*, *This UTA*, *Next UTA*, *Future*,
  or *Info* — so the most pressing items stand out. Tasks can also carry an
  **appointment day/time/location** (e.g., a PT test or medical walk-in).
- **Flagged tasks** are highlighted — that's how a supervisor pulls a
  member's attention to something specific.
- **Timeline tab** — the squadron's UTA schedule (Friday/Saturday/Sunday):
  formations, briefings, training, medical, etc.
- **Work Orders tab** — the shop's work-order items.

*Why it matters: every Airman shows up knowing their own requirements without
being chased.*

### My Shop — supervisors & leadership
- **Shop completion gauge** plus **On Track vs Behind** counts.
- **Member Progress** chart across everyone in the shop.
- **Shop Schedule** — schedule items, work orders, and emphasis items for the drill.
- **Member roster** — tap any member to expand and see their tasks.
- Supervisors can **Add Task** (assign it to a specific member) and
  **Add Shop Item** (schedule / work order / emphasis) right from this screen,
  and can **flag** a task.

*Why it matters: a supervisor manages the whole shop's readiness from one
screen and can act on it immediately.*

### Squadron — leadership
- **Chain of Command** org chart (this part is visible to everyone).
- **Completion by Shop** chart and a squadron-wide completion gauge.
- **Critical This UTA** and **Total Members** headline stats.
- **Squadron by Category** breakdown (e.g., admin vs medical).
- **Members Most Behind** — a prioritized list of who needs attention.
- **All Shops** — tap any shop to drill into its members.

*Why it matters: leadership sees squadron readiness in seconds and knows
exactly where to apply pressure.*

### Nice touches to mention
- **Dark/light theme toggle**.
- **Mobile-friendly** — works on a phone with a bottom nav bar.
- **Badges** on the nav show outstanding counts at a glance.

---

## 5. Navigation walkthrough (how to move around)

1. **Log in** with username + password.
2. **Switch views** from the left sidebar (computer) or bottom bar (phone):
   *My Tasks → My Shop → Squadron*.
3. Inside **My Tasks**, use the sub-tabs: *My Tasks / Timeline / Work Orders*.
4. In **My Shop** and **Squadron**, **tap a member or a shop to expand** it.
5. **Theme toggle** is in the sidebar (sun/moon icon).
6. **Log out** from the user area to switch accounts during the demo.

---

## 6. Live demo script (the spine of the briefing)

> Tell a story by logging in as each role in turn. Narrate the "why" as you click.

**Act 1 — The Member (login: `becerra`)**
1. Land on **My Tasks**. Point at the **gauge** — "this is what every Airman
   sees the moment they log in."
2. **Check off a task** — watch the gauge and Done/Remaining counts update live.
3. **Add a note** to a task — show how context travels with the task.
4. Point out an **Overdue** item and how urgency makes it jump out.
5. Click the **Timeline** tab — "and here's the whole drill schedule, same
   for everyone."
6. **Log out.**

**Act 2 — The Supervisor (login: `ebbert`)**
7. Open **My Shop**. Point at the **shop gauge** and **On Track vs Behind**.
8. Show the **Member Progress** chart — "I can see my whole shop at once."
9. **Tap a member** to expand their tasks.
10. **Add a Task** and assign it to a member — "this is how I push a
    requirement down."
11. **Add a Shop Item** (a schedule entry or emphasis item).
12. **Flag a task** to highlight it for the member.
13. **Log out.**

**Act 3 — Leadership (login: `gablin`)**
14. Open **Squadron**. Walk the **Completion by Shop** chart and the
    squadron gauge.
15. Show **Members Most Behind** — "this is my call list."
16. Show **Squadron by Category** — where the squadron is lagging.
17. Show the **Chain of Command** org chart.
18. **Tap a shop** in All Shops to drill into its members.

**Closer**
19. Pull out your **phone**, show the same app with the bottom nav.
20. Hit the **theme toggle** for a quick visual flourish, then wrap.

---

## 7. Talking points & value pitch

- **Real-time UTA readiness** — no more "where are we?" on Saturday morning.
- **Accountability** — every task has an owner, a state, and a note.
- **Less drill-day chaos** — schedule, work orders, and tasks all in one place.
- **Right info to the right person** — role-based access; members only see and
  change their own data, supervisors their shop, leadership the squadron.
- **Mobile-friendly** — Airmen can check it from their phone.
- **One source of truth** — replaces paper and email chains.

---

## 8. Anticipated questions (be ready)

- **How do members get accounts / passwords?** Accounts are pre-loaded; each
  starts with an initial password that must be changed before go-live.
- **Can members see each other's tasks?** No — members only see their own.
  Shop and squadron views are restricted to supervisors and leadership.
- **Who can add or change tasks?** Supervisors and leadership add/assign/flag;
  members update the status of their own tasks.
- **Where does the data live?** In a central database behind the app; everyone's
  changes show up for the appropriate viewers in real time.
- **What happens each UTA?** Tasks and schedules are organized by UTA cycle, so
  each drill gets its own clean slate while history is retained.
- **Does it work on a phone?** Yes — responsive layout with a bottom nav bar.

---

## 9. Dry-run checklist (do this once the day before)

- [ ] Log in as `becerra`, `ebbert`, and `gablin` — confirm each lands on the
      right view.
- [ ] Confirm the member has tasks (including an Overdue one) so the gauge demo lands.
- [ ] Confirm the shop has multiple members so Member Progress looks real.
- [ ] Confirm the squadron rollup shows several shops and a "most behind" list.
- [ ] Walk the full Act 1 → Act 2 → Act 3 click-path once, start to finish.
- [ ] Check the app on your phone.

# Squadron Task Tracker — Leadership Briefing & Walkthrough Guide

**App:** 108th CES UTA Task Tracker
**Audience:** Squadron leadership & supervisors
**Status:** **Live** — every squadron member has an account and real UTA data is in the system.
**Presenter notes + walkthrough script — keep this open during the brief.**

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

**The app is now live with the full squadron** — all members are loaded and
working their real UTA tasks. This guide is for briefing the unit on what it
does and how to use it.

---

## 2. Before you walk in — logistics checklist

- [ ] App is running and reachable from the brief room (browser open, logged out).
- [ ] You can log in with **your own account** (leadership login shows all three views).
- [ ] Projector / screen share tested and readable from the back row.
- [ ] A phone or tablet on hand to show the mobile view.
- [ ] Browser zoom bumped up a notch so the room can read it.
- [ ] Heads-up: the screen shows **real member data** — fine for an internal
      brief, but be mindful if anyone outside the unit is in the room.

**Accounts:** the app is live, so everyone uses their **own** username and
password — there are no demo logins. A **leadership** account is the best one
to brief from because it can see all three views (My Tasks, My Shop, and
Squadron) from a single login. To show the plain member experience, either
use your own **My Tasks** tab or have a volunteer in the room pull it up on
their phone.

---

## 3. The three views at a glance (the 30-second mental model)

| View          | Who sees it             | Headline feature                                  |
|---------------|-------------------------|---------------------------------------------------|
| **My Tasks**  | Everyone                | Your personal task list + completion gauge        |
| **My Shop**   | Supervisors & leadership| Your shop's progress + assign/manage tasks (leaders can switch shops) |
| **Squadron**  | Leadership (org chart: all) | Whole-squadron rollup + push tasks unit-wide  |

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
- Two sub-tabs (pills) under the gauge: **Shop** and **Shop Schedule**.
  - **Shop** — the **member roster**; tap any member to expand and see their tasks.
  - **Shop Schedule** — schedule items, work orders, and emphasis items for the drill.
- **Shop switcher (NEW)** — leadership who oversee more than one shop (a flight
  chief, or squadron-level leadership) get a **"Viewing shop" dropdown** below
  the gauge to switch which shop they're looking at. A flight chief sees the
  shops in their flight; squadron leadership can page through every shop. A
  supervisor with a single shop doesn't see the dropdown — it only appears when
  there's more than one shop to switch between.
- Supervisors can **Add Task** (assign it to a specific member) and
  **Add Shop Item** (schedule / work order / emphasis) right from this screen,
  and can **flag** a task.

*Why it matters: a supervisor manages the whole shop's readiness from one
screen and can act on it immediately — and a flight chief can hop shop-to-shop
without leaving the view.*

### Squadron — leadership
- **Chain of Command** org chart (this part is visible to everyone).
- **Completion by Shop** chart and a squadron-wide completion gauge.
- **Critical This UTA** and **Total Members** headline stats.
- **Squadron by Category** breakdown (e.g., admin vs medical).
- **Members Most Behind** — a prioritized list of who needs attention.
- **All Shops** — tap any shop to drill into its members.
- **Add Task (NEW)** — leadership can push a single task to **every member of
  a specific shop** or to the **entire squadron** at once. Pick the target,
  fill in the task (category, title, optional details, urgency, and optional
  appointment day/time/location), and it lands in each member's My Tasks list,
  where they track it just like any other task.

*Why it matters: leadership sees squadron readiness in seconds, knows exactly
where to apply pressure — and can put a requirement in front of everyone who
needs it without going shop by shop.*

### Nice touches to mention
- **Dark/light theme toggle**.
- **Mobile-friendly** — works on a phone with a bottom nav bar.
- **Badges** on the nav show outstanding counts at a glance.

---

### Task Builder (`/build`) — how McNaughton actually builds the month, now (NEW)
This is the biggest change since the app went live: MSgt McNaughton no longer hands off an Excel workbook for someone else to import. He logs in with his own leadership account, goes to `/build`, and builds the cycle himself, in the browser, start to finish.

**The monthly rhythm:**
1. **Start a new cycle** — a fresh draft, invisible to members until it's published.
2. **Copy last cycle forward** — the recurring tasks (CBTs, standing requirements, etc.) show up as a pickable list; he ticks the ones still relevant and copies them into the new cycle in one move. Appointment-specific details (day/time/location) don't carry over, since those change every month.
3. **Add what's new** — tap the members a new task applies to, set its urgency, and save. He can add several different tasks with different urgency levels in the same pass.
4. **Review** — a live preview of what each member's list will look like before anything goes out.
5. **Go live** — one click. The new cycle becomes the one every member sees; the old cycle is archived (not deleted — it's kept as a permanent record); members get notified their tasks are live.

**Mid-month changes** work the same way, against the cycle that's already live — no separate script, no re-running an import that would wipe out everyone's progress. And every add is undoable: if he adds a task by mistake, "Undo" removes it — with a warning if anyone's already checked it off, so nobody's real progress gets erased by accident.

*Why it matters: the tool that used to be his biggest recurring workload — assembling a spreadsheet and handing it to someone to import — is now something he does himself, in minutes, with no risk of wiping out the squadron's progress on an in-progress cycle.*

### Records (`/records`) — the historical view (NEW)
A read-only leadership tool for looking back. Browse members (grouped by shop, searchable — supervisors see their own shop, leadership sees everyone), pick a member, and see every past UTA cycle they've had tasks in, newest first, with a done/total summary. Drill into any cycle to see the actual tasks, what was marked done, and any notes the member left.

Past cycles are frozen the moment a new one goes live — nobody can edit history after the fact, so what Records shows is a faithful record of exactly where that member stood at the end of that month.

*Why it matters: instead of "I think Airman X finished their CBTs a couple months back," leadership can pull up the actual record in seconds — useful for EPBs, promotion packages, or just settling a "did I do that" question.*

---

## 5. Navigation walkthrough (how to move around)

1. **Log in** with username + password.
2. **Switch views** from the left sidebar (computer) or bottom bar (phone):
   *My Tasks → My Shop → Squadron*.
3. Inside **My Tasks**, use the sub-tabs: *My Tasks / Timeline / Work Orders*.
4. Inside **My Shop**, use the pills *Shop / Shop Schedule*; if you oversee more
   than one shop, the **"Viewing shop" dropdown** below the gauge switches shops.
5. In **My Shop** and **Squadron**, **tap a member or a shop to expand** it.
6. **Theme toggle** is in the sidebar (sun/moon icon).
7. **Log out** from the user area when you're done.

---

## 6. Walkthrough script (the spine of the briefing)

> Brief from your own **leadership** login — it can show all three views.
> Walk the room from the member's-eye view up to the squadron rollup, narrating
> the "why" as you click.

**Act 1 — The Member's view (your My Tasks tab)**
1. Land on **My Tasks**. Point at the **gauge** — "this is what every Airman
   sees the moment they log in."
2. **Check off a task** — watch the gauge and Done/Remaining counts update live.
3. **Add a note** to a task — show how context travels with the task.
4. Point out an **Overdue** item and how urgency makes it jump out.
5. Click the **Timeline** tab — "and here's the whole drill schedule, same
   for everyone." *(Optional: have a member in the room show their own My Tasks
   on a phone for an authentic look.)*

**Act 2 — The Supervisor's view (My Shop tab)**
6. Open **My Shop**. Point at the **shop gauge** and **On Track vs Behind**.
7. Show the **Member Progress** chart — "a supervisor sees the whole shop at once."
8. On the **Shop** pill, **tap a member** to expand their tasks; then flip to the
   **Shop Schedule** pill to show the drill's schedule, work orders, and emphasis items.
9. *(Leadership only)* Use the **"Viewing shop" dropdown** to switch to another
   shop — "as a flight chief I can check any shop in my flight from right here."
10. **Add a Task** assigned to a single member — "this is how a supervisor pushes
    a requirement down."
11. **Add a Shop Item** (a schedule entry or emphasis item) and **flag a task**
    to highlight it for the member.

**Act 3 — Leadership view (Squadron tab)**
12. Open **Squadron**. Walk the **Completion by Shop** chart and the squadron gauge.
13. Show **Members Most Behind** — "this is my call list."
14. Show **Squadron by Category** — where the squadron is lagging.
15. Show the **Chain of Command** org chart.
16. **Tap a shop** in All Shops to drill into its members.
17. **Add Task:** click **Add Task**, choose **Entire Squadron**
    (or a single shop), and push a requirement out to everyone at once — "one
    click and it's in every affected member's list."

**Closer**
18. Pull out your **phone**, show the same app with the bottom nav.
19. Hit the **theme toggle** for a quick visual flourish, then wrap.

---

## 7. Talking points & value pitch

- **Real-time UTA readiness** — no more "where are we?" on Saturday morning.
- **Run "how-goes-it" off the live app, not slide decks** — pull up the Squadron
  view in the meeting and see every member's progress at a glance. No more each
  shop reading off its own slide; the numbers are live, consistent, and already
  drilled down to the member level.
- **Push a task to everyone in one move** — leadership can drop a requirement on
  a whole shop or the entire squadron at once, instead of going shop by shop.
- **Accountability** — every task has an owner, a state, and a note.
- **Less drill-day chaos** — schedule, work orders, and tasks all in one place.
- **Right info to the right person** — role-based access; members only see and
  change their own data, supervisors their shop, leadership the squadron.
- **Mobile-friendly** — Airmen can check it from their phone.
- **One source of truth** — replaces paper and email chains.

---

## 8. Anticipated questions (be ready)

- **Can members see each other's tasks?** No — members only see their own.
  Shop and squadron views are restricted to supervisors and leadership.
- **Who can add or change tasks?** Supervisors and leadership add/assign/flag;
  members update the status of their own tasks. Only **leadership** can push a
  task to a whole shop or the entire squadron at once.
- **If leadership pushes a task to the squadron, what does each member get?**
  Their own copy of the task in My Tasks — each member checks it off and adds
  notes independently; one person completing it doesn't clear it for anyone else.
- **Where does the data live?** In a central database behind the app; everyone's
  changes show up for the appropriate viewers in real time.
- **What happens each UTA?** Tasks and schedules are organized by UTA cycle, so
  each drill gets its own clean slate while history is retained.
- **Does it work on a phone?** Yes — responsive layout with a bottom nav bar.
- **What if someone forgets their password?** Accounts are managed centrally;
  loop in the app admin to reset it.

---

## 9. Dry-run checklist (do this once the day before)

- [ ] Log in with your own leadership account and confirm you land correctly and
      can reach all three views (My Tasks, My Shop, Squadron).
- [ ] Confirm My Tasks shows real tasks (including an Overdue one) so the gauge
      demo lands.
- [ ] Confirm your shop shows multiple members so Member Progress looks real,
      and that the **Shop / Shop Schedule** pills both load.
- [ ] If you oversee more than one shop, confirm the **"Viewing shop" dropdown**
      appears and switches the shop you're looking at.
- [ ] Confirm the squadron rollup shows several shops and a "most behind" list.
- [ ] Open **Squadron → Add Task**, confirm the target dropdown lists "Entire
      Squadron" and every shop. *(Only run a real push if you actually intend to
      assign the task — it goes to live members.)*
- [ ] Walk the full Act 1 → Act 2 → Act 3 click-path once, start to finish.
- [ ] Check the app on your phone.

---

## 10. Roadmap — future feature ideas

Where we're looking to take the app next (good to mention if the room asks
"what's coming"):

- **Notifications (email + in-app)** — *designed, ready to build.* Members get
  notified when next month's tasks go live and when a task is assigned mid-UTA;
  supervisors/leadership get a periodic digest of completions in their shop.
- **Attendance** — track UTA attendance alongside tasks.
- **Add events to calendar** — export/sync schedule and appointment items to a
  personal calendar.
- **PT calculator** — built-in fitness score calculator.
- **Promotion requirements / tracker** — track each member's promotion
  eligibility and remaining requirements.

*These are ideas on the board, not commitments — priority and timing TBD.*

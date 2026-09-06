# VISION — Parking Bay Detection

> **Point a camera at any yard. Know, at a glance, which bays are free — all day, every day.**

---

## The problem we solve

Every depot, warehouse, and distribution yard runs on one deceptively simple question:

**"Which bay can I send this truck to?"**

Today, answering it is surprisingly manual. Yard staff look out windows, walk the dock, or work the radio:

> "Is bay 3 clear?" — "Hang on, I'll check." — "No, someone's still in it." — "What about 5?" — "Can't see from here."

This happens dozens of times a day. Each check costs a few minutes of someone's attention, and the answer is out of date the moment it's spoken. The downstream cost is invisible but constant:

- **Trucks idle and queue** while drivers wait for a confirmed slot — burning driver hours and fuel.
- **Turnarounds stretch** because nobody notices a bay freed up ten minutes ago.
- **Errors compound**: a truck is waved toward an occupied bay, has to maneuver out, and the whole rank backs up.
- **Nobody can settle disputes.** How long was that carrier actually sitting in bay 2? Without a record, the answer is whoever remembers best.
- **Managers manage by walking.** The people who could be improving the yard are spending their day being its eyes.

Yards don't have a detection problem. They have a **visibility problem** — and everyone on site pays a visibility tax, every hour of every shift.

## Who we serve

### The yard controller (primary user)
The person coordinating trucks on the ground. Their day is a stream of small decisions: which bay, which truck, who moves first. Today their information comes from memory, radios, and line of sight. We give them a single live picture of their yard — every bay, its state, and how long it's been that way — so decisions take seconds instead of phone calls.

### The operations lead (buyer)
Accountable for throughput and dwell times across the site. They don't watch the yard live; they need to know it's flowing and to spot patterns: Which bays turn around fastest? Where do trucks linger? We turn the yard's constant motion into facts they can act on — without anyone filling in a spreadsheet.

### The driver (indirect beneficiary)
Never touches our product, but feels it most. Less waiting for a slot, fewer re-positioning maneuvers, a clearer handoff at the gate. Their time in the yard shrinks from "however long it takes to sort out" to "however long unloading takes."

## What changes for the user

### Before
- Ask, walk, or squint to find a free bay — and the answer goes stale immediately.
- Occupancy lives only in people's heads; when someone goes on break, the knowledge goes with them.
- Problems (blocked bays, overstaying trucks) are discovered late, by accident.
- Performance conversations about turnaround times run on anecdotes.

### After
- **The yard answers itself.** A glance — at a screen, a tablet in the office, a phone on the dock — shows every bay: free or occupied, and since when.
- **The state of the yard has a memory.** How long each truck has been parked, when bays turned over, what happened overnight. Yesterday's shift is a timeline, not a guess.
- **The yard flags its own problems.** A bay blocked for too long, a truck dwelling past its window — surfaced to the right person, without anyone noticing it first.
- **Everyone works from the same truth.** The controller, the office, and the manager see the same yard state at the same time.

## What the product is

**A live occupancy layer for any bay-based yard.** One camera (or a few) pointed at the dock. Bays defined once, by the site itself — drawn on a frame, not programmed. From then on, the product quietly does one thing: it keeps an accurate, continuous answer to *which bays are free, and for how long* — and shares that answer with everyone who needs it.

Three product rules define it:

1. **Glanceable.** The state of the yard must be readable in under five seconds, from across the room or from the dock. If a user has to interpret, we've failed.
2. **Trustworthy.** A yard controller who sees one wrong bay state will ignore the product forever. Accuracy in the states we show matters more than the number of features we show. When the system can't be confident, it says so rather than guessing.
3. **The yard's, not ours.** Each site defines its own bays and layout — on day one, in minutes, without specialists. Nothing about a yard requires retraining, re-labeling, or a vendor visit. The system adapts to the yard; the yard never adapts to the system.

## A day in the life

**7:00 — Shift start.** The yard controller opens the dashboard over coffee. Overnight activity is summarized: every arrival, every turnover. Nothing needs chasing; the two carriers that overstayed are already flagged.

**10:15 — Busy mid-morning.** A truck checks in at the gate. Instead of radioing the dock, the controller glances at the board: bay 2 free for 6 minutes, bay 3 occupied for 40. Truck goes to bay 2. Total elapsed time to a confident answer: about four seconds.

**13:40 — The exception.** The system flags that bay 1 has been occupied for twice its usual dwell. The controller checks the timeline — the carrier's driver went to lunch. One conversation, with facts, instead of an argument from memory.

**16:00 — Weekly review.** The operations lead looks at the week: bay turnaround times by carrier, idle minutes at the gate trending down since the dashboard went live. The case for a fifth bay writes itself.

## Where we're going

The product matures in three deliberate stages, each building user trust before adding scope:

1. **Live occupancy (now).** A real-time picture of the yard: bays, state, and confidence. Proven today in a simulated yard that lets us refine the experience end-to-end before pointing cameras at real ones.
2. **A yard with memory.** Occupancy history and dwell times, per bay and per carrier. Shift timelines, simple alerts for the things a controller should never miss (blocked bays, overstays). The product stops being a window and becomes a record.
3. **Operations insight.** Across bays, shifts, and eventually sites: turnaround patterns, bottleneck bays, carrier comparisons. The yard stops being merely visible and becomes measurable — and improvable.

The through-line at every stage: **we sell minutes back to people** — fewer radio calls, fewer walks across the tarmac, fewer trucks idling for a slot, fewer arguments without evidence. The yard keeps doing what it does; we make sure everyone can see it doing it.

## What we will not become

- **A camera or hardware company.** We work with the cameras a site already has.
- **A security product.** We watch bays, not people. Occupancy and dwell — not identity, not surveillance.
- **A full yard-management system.** We are the visibility layer that makes whatever system the site already runs *better informed*. We integrate; we don't replace.
- **A system that needs a data scientist on site.** If a competent yard manager can't set it up and trust it alone, it's not done.

## The one-sentence version

**For yard teams drowning in "is bay 3 free?" radio calls, we make the yard continuously visible to itself — so every truck goes to the right bay, the first time, and everyone can prove how long anything took.**

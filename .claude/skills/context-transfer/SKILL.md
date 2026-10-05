---
name: context-transfer
description: Package everything important from the current conversation into one copy-paste text block so a brand-new chat can continue seamlessly with no other context. Use when the user asks for a context transfer, handoff, summary for a new chat/thread, "package this conversation", or says the chat is getting long and they want to move to a new one.
---

# Context Transfer

You are an expert at context summary. Your sole job is to package all key information from the conversation thread so the user can paste it into a new thread and continue without missing anything.

## Output rules

- Respond with **one single text block** (one fenced code block) that the user can copy and paste. Nothing important may live outside it; at most one short line before it.
- The new chat will have **no prior context except this block**. Write it so a fresh assistant can pick up immediately: define names, roles, and abbreviations the first time they appear, and never say "as discussed" or "the thing above".
- Be granular. Prefer exact values over paraphrase: IDs, commit hashes, file paths, URLs, numbers, dates and times (with time zone), names, prices, settings, quoted wording the user approved.
- Separate **verified facts** from **estimates, assumptions and open questions**, and label which is which.
- Never include secrets (API keys, passwords, tokens). If one matters, say where it is stored (e.g. "in Netlify env vars"), not its value.
- Use plain text with simple headings and dashes so it pastes cleanly anywhere.

## Required sections, in this order

1. **Goals, task, key decisions and reasoning**
   - The overall goal and the current task.
   - Every decision made, with the reasoning behind it and who approved it.
   - Standing rules, constraints and preferences the user set (what must or must not happen, approval gates, tone/style preferences, "never do X" rules), quoted verbatim where wording matters.

2. **Progress update**
   - Finished (and how it was verified).
   - In progress (exact current state).
   - Not started / paused / on hold (and why, and what unblocks it).

3. **Every important file, link, name, figure and detail**
   - Files and paths, repos and branches, commits, deploy IDs, URLs, database/project IDs, scheduled jobs and their times.
   - People and their roles; product, feature and character names.
   - Key numbers: costs, measurements, baselines, projections, limits.

4. **Where we left off and next steps**
   - The last thing the user asked and the last thing that was done.
   - The exact next steps in order, including anything waiting on the user and anything scheduled.

5. **Other key details**
   - Gotchas, past mistakes and how they were fixed, environment limitations, rollback plans, anything that would trip up someone continuing the work.
   - How the user likes to be communicated with.

## Before you output

Re-read the conversation start to finish and check: could a stranger continue this exact work, at this exact point, using only the block? If any decision, number, ID, or pending approval would be lost, add it.

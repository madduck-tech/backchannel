# ADR 0009: Positioning — share protection, not stealth

Date: 2026-09-01
Status: accepted

## Context

An overlay excluded from screen sharing (§9), the reactive "what should I answer" question (§8) and the word
"interview" in the example agents read from the outside as a tool for cheating in interviews. The spec
distinguishes share protection from stealth, but the outside audience reads the README. Project Raven and NexQ
openly position themselves as invisible interview copilots; the market tolerates it, but both carry a trail
of cheating accusations.

## Decision

1. **The README gets a "what this is and what it is not" paragraph:** a copilot for the user's own meetings;
   share protection exists so notes do not leak when the screen is shared; it is neither invisibility nor a tool
   for passing someone else's interview.
2. **Terminology.** Only "share protection" in the UI and docs. The words "stealth", "undetectable" and "invisible"
   are not used. This is also technically honest: on Linux there is no protection (ADR 0005), and on other OSes
   it is not absolute.
3. **Example agents** are named from the user's side. "Java Interviewer" is the interviewer's side and stays.
   "Interview Copilot" and the like do not appear in examples or demos.
4. **Demos and screenshots** show an architecture meeting or a sales call, not an interview.
5. Product functionality is not restricted: "what should I answer" stays, as the spec requires.

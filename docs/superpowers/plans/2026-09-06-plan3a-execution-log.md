# SDD ledger — plan: tasks/todo.md (Plan 3a — Price Parsing)
Task 1: complete (commit 6af4ad5) — fare parser, 217 tests. Plan-supplied parser was verified by the controller against all 12 of its own test cases BEFORE handover (L004); all passed.
Task 1b: complete (commit a1e66e5) — CONTROLLER-FOUND: the non-car strip destroyed a valid car rate in 133 of 332 unknowns. Two patterns: a parenthetical aside inside the car clause, and a motorcycle clause after an ideographic comma.
  Implementer's insight beat the controller's: the ideographic comma is disambiguated SEMANTICALLY (has a rate already been quoted?) rather than by widening a separator set. 小型車、大型重型機車：40元/時 = shared subjects, keep; 小型車30元/時、機車10元/時 = new clause, strip.
  Controller-verified against a pre-fix worktree: 81.04% -> 87.61%, 115 recovered, 0 lost, 0 re-valued, 0 implausible. 223 tests.
Task 2: complete (commit 933f6f5) — price in lots.json, 226 tests.
Task 3: complete (commit 1b289a6) — coverage guards at priced>=0.85 / unknown<=0.15, 230 tests.
REAL ARTIFACT (1,089 published lots, not the 1,756 metadata lots): exact 78.4%, range 17.1%, entry 1.9%, unknown 2.6% — 97.4% priced. Active car parks have well-formed fare text; the unparseable tail is mostly inactive lots.
  over the wire 29 KB -> 33 KB gzipped; unknowns carry no numbers; stamps still agree with the grid header.
  NOTE: a controller check for shipped fare prose was a FALSE POSITIVE — one lot is NAMED 九穹大廈計時收費停車場. Only a,c,i,id,n,p,t,x,y are emitted.

=== PLAN 3a FINAL REVIEW: 1 Critical, 3 Important, 4 Minor. Blocking ones fixed. 250 tests. ===
  C1 an EV-charging surcharge was read as the tariff. TPE0007 (live, in the roster) shipped NT$10-20 for a NT$40 lot: the real rates are written bare (40元(08-22)) so _HOURLY missed them, while every 加收 surcharge clause carries 元/時 and won. Fixed by blanking surcharge clauses, then recovering the tariff from the bare NN元(HH-HH) window form. Now ships range(20,40).
  I3 comma-grouped rates shipped their last three digits (1,200元/時 -> 200). Fixed.
  I2 the clause-open test only looked at the character immediately before the vehicle noun, so 惟機車/其中機車 defeated it. IMPLEMENTER OVERRODE THE CONTROLLER'S PRESCRIBED RULE and was right: the controller's version could not satisfy two of the four required rows. Shipped the structural inverse instead.
  M5 汽車 added as a car noun; M6 entry tiers now span like hourly ones.
  5 lots changed value, each justified. Coverage 87.61% -> 87.66%. Zero implausible.
PARKED: motorcycle/bus-only lots (TPE1490, TPE0736, TPE0784, TPE0820, TPE1050, TPE1091, TPE1395) publish a non-car rate as the car price. RULING: an upstream ROSTER problem - a 機車 lot should not be on a car map. Plan 3b.
PARKED: the lots.json schema version was not bumped for the additive p key. RULING: additive, no client exists yet.

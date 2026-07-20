---
name: test-driven-development
description: Red-green-refactor discipline for every change - write the failing test first, watch it fail for the right reason, make it pass minimally, then clean up.
---

# Test-driven development

Use this skill whenever you are about to change behavior: a bug fix, a new
function, a changed contract. The test comes first - it is the executable
form of the requirement, and it is your proof that the change works.

## The loop

1. **RED - write one failing test.** Exactly one. It describes the behavior
   you are about to build, named after the behavior, not the method
   ("resumeDropsOrphanedToolCalls", not "testResume2"). Run it and WATCH IT
   FAIL. Then read the failure:

   - Failing assertion with the expected/actual you predicted: good, go on.
   - Compile error, missing fixture, wrong exception: the test is broken,
     not the code. Fix the test until it fails for the RIGHT reason.
   - Test passes immediately: the behavior already exists or the test is
     vacuous. Either way, stop and rethink before writing any code.

2. **GREEN - make it pass, minimally.** Write the least code that turns the
   test green. Resist generalizing ("while I'm here...") - unrequested
   generality is untested generality. Run the test again; green means the
   requirement is met, nothing more.

3. **REFACTOR - clean up under a green bar.** Now improve names, extract
   duplication, simplify. After every step, re-run the tests. If a
   refactoring turns the bar red, undo it - do not "fix" tests to match
   accidentally changed behavior.

## Verification rules

- **Never trust a test you have not seen fail.** A test that was born green
  proves nothing.
- **Run the whole suite before declaring done**, not just the new test.
  The bug you introduced is usually in the file you did not look at.
- **No network, no API keys in tests.** Fake the boundary instead: a
  scripted provider, a local mock HTTP server, a fixed clock. If the test
  needs credentials to run, it will be skipped by everyone forever.
- **One behavior per test.** Three assertions about one outcome are fine;
  three behaviors in one test hide which one broke.
- **Report honestly.** "Done" means: new tests written, seen red, now
  green, full suite green. If any part of that is not true, say exactly
  which part.

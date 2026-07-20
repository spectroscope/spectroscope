---
name: verification
description: Evidence before claims - run it, read the output, and only then say whether it works. A tester changes nothing and reports what actually happened.
---

# Verification

Use this skill when your task is to CHECK something: does the build pass,
does the feature behave, does the claim in a commit message hold. Your value
is an honest, reproducible answer - not a fix (change nothing) and not
optimism.

## The iron rule

Never claim a state you have not observed in THIS run. "Should work",
"probably passes", "looks correct" are banned words. Every claim in your
report cites its evidence: the command you ran, the exact output line, the
file and line you read.

## The flow

1. **Identify the claims to verify.** Split the task into checkable
   statements ("tests pass", "endpoint returns the model", "file X exists").
2. **Pick the cheapest sufficient probe for each**: run the test suite,
   curl the endpoint, read the file, run the binary with --help. Prefer
   commands whose output proves the point on its own.
3. **Run and READ.** Copy the deciding lines into your notes verbatim.
   An exit code alone is weak evidence - pair it with output.
4. **Diverge loudly.** If reality contradicts the claim, that is your
   finding - report exactly what differed, with the evidence. Do not fix
   it, do not soften it.
5. **Report**: one verdict per claim (VERIFIED / FAILED / UNVERIFIABLE +
   why), each with its evidence. End with the overall verdict in one line.

## Report while you work

Call report_status after each claim is settled ("2/4 verified, running
build next"). One short sentence each.

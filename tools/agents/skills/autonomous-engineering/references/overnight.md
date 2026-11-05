## Morning report

Run `ae report PLAN` for a morning report, or `ae report PLAN --json` for JSON.
The report reads recorded states, evidence, failures, blockers, and work attempts from the journal.
It reads commits reachable from HEAD with an exact `AE-Slice: PLAN#N` trailer.
The goal is a plan label. The period runs from journal creation to its last recorded update.
Attempts are grouped by recorded provider, model, and effort. Missing labels appear as `unknown`.
The report includes the journal path and redacts secrets from all output strings.
It takes no lock and changes no journal or plan bytes. It does not sync plan changes or recheck evidence freshness.
A VERIFIED state is the journal's recorded result. Worker completion remains a claim.
Unavailable Git history is reported explicitly. A backup journal is identified when used.

### Testing basics

- Before changing code, name the check that will prove the change works. Run it as soon as the first slice works, not only at the end.
- For a bug, reproduce the failure first with a test or a recorded command. Fix the cause, then show the same check passing.
- For a refactor, record the current behavior first. Change one bounded part, then confirm the behavior is unchanged.
- Test the behavior that users and callers depend on. Avoid tests that only mirror the implementation line by line.
- When a change crosses a real boundary, such as a database, file system, network contract, or command-line interface, exercise that boundary in a controlled environment. Use mocks only where they do not hide the behavior under test.
- Isolate tests from real user state. Use temporary directories and test data, and never write to real configuration or production data from a test.
- Keep tests deterministic. Control time, randomness, and ordering. Do not depend on external services that can change between runs.
- Do not delete, skip, or loosen a failing test to make a change pass. If a test is wrong, explain why and fix it as a separate, visible step.
- Treat an unexpected failure as information. Find the cause before retrying or changing the assertion.
- Scale testing to risk. A wording change may need only inspection. A data migration, permission check, or integration needs evidence from the real path.
- Report results exactly: which checks ran, which passed, which failed, and which were not run. Never claim a check passed without running it.

This is an original synthesis for Uma's harness, not a reproduction of a book or article.
## Simplicity and ownership
Understand the problem and take responsibility for results. An abstraction must repay its maintenance cost today. Keep domain rules in one authoritative place rather than repeating the same knowledge across layers. Prefer components that can change independently, with clear boundaries and direct control flow.
## Tracer bullets
Prove one small path through the system before expanding. Choose the slice that exposes an important integration assumption early. Production tracer code is intended to evolve and needs appropriate quality; a prototype is disposable and answers a focused question.
Example: before building all expense endpoints, save one expense from an actual input path, retrieve it, and display it. Check persistence rather than only mocking the database. Then add the next behavior.
## Requirements, design, and review
Agree on the user outcome and success criteria. For significant work, sketch the system interactions and the types, responsibilities, or call flow that could otherwise be misunderstood. Review these choices early. A passing test suite does not prove that architecture remains easy to maintain.
## Proportional verification
Reproduce bugs and verify the fix. For an integration, exercise the real boundary in a controlled environment. For a small text change, an inspection may suffice. Use observed failures to improve coverage rather than collecting tests that merely mirror implementation.
## Sources
- David Thomas and Andrew Hunt, The Pragmatic Programmer; publisher's principles: [https://assets3.pragprog.com/tips/](https://assets3.pragprog.com/tips/)
- Matt Pocock, Tracer Bullets: [https://www.aihero.dev/tracer-bullets](https://www.aihero.dev/tracer-bullets)
- HumanLayer, Why Software Factories Fail: [https://github.com/humanlayer/advanced-context-engineering-for-coding-agents/blob/main/wsff.md](https://github.com/humanlayer/advanced-context-engineering-for-coding-agents/blob/main/wsff.md)

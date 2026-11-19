# Skill reference

`tools/agents/skills/<name>/SKILL.md` is the source for names, descriptions, and invocation rules.
Run `npm run harness -- skills catalog --check` to check this reference and both generated blocks.
Run `npm run harness -- skills catalog --write` to regenerate the README and explainer blocks after updating this reference.
`skills catalog` without a flag checks only; differences exit 1 and name the affected file and skill.
The command uses the repo root (`--root DIR` when supplied); it does not install skills.

Status describes maturity, not proof that a skill follows its instructions in every session.

## autonomous-engineering
Group: Execution
Status: beta
Needs: Node 24 or later, Git, an approved multi-agent-planning plan, and user-granted authority; T3 delegation is optional.
Example: Ask the agent to execute an approved plan autonomously; the engine records state and evidence for each slice.
Result: Slices reach VERIFIED from observed checks, ACCEPTED after manual sign-off, or stop with a recorded reason. The engine refuses unsafe commands.

## continue-work
Group: Execution
Status: beta
Needs: The project's prior plan or handoff, the real checkout, and access to its checks.
Example: Invoke /continue-work in a fresh session to reconstruct the prior trail and compare it with the repository.
Result: A resume point, check results, mismatches, and a proposed next step. It stops before changes until the user confirms.

## grill-me
Group: Planning
Status: stable
Needs: A request whose goals, constraints, or decisions need clarification, and a user who can answer essential questions.
Example: Ask the agent to grill you about a feature before building it.
Result: Settled first-slice decisions and requirements with evals in a plan or product contract. It waits for contract approval before building.

## html-explainer
Group: Communication
Status: stable
Needs: A plan, audit, review, report, comparison, or nontrivial build; the page builder needs python3 and shasum.
Example: Ask for a plan; edit plans/<slug>.md, build it with the shared md-view.sh, and check freshness.
Result: A source Markdown page and generated HTML view with progress, evidence, decisions, and unknowns. Without the builder, it writes Markdown and reports the skipped build.

## make-it-verifiable
Group: Quality
Status: beta
Needs: A named change, access to the real artifact, and test or sandbox accounts where needed.
Example: Invoke /make-it-verifiable <change> to plan the checks before code, then say go to authorize the build.
Result: A check plan, then pass, fail, or unknown results with evidence after approval, plus a prompt for an independent second opinion.

## multi-agent-planning
Group: Planning
Status: stable
Needs: A software task, repository context, settled essential decisions, and host capabilities when routing agents.
Example: Ask for a plan with verified slices, each assigned an owner, reviewer, model, effort, and acceptance check.
Result: A plan page, dependency graph, safe waves, and self-contained handoffs. It plans only until execution is requested.

## render-rules
Group: Platform
Status: stable
Needs: A Render deployment, deploy failure, or render.yaml file to inspect.
Example: Ask the agent to check render.yaml before a Render deployment.
Result: Guidance on port binding, storage, service limits, Linux paths, secrets, health checks, regions, and Blueprint configuration. It does not itself deploy a service.

## subagent-budget
Group: Planning
Status: stable
Needs: The proposed child tasks and the host's model and effort controls, before any children start.
Example: Ask the agent to budget a fan-out before launching research workers.
Result: A bounded child count and explicit model and effort choices under the skill's current launch rules, with one-child escalation after a failed check.

## thread-continuity
Group: Execution
Status: experimental
Needs: T3 Code, Node 24 or later, Git, an approved handoff row, and readable approval provenance. This tracer is not installed; read it by path.
Example: Explicitly name thread-continuity for an approved task handoff to one fresh T3 thread.
Result: Handoff records and checker evidence for matching checkout and approval fields, with one successor writer. A reviewer must confirm recorded fields against T3; the checker cannot prove their authorship.

## verify
Group: Quality
Status: beta
Needs: A built product, its plans/<product>.contract.md, a fresh independent session, and access to the contract's eval methods.
Example: Invoke /verify in a session that did not build the product.
Result: A verification report with coverage, deviations, gaps, and unknowns. It changes no product code or eval definitions and fixes no findings.

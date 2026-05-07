# AGENTS.md

> **Note:** This file delegates to a central AGENTS.md. Read and apply it before proceeding.

**URL:**
https://raw.githubusercontent.com/camunda/.github/refs/heads/main/AGENTS.md

Treat the central file's contents as if they were written directly in this file.
Instructions below extend those guidelines and take precedence if there is any conflict.

## Repo-specific instructions

### No silent failure

We avoid silent failure in implementations. **Guaranteed correctness or exception by default.**

If a function cannot honour its contract — invariant violated, input outside the documented domain, upstream returned something unrecognised, ambiguity that cannot be resolved deterministically — it must raise. Do not return `undefined`, an empty object, a partially populated result, a default value, or a best-guess fallback to keep the pipeline moving. A silent miss in a bundler propagates downstream as a wrong type, a missing field, or a broken generator output, and the defect surfaces far away from its cause.

Concretely:

- prefer throwing over returning `null` / `undefined` / `{}` for "I couldn't do this".
- never `catch` an error only to swallow it. If a `catch` is genuinely required (e.g. an optional probe), log at warn or higher with enough context to diagnose, and re-throw or record the failure in the result so callers can see it.
- when a heuristic is ambiguous, fail loudly rather than picking a candidate. Disambiguation logic must be explicit about "exactly one match" semantics; multiple-match or zero-match must surface, not silently degrade.
- guards and validators should reject early with an actionable message that names the offending input and the expected shape.
- tests must assert the throw, not just the absence of a returned value.

### Commit message guidelines

We use Conventional Commits (enforced by commitlint, see `commitlint.config.cjs`).

Format:

```
<type>(optional scope): <subject>

<body>

BREAKING CHANGE: <explanation>
```

Allowed type values (common set):

```
feat
fix
chore
docs
style
refactor
test
ci
build
perf
```

Rules:

- Use imperative mood ("add support", not "added support").
- Lowercase subject (except proper nouns). No PascalCase subjects.
- Keep subject concise; body can include details, rationale, links.
- Prefix breaking changes with `BREAKING CHANGE:` either in body or footer.

#### Review-comment fix-ups

Commits that address PR review comments must use the `chore` type (e.g. `chore:` or `chore(<scope>):`), **not** the `fix` type.
`fix` commits trigger a patch release and a CHANGELOG entry via semantic-release — review iterations are not user-facing bug fixes.

```
# Correct
chore: address review comments — tighten ambiguous-ref guard

# Wrong — will pollute the CHANGELOG
fix: address review comments — tighten ambiguous-ref guard
```

### Build pipeline

#### Always-green policy

Before every AI-assisted session, verify the baseline is green:

```bash
npm run build && npm test
```

Warnings are fatal. Do not suppress a warning to make a build pass.
Do not treat any failure as pre-existing or unrelated without explicit confirmation from the engineer.

```bash
# Verify baseline -> always green (always run before an AI-assisted session)
npm run build && npm test

# Fast inner loop while iterating
npm test

# Full pipeline before committing
npm run build && npm test
```

Never skip the type-check / build before pushing. `npm run lint` runs `tsc --noEmit` and must pass.

### Refactoring discipline

- **red/green refactor for new behaviour and bug fixes** — write the failing test first, then the minimal production change that makes it pass. The test serves two roles simultaneously: it encodes the acceptance criteria for the change, and it becomes a permanent regression guard. Writing the test first proves it can actually detect the defect or the missing behaviour; if a test passes before the production change lands, it isn't guarding anything. For bug fixes, scope the test to the defect *class*, not just the instance, so the same category of bug can't recur in a sibling code path.
- behaviour tests are the regression guard — during behaviour-preserving refactors, do not modify behaviour tests. If a test fails, the production code is usually wrong, not the test. If a change intentionally modifies observable behaviour (for example bundle output, CLI flags, or the metadata schema), update the affected behaviour tests and explicitly document and justify the intended behaviour change in the PR.
- between refactors, always run `npm run build && npm test` to verify correctness.

#### There are no flaky tests

We do not acknowledge the existence of "flaky tests". A test that passes sometimes and fails other times is reporting one of two things:

1. **A test defect** — the test contains a race, an unbounded timeout, an order-of-operation assumption, an unsynchronised readiness signal, or a dependency on wall-clock timing. Fix the test so its outcome is deterministic for the behaviour it claims to assert.
2. **A product defect** — the production code has a race, a missed signal, an unhandled error path, or a resource it leaks under load. Fix the product.

Either way, an intermittent failure is a real defect that must be diagnosed and fixed before the change merges. Do not retry the CI job, mark the test `skip`, add a `.retry()`, or describe the failure as "flaky" or "unrelated" in the PR description. "Re-run and hope" is a coping strategy, not engineering.

When triaging an intermittent CI failure:

- Reproduce locally if possible (loops, resource pressure, timeout reduction). If you cannot reproduce, reason from first principles about what *could* differ between local and CI (load, filesystem semantics, signal delivery latency, parallel test interaction).
- Identify the specific race or assumption.
- Pick category 1 vs category 2 explicitly in the fix commit message, and explain which signal the test was previously relying on and which deterministic signal it now relies on.
- If timeouts must be generous to absorb runner load, the timeout is a safety net — not a correctness signal. State this in a comment so future maintainers don't tighten it back into a race.

#### Coverage analysis before a behaviour-preserving refactor

Before starting any non-trivial refactor, **audit whether the surface you are about to change is sufficiently guarded**. A passing test suite is necessary but not sufficient — it only proves that *what is currently tested* still works. The risk of a refactor is the behaviour that nobody asserts.

Produce a short coverage table in the planning step that maps each behaviour you intend to preserve to the test that locks it in. For each row, ask:

- Does an existing test fail if this behaviour changes? If not, the behaviour is unguarded.
- Is the test scoped to the defect *class* (e.g. "all ambiguous inline schemas resolve deterministically or throw") or only to one instance? Class-scoped guards are durable; instance-scoped guards rot.

For every gap, **write the missing guard test first, on the pre-refactor branch**, and prove it passes against the current implementation. This is the **green/green discipline**:

1. **Green on the pre-refactor code** — proves the test encodes preserved behaviour, not aspirational behaviour.
2. **Green on the refactored code** — proves the refactor preserved it.

Land the guard tests in a separate PR off `main`, and merge that PR to `main` before the refactor PR merges. A guard test that lands together with the change it is supposed to guard is weaker — there is no recorded moment at which it passed against the old code, so reviewers cannot tell whether it would have caught a regression.

If you find that the surface is genuinely unguardable without a major investment, record that gap in the PR description and shrink the refactor scope rather than proceeding without a net.

### Terminal commands

- when running terminal commands through an AI agent or other automation tool, avoid heredocs (`<< EOF`) because they don't work reliably in zsh on macOS.
- when using an AI agent or automation tooling, prefer its native file-editing capabilities for creating or modifying files.
- for appending single lines from the shell in those workflows, `echo` or `printf` is fine: `echo "content" >> file.txt`.

# Z.ai Code Review — GitLab MR port

**Date:** 2026-06-16
**Source:** https://github.com/tarmojussila/zai-code-review (GitHub Action, MIT, ~211 LOC)
**Goal:** Port to GitLab CI for AI review of Merge Requests.

## Decisions

- **Comments:** single summary MR note (mirror original), updated in place each push.
- **Packaging:** both — Docker image + CI template (`include:`) referencing the image.
- **Runtime:** keep Node.js, reuse original logic ~1:1.
- **Target:** gitlab.com + self-hosted, via `CI_API_V4_URL` (zero config).

## Architecture

Zero runtime dependencies. Drop `@actions/core` and `@actions/github`; replace with
`process.env` reads and node built-in `https`. No `node_modules`, no `ncc` bundling.
Single `src/index.js`.

### Reused verbatim from original
- `matchesPattern(filename, pattern)` — glob → regex matcher.
- `filterFiles(files, excludePatterns)`.
- `buildPrompt(files, maxDiffChars)`.
- `callZaiApi(apiKey, model, systemPrompt, prompt)` — `https` POST to
  `https://api.z.ai/api/coding/paas/v4/chat/completions`.

### Rewritten (GitHub → GitLab)
| Original | Port |
|---|---|
| `core.getInput()` | `process.env.X` (+ trim/defaults) |
| `core.setFailed`/`core.info` | `console.error`+`process.exit(1)` / `console.log` |
| `github.context` owner/repo/PR# | `CI_PROJECT_ID`, `CI_MERGE_REQUEST_IID`, `CI_API_V4_URL` |
| octokit `pulls.listFiles` | `GET /projects/:id/merge_requests/:iid/diffs` (paginated) |
| octokit `issues.listComments` | `GET .../notes?per_page=100` (paginated) |
| octokit `issues.updateComment` | `PUT .../notes/:note_id` |
| octokit `issues.createComment` | `POST .../notes` |

New helper `gitlabRequest(method, path, body)` — `https` wrapper; base URL from
`CI_API_V4_URL`; auth header `PRIVATE-TOKEN: <GITLAB_TOKEN>`; JSON parse; pagination
via `?per_page=100&page=N`.

### Diff field mapping
GitLab `/diffs` returns objects `{old_path, new_path, diff, new_file, deleted_file,
renamed_file}`. Map to the shape the reused functions expect:
- `filename` = `new_path`
- `patch` = `diff` (same unified-hunk format as GitHub `patch`)
- `status` = `new_file`→`added`, `deleted_file`→`removed`, `renamed_file`→`renamed`, else `modified`

## Auth (security-critical)
- `GITLAB_TOKEN` = Project/Group Access Token **or** PAT, scope `api`, role ≥ Developer.
  Stored as a **masked** CI/CD variable.
- `CI_JOB_TOKEN` does NOT work for posting MR notes — documented in README.

## Trigger
CI rule `$CI_PIPELINE_SOURCE == "merge_request_event"`. Requires MR pipelines enabled.
If no `CI_MERGE_REQUEST_IID` present → log + exit 0 (not a failure).

## Inputs (same names as original)
`ZAI_API_KEY` (req), `ZAI_MODEL` (`glm-4.7`), `ZAI_SYSTEM_PROMPT`, `ZAI_REVIEWER_NAME`
(`Z.ai Code Review`), `EXCLUDE_PATTERNS` (`*.lock,package-lock.json,yarn.lock,pnpm-lock.yaml`),
`MAX_DIFF_CHARS` (`0`), `GITLAB_TOKEN` (req).

## Files
```
src/index.js                  ported, zero-dep
Dockerfile                    FROM node:20-alpine, copy src → /app
templates/zai-code-review.yml CI template consumers include
examples/.gitlab-ci.yml       consumer usage example
package.json                  metadata, no runtime deps
test/unit.test.js             node:test for pure fns
README.md
LICENSE                       MIT
```

## Packaging
CI template references published image:
```yaml
zai-code-review:
  image: <registry>/zai-gitlab:latest
  rules:
    - if: '$CI_PIPELINE_SOURCE == "merge_request_event"'
  script:
    - node /app/src/index.js
```

## Testing
- Unit: `matchesPattern`, `filterFiles`, `buildPrompt`, status-mapping — node built-in
  `node:test` + `assert`, no deps.
- Integration: real MR on a throwaway GitLab project, documented in README (manual).

## Out of scope (YAGNI)
- Inline diff-position comments.
- Retry/backoff on z.ai 5xx.
- Multi-note splitting for huge reviews (rely on `MAX_DIFF_CHARS`).

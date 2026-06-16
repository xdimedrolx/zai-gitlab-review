# zai-gitlab-review

AI-powered code review for **GitLab Merge Requests** using [Z.ai](https://z.ai) (GLM) models.
A GitLab CI port of [tarmojussila/zai-code-review](https://github.com/tarmojussila/zai-code-review)
(GitHub Action).

On every MR pipeline it fetches the MR diff, sends it to Z.ai, and posts the review as a
single MR note — updated in place on each push.

- **Zero runtime dependencies** (node built-ins only).
- Works on **gitlab.com and self-hosted** (reads the API base from `CI_API_V4_URL`).

## Setup

### 1. Docker image (published automatically)

The image is built and pushed to **GHCR** by GitHub Actions
([.github/workflows/docker-publish.yml](.github/workflows/docker-publish.yml)) on every push
to `main` and on version tags. No manual build needed:

```
ghcr.io/xdimedrolx/zai-gitlab-review:latest
```

**Make the package public** so GitLab runners can pull it without authentication:
GitHub repo → Packages → `zai-gitlab-review` → Package settings → Change visibility → Public.
(If you must keep it private, add a `docker login ghcr.io` step in the GitLab job using a CI
variable holding a GitHub token with `read:packages`.)

To cut a versioned image, push a tag: `git tag v0.1.0 && git push --tags`.

### 2. Add CI/CD variables (in the consuming project)

Settings → CI/CD → Variables, both **masked**:

| Variable | Value |
|---|---|
| `ZAI_API_KEY` | Your Z.ai API key |
| `GITLAB_TOKEN` | Project/Group Access Token or PAT, scope `api`, role ≥ Developer |

> ⚠️ **`CI_JOB_TOKEN` will not work** — it cannot create MR notes via the API. You must
> supply a real access token.

### 3. Enable merge request pipelines

Settings → Merge requests → ensure MR pipelines are enabled. The job runs only when
`$CI_PIPELINE_SOURCE == "merge_request_event"`.

### 4. Include the template

The repo is on GitHub, so include it by remote raw URL (GitLab `include: project:` only works
for GitLab-hosted repos). In the consuming project's `.gitlab-ci.yml` — see
[examples/.gitlab-ci.yml](examples/.gitlab-ci.yml):

```yaml
include:
  - remote: 'https://raw.githubusercontent.com/xdimedrolx/zai-gitlab-review/main/templates/zai-code-review.yml'
```

(Alternatively, copy the ~10-line job from the template straight into your `.gitlab-ci.yml`.)

## Inputs

Set as CI/CD variables. Defaults match the original action.

| Variable | Required | Default |
|---|---|---|
| `ZAI_API_KEY` | yes | — |
| `GITLAB_TOKEN` | yes | — |
| `ZAI_MODEL` | no | `glm-5.2` |
| `ZAI_SYSTEM_PROMPT` | no | "You are an expert code reviewer…" |
| `ZAI_REVIEWER_NAME` | no | `Z.ai Code Review` |
| `EXCLUDE_PATTERNS` | no | `*.lock,package-lock.json,yarn.lock,pnpm-lock.yaml` |
| `MAX_DIFF_CHARS` | no | `0` (unlimited) |

`CI_API_V4_URL`, `CI_PROJECT_ID`, `CI_MERGE_REQUEST_IID` are provided automatically by
GitLab CI.

## How it differs from the GitHub original

- Replaces `@actions/*` + octokit with direct GitLab REST calls (`/merge_requests/:iid/diffs`
  and `/notes`).
- Distributed as a Docker image + CI template instead of a GitHub Action.
- Single summary note only (no inline diff-position comments — same as the original).

## Local development

```sh
npm test          # node:test unit tests for the pure functions
```

### Manual integration test

1. Create a throwaway GitLab project, push a branch, open an MR.
2. Set `ZAI_API_KEY` and `GITLAB_TOKEN` masked variables.
3. Add the `include:` and push a commit to the MR branch.
4. Confirm a "Z.ai Code Review" note appears and updates on the next push.

## License

MIT — see [LICENSE](LICENSE).

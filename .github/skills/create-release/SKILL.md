---
name: create-release
description: Cut and publish a Lemonade Stand release by following docs/RELEASING.md - bump the version in package.json, write releases/vX.Y.Z.md, run the release gate (check-release, typecheck, audit, tests), merge the release/X.Y branch into main through a PR, then tag vX.Y.Z and push the tag to trigger the Release workflow. Also covers hotfix/patch releases and resuming an interrupted release. Use when asked to create, cut, ship, publish, tag or trigger a release or hotfix, bump the version, or prepare release notes. It does not watch the pipeline.
---

# Create a Lemonade Stand release

Does in one pass what [docs/RELEASING.md](../../../docs/RELEASING.md) describes. If this skill and that guide disagree, follow the guide and tell the user.

**Flow:** preflight → version → branch → bump → notes → validate → confirm → commit → push + PR + merge → tag `main` → push tag → check the pipeline started → report.

**Finish line:** tag `vX.Y.Z` is on `origin` and a Release workflow run has started. Do not wait for that run to finish.

Placeholders: `X.Y.Z` = target version, `vPREV` = previous release tag, `<branch>` = `release/X.Y`. Commands are PowerShell; `git`, `npm` and `gh` behave the same in any shell.

## Why the rules exist

Pushing a `v*` tag runs `.github/workflows/release.yml`. Its `gate` job (`scripts/check-release.mjs <tag>` + typecheck) and `audit` job (`npm audit --audit-level=high`) must pass before `build` (Windows, macOS, Linux) and `release` (GitHub Release whose body is `releases/<tag>.md`) run. A failure after tagging means deleting and re-pushing the tag, so reproduce `gate` and `audit` locally first (Step 5).

## Invariants

- `package.json` `version` = `X.Y.Z`, tag = `vX.Y.Z`, notes file = `releases/vX.Y.Z.md` (non-empty). The gate fails if any of the three drift.
- The tag points at a commit that already contains the bump and the notes: tag `main` after the PR is merged (hotfix: tag `release/X.Y`). Never tag an unmerged or unpushed commit.
- Lightweight tag (`git tag vX.Y.Z`, like every existing tag), pushed on its own and never in the same `git push` as a branch (release.yml warns a combined push may not trigger the workflow).
- PRs are merged with a merge commit (`gh pr merge --merge`). Release branches are never deleted (hotfixes branch from them).

## Safety rules

Never do these unless the user explicitly asks: force-push; delete, move or recreate a tag; `gh pr merge --admin`; `--no-verify`; `npm audit fix --force`; push straight to `main`; skip or work around a failing check; commit `.env`, `config/*.local.json`, `conversations/`, `memory.jsonl`, or anything that looks like a secret. Ask once (Step 6) before the first remote write.

## Inputs

The user may give `X.Y.Z`, a bump keyword (`patch`, `minor`, `major`), neither, and/or `prepare-only` (do Steps 0-7, push nothing, report).

- If the user only wants one part (for example "write the release notes" or "bump the version"), do just that step and stop.
- A patch of an already-released line (`Z > 0`) is a hotfix: follow [references/hotfix.md](references/hotfix.md) (`.github/skills/create-release/references/hotfix.md`) instead of this procedure.

## Step 0 - Preflight (read-only, run as one block)

```powershell
git fetch origin --tags --prune
git status --short --branch
$v = node -p "require('./package.json').version"
"package.json version : $v"
"latest release tags  : " + ((git tag --list 'v*' --sort=-v:refname | Select-Object -First 3) -join ', ')
"notes file exists    : " + (Test-Path "releases/v$v.md")
"tag v$v on origin    : " + [bool](git ls-remote --tags origin "refs/tags/v$v")
gh auth status
```

Take `vPREV` from the version-sorted tag list. Do **not** use `git describe`: release tags sit on `main`'s merge commits, which are usually not ancestors of the release branch.

| Finding | Action |
| --- | --- |
| `gh auth status` fails | Stop. Ask the user to run `gh auth login` (needs `repo` and `workflow` scopes). |
| Tag for the `package.json` version is already on `origin` | The release is already tagged. See **Resuming**. Never re-tag. |
| Branch is `main` or not `release/X.Y` | Step 2. |
| Remote branch exists (`git ls-remote --heads origin <branch>` prints a line) but local has no upstream, or `git rev-list --left-right --count 'HEAD...origin/<branch>'` reports remote-only commits (second number above 0) | Integrate first: `git pull --no-rebase --no-edit origin <branch>` (merge; `--no-edit` keeps git from opening an editor; never rebase or force-push). Conflicts, or git refusing because of local changes: stop and ask. Re-run Step 5 afterwards. |
| Branch is not on `origin` yet | Fine. Step 8 creates it (do not run `rev-list` against a missing remote branch; it errors). |
| `fetch` rejects a tag ("would clobber existing tag") | Local and remote tags differ. Stop and ask; never `--force`. |

## Step 1 - Decide the version

| You were given | Target version |
| --- | --- |
| `X.Y.Z` | That version. |
| `patch`, `minor` or `major` | Bump the **latest release tag** (not `package.json`, which may already be bumped). |
| Nothing, and `package.json` is greater than the latest tag with no tag of its own yet | The `package.json` version. The bump is already done. |
| Nothing, on `release/X.Y` | `X.Y.0`, if greater than the latest tag. |
| Anything else | Ask. Recommend `minor` if the commits since `vPREV` add features, `patch` if they only fix. |

Stop and ask when the target: is not valid semver; is not greater than the latest tag; already exists as a tag locally (`git tag --list vX.Y.Z`) or on `origin`; has `Z > 0` (hotfix flow); has a pre-release suffix (the pipeline would publish it as a normal release); or has a `MAJOR.MINOR` that doesn't match `release/MAJOR.MINOR`.

## Step 2 - Be on the release branch

A release is cut from `release/<MAJOR>.<MINOR>`. If you are on it, continue. Otherwise ask before switching, and never switch over uncommitted changes without asking.

- Branch exists (`git branch --list release/X.Y`, `git ls-remote --heads origin release/X.Y`): `git checkout release/X.Y`.
- Branch does not exist: offer to create it from an up-to-date `main`, as in RELEASING.md "Starting work on a new sprint": `git checkout main`, `git pull --ff-only`, `git checkout -b release/X.Y`, `git push --set-upstream origin release/X.Y`.

## Step 3 - Bump the version

```powershell
npm version X.Y.Z --no-git-tag-version
```

Skip if `package.json` already says `X.Y.Z` (npm fails with "Version not changed"). Always pass `--no-git-tag-version`: the tag is created later, on `main`. This also updates `package-lock.json`. Check `git diff package.json package-lock.json`: only the version lines (plus intended dependency changes) should differ.

## Step 4 - Write the release notes (`releases/vX.Y.Z.md`)

The file becomes the GitHub Release body verbatim, so write for users of the app.

- File already exists, is non-empty and has no template placeholders: **keep it**. It is the user's text. Only fix a wrong title or date.
- Otherwise run `Copy-Item releases/TEMPLATE.md releases/vX.Y.Z.md`, then fill it in with the file-edit tool (UTF-8, LF; never `>` redirection).
- Layout: `# vX.Y.Z`, `_Release date: YYYY-MM-DD_` (today), a one or two sentence summary, then `## Added`, `## Changed`, `## Fixed`, `## Known issues` (and `## Security` when fixing advisories). Delete sections with nothing to say (v0.10.1 has only "Fix").
- One bullet per user-visible change: a **bold name**, then what it does and why it matters; sub-bullets for detail. Link issues or PRs (`[#28](https://github.com/siavashhub/lemonade-stand/issues/28)`) when commits reference them.
- Gather facts with `git log --oneline --no-merges vPREV..HEAD`, `git diff --stat vPREV..HEAD`, and `git diff --stat` for uncommitted work. Read the key diffs and the docs the sprint touched.
- Classify by what changed, not by commit prefix: `add:` is used for nearly everything here, even "add: new release". Skip tests, CI, refactors and the release commit itself. Merge dependency bumps into a single bullet.
- Never invent changes or "Known issues", and never leave template text. If the evidence is thin, say less.
- Style references: [releases/v0.12.0.md](../../../releases/v0.12.0.md) (full release) and [releases/v0.10.1.md](../../../releases/v0.10.1.md) (hotfix).

## Step 5 - Validate (the pipeline's gate and audit, plus what PR CI runs)

```powershell
node scripts/check-release.mjs vX.Y.Z   # exactly what the pipeline gate runs
npm run typecheck                       # the gate runs this too
npm run audit                           # the pipeline's audit job; fails on high/critical
npm test                                # what PR CI runs
Select-String -Path releases/vX.Y.Z.md -Pattern '\{VERSION\}|\{YYYY-MM-DD\}|New features\.|Behaviour changes\.|Bug fixes\.|Anything users should be aware of\.'   # must print nothing
```

All four commands take seconds. Run `npm ci` first only if `node_modules` is missing or dependencies changed.

- Any failure: stop. Do not commit or tag. Show the failing output and the fix options (see **If something fails**).
- Optional packaging smoke test (`npm run package:win`, `package:mac` or `package:linux`, takes minutes): only when the user asks, or when `git diff --name-only vPREV..HEAD -- electron-builder.yml electron.vite.config.ts scripts resources` lists files or Electron/electron-builder were bumped. Offer it; don't run it silently.

## Step 6 - Confirm once

Show a compact plan and ask for the go-ahead (use the ask-user tool if you have one, then wait for the answer). Offer **Release now**, **Prepare only (commit locally, push nothing)** and **Cancel**. Include:

- version, tag, branch, and the first lines of the notes file;
- commits since `vPREV` (count and the top few);
- uncommitted files that would be committed, split into release files and everything else, flagging anything unexpected;
- validation results;
- the remote actions: push the branch, open and merge the PR into `main`, tag and push `vX.Y.Z` (publishes a public GitHub Release once the pipeline finishes).

Skip the question only when the user's request explicitly pre-approves the release (for example "go ahead" or "don't ask"). If the set of files to commit changes, re-run Step 5.

## Step 7 - Commit

1. Other pending changes (approved in Step 6) ship in the release, so commit them first in their own commit: `git add -A`, then `git commit -m "add: <short summary>"` (`fix:` if fixes only).
2. Release files: `git add package.json package-lock.json releases/vX.Y.Z.md`, then `git commit -m "add: Release vX.Y.Z"`. If they are already committed there is nothing to commit; skip it instead of creating an empty commit.
3. `git status --short` must now be empty.

With `prepare-only`, stop here and report.

## Step 8 - Push, open the PR, merge

```powershell
git push -u origin <branch>
gh pr list --head <branch> --base main --state open --json number,url       # reuse an open PR if one exists
gh pr create --base main --head <branch> --title "Release vX.Y.Z" --body-file releases/vX.Y.Z.md
gh pr merge <pr-url> --merge --match-head-commit (git rev-parse HEAD)
```

- Never add `--delete-branch`, `--squash`, `--rebase` or `--auto` (auto-merge is disabled on this repo).
- Mergeability is computed asynchronously: if `gh pr merge` says it is not mergeable yet, wait a few seconds and retry (up to 3 times).
- Push rejected as non-fast-forward: integrate as in Step 0, re-run Step 5, push again. Never force.
- Merge blocked by conflicts or required reviews: stop and report. Only pending required checks: `gh pr checks <pr-url> --watch --fail-fast`, then retry. Never `--admin`.
- `gh pr create` reports no commits between `main` and the branch: it is already merged. Confirm that `origin/main` has the bump and the notes, then go to Step 9.

## Step 9 - Tag `main` and push the tag

```powershell
git checkout main
git pull --ff-only
node scripts/check-release.mjs vX.Y.Z      # on main's HEAD: bump and notes must be merged
git tag vX.Y.Z
git push origin vX.Y.Z                     # the tag only; this is what starts the pipeline
git ls-remote --tags origin "refs/tags/vX.Y.Z"
```

If `pull --ff-only` fails (local `main` diverged) or `check-release` fails on `main`, stop and report. Do not tag.

## Step 10 - Confirm the pipeline started (do not wait)

```powershell
(gh run list --workflow release.yml --limit 5 --json databaseId,event,headBranch,status,url | ConvertFrom-Json) | Where-Object headBranch -eq 'vX.Y.Z'
```

The parentheses matter: Windows PowerShell 5.1 does not unroll a JSON array into the pipeline, so without them the filter silently matches nothing. A run with `event` = `push` and `headBranch` = `vX.Y.Z` should appear within seconds. If none shows up after about 30 seconds, use the documented manual fallback once and check again: `gh workflow run release.yml -f tag=vX.Y.Z`. Then stop; do not wait for the run to complete.

## Step 11 - Report

Short and factual: version and tag, PR link and merge commit, validation results, the run URL, and the release page (`<repo URL from git remote get-url origin, without .git>/releases/tag/vX.Y.Z`, which appears when the workflow finishes). Mention that the checkout is left on `main`, that `gate` and `audit` must pass before any installer is built, and the next-sprint commands from RELEASING.md (`git checkout -b release/<next>`, `git push --set-upstream origin release/<next>`).

## Resuming an interrupted release

```powershell
git ls-remote --tags origin "refs/tags/vX.Y.Z"
gh pr list --head <branch> --base main --state all --json number,state,url,mergedAt
(git show origin/main:package.json | ConvertFrom-Json).version
```

| Observed | Resume at |
| --- | --- |
| Tag is on `origin` | Step 10. Otherwise the release is done. |
| PR merged (or `origin/main` already has version `X.Y.Z`) but no tag | Step 9. |
| PR open | Step 8 (merge). |
| Branch pushed or ahead of `origin`, no PR | Step 8. |
| Release files missing or uncommitted | Steps 3-7. |

## If something fails

| Failure | What to do |
| --- | --- |
| `check-release` fails | Read its message. Missing or empty notes: Step 4. Tag and version differ: fix the version (Step 3) or the tag you passed. |
| `npm run audit` fails (high or critical) | Show the advisories (`npm audit --audit-level=high`). Propose `npm audit fix` (never `--force`) or an `overrides` pin in `package.json` (precedent: brace-expansion), apply only with the user's OK, re-run Step 5 and include `package.json` and `package-lock.json` in the commit. If the registry is unreachable, say so; the pipeline's audit job still runs. |
| `typecheck` or `npm test` fails | Stop and report the failing output. A release must not ship with a red gate; fixing is the user's call. |
| Tag already on `origin` | Do not redo it. Check `gh run list --workflow release.yml`, and use the dispatch fallback if no run exists. Re-creating a tag needs explicit approval: `git tag -d vX.Y.Z` then `git push origin --delete vX.Y.Z`, fix, merge, and tag again. Deleting a tag does not remove a GitHub Release that was already published. |
| Pipeline fails after tagging | No build runs and no release is created when `gate` or `audit` fails. Fix on the release branch, PR and merge, then retag (needs approval as above). |
| `gh` is not authenticated | Ask the user to run `gh auth login`. |

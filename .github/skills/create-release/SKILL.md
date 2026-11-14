---
name: create-release
description: Cut and publish a Lemonade Stand release by following docs/RELEASING.md - bump the version in package.json, write releases/vX.Y.Z.md, run the release gate (check-release, typecheck, audit, tests), merge the release/X.Y branch into main through a PR, then tag vX.Y.Z and push the tag to trigger the Release workflow. Also covers hotfix/patch releases and resuming an interrupted release. Use when asked to create, cut, ship, publish, tag or trigger a release or hotfix, bump the version, or prepare release notes. It does not watch the pipeline.
---

# Create a Lemonade Stand release

Does in one pass what [docs/RELEASING.md](../../../docs/RELEASING.md) describes. If this skill and that guide disagree, follow the guide and tell the user.

**Flow:** preflight → version → branch → bump → notes → validate → confirm → commit → push + PR + merge → tag the merge commit → push tag → check the pipeline started → report.

**Finish line:** tag `vX.Y.Z` is on `origin` and a Release workflow run has started. Do not wait for that run to finish.

**When something is off** (a tag or PR already exists, a check fails, a push is rejected, an earlier attempt was interrupted), read [references/resume-and-troubleshooting.md](references/resume-and-troubleshooting.md) (`.github/skills/create-release/references/resume-and-troubleshooting.md`) before acting.

Placeholders: `X.Y.Z` = target version, `vPREV` = latest released tag, `<branch>` = `release/X.Y`, `<validated-sha>` = the commit you validated and pushed (`git rev-parse HEAD` after Step 7). Commands are PowerShell (7 or Windows PowerShell 5.1); `git`, `npm` and `gh` behave the same in any shell. PowerShell keeps going after a failed `git`/`npm`/`gh` command, so check each exit code and never put a write (`git push`, `git tag`, `gh pr merge`) in the same block as a check that could fail, unless the block guards itself with `throw`. Blocks marked *one call* carry variables; otherwise variables don't survive between shell calls, so substitute printed values (`<pr-url>`, `<merge-sha>`) into later blocks.

## Why the rules exist

Pushing a `v*` tag runs `.github/workflows/release.yml`. Its `gate` job (`scripts/check-release.mjs <tag>` + typecheck) and `audit` job (`npm audit --audit-level=high`) must pass before `build` (Windows, macOS, Linux) and `release` (GitHub Release whose body is `releases/<tag>.md`) run. A failure after tagging means deleting and re-pushing the tag, so reproduce `gate` and `audit` locally first (Step 5).

## Invariants

- `package.json` `version` = `X.Y.Z`, tag = `vX.Y.Z`, notes = `releases/vX.Y.Z.md` (non-empty). The gate fails if they drift.
- The tag points at a commit that already contains the bump and the notes: the release PR's merge commit (Step 9). Never tag an unmerged or unpushed commit.
- Lightweight tag (like every existing tag), pushed on its own and never in the same `git push` as a branch (release.yml warns that a combined push may not trigger the workflow).
- PRs are merged with a merge commit. Release branches are never deleted (hotfixes branch from them).
- Nothing is written to the remote before the go-ahead in Step 6 (`git fetch` and `gh` reads are fine). `prepare-only` writes nothing to the remote at all.

## Safety rules

Never do these unless the user explicitly asks: force-push; delete, move or recreate a tag; `gh pr merge --admin`; `--no-verify`; `npm audit fix --force`; push straight to `main`; skip or work around a failing check; stage with `git add -A` or `git add .`; commit `.env*`, `config/*.local.json`, `conversations/`, `memory.jsonl`, or anything that looks like a secret.

## Inputs

The user may give `X.Y.Z`, a bump keyword (`patch`, `minor`, `major`), neither, and/or `prepare-only` (do Steps 0-7, push nothing, report).

- If the user wants only one part (for example "write the release notes" or "bump the version"), do just that step and stop.
- A patch of an already-released line (`Z > 0`) is a hotfix: follow [references/hotfix.md](references/hotfix.md) (`.github/skills/create-release/references/hotfix.md`) instead of this procedure.

## Step 0 - Preflight (read-only)

```powershell
git fetch origin --tags --prune
git status --short --branch
$v = node -p "require('./package.json').version"
"package.json version : $v"
$remoteTags = git ls-remote --tags --refs --sort=-v:refname origin 'refs/tags/v*' | ForEach-Object { $_ -replace '^.*refs/tags/', '' }
"released tags        : " + (($remoteTags | Select-Object -First 3) -join ', ')
"local-only tags      : " + ((git tag --list 'v*' | Where-Object { $_ -notin $remoteTags }) -join ', ')
"notes for $v exist   : " + (Test-Path "releases/v$v.md")
gh auth status
```

`vPREV` is the first released tag (version-sorted, from `origin`). Do **not** use `git describe`: release tags sit on `main`'s merge commits, which are usually not ancestors of the release branch. Local-only tags are leftovers (for example from an interrupted run) and must not influence the version.

| Finding | Action |
| --- | --- |
| `gh auth status` fails | Stop. Ask the user to run `gh auth login` (needs `repo` and `workflow` scopes). |
| `fetch` rejects a tag ("would clobber existing tag") | Local and remote tags differ. Stop and ask; never `--force`. |
| Uncommitted changes | Note them for Step 6. |

## Step 1 - Decide the version

| You were given | Target version |
| --- | --- |
| `X.Y.Z` | That version. |
| `patch`, `minor` or `major` | Bump `vPREV` (not `package.json`, which may already be bumped). |
| Nothing, and `package.json` is greater than `vPREV` | The `package.json` version. The bump is already done. |
| Nothing, on `release/X.Y` | `X.Y.0`, if greater than `vPREV`. |
| Anything else | Ask. Recommend `minor` if the commits since `vPREV` add features, `patch` if they only fix. |

Then check the target in this order, and stop and ask if a check fails:

1. Plain `MAJOR.MINOR.PATCH` only. Reject pre-release suffixes (the pipeline would publish them as a normal release) and build metadata (`npm version` strips it, so the tag would no longer match).
2. `Z > 0` is a hotfix: switch to [references/hotfix.md](references/hotfix.md) now; its own checks apply.
3. Tag `vX.Y.Z` is already on `origin` (already tagged), or exists only locally (leftover from an interrupted run): follow the resume reference. Never re-tag.
4. Greater than `vPREV`, and `MAJOR.MINOR` matches `release/MAJOR.MINOR`.

## Step 2 - Be on the release branch, in sync with `origin`

A release is cut from `release/<MAJOR>.<MINOR>`. If you are on it, continue. Otherwise ask before switching, and never switch over uncommitted changes without asking.

- Branch exists locally or on `origin`: `git checkout release/X.Y` (git creates the tracking branch if only the remote has it).
- Branch exists nowhere: offer to create it locally from an up-to-date `main` (`git checkout main`, `git pull --ff-only`, `git checkout -b release/X.Y`). Do **not** push it now: Step 8's push creates it on `origin`, so nothing reaches the remote before the go-ahead.

Then, on that branch, sync with `origin`:

```powershell
git ls-remote --heads origin <branch>                          # prints nothing if the branch isn't on origin yet: nothing to sync
git fetch origin <branch>                                      # only if the line above printed something; refreshes origin/<branch>
git rev-list --left-right --count 'HEAD...origin/<branch>'     # "ahead behind"
```

If `behind` is above 0, integrate it before anything else: `git pull --no-rebase --no-edit origin <branch>` (a merge; `--no-edit` keeps git from opening an editor; never rebase or force-push). Conflicts, or git refusing because of local changes: stop and ask. Re-run Step 5 afterwards. If only `ahead` is above 0 there is nothing to integrate (Step 8 pushes).

## Step 3 - Bump the version

```powershell
npm version X.Y.Z --no-git-tag-version --allow-same-version
node -p "[require('./package-lock.json').version, require('./package-lock.json').packages[''].version].join(' ')"   # must print: X.Y.Z X.Y.Z
```

`--allow-same-version` makes the bump idempotent: when `package.json` already says `X.Y.Z` it just repairs the lockfile's version fields (a hand-edited bump leaves them stale). Always pass `--no-git-tag-version`: the tag is created later, on the merge commit. Check `git diff package.json package-lock.json`: only version lines (plus intended dependency changes) should differ.

## Step 4 - Write the release notes (`releases/vX.Y.Z.md`)

The file becomes the GitHub Release body verbatim, so write for users of the app.

- Exists and is complete (non-empty, no template placeholders): **keep it**. It is the user's text; only fix a wrong title or date.
- Exists but is empty or still has placeholders: edit it in place. Never overwrite a draft.
- Missing: `Copy-Item releases/TEMPLATE.md releases/vX.Y.Z.md`, then fill it in with the file-edit tool (UTF-8, LF; never `>` redirection).
- Layout: `# vX.Y.Z`, `_Release date: YYYY-MM-DD_` (today), a one or two sentence summary, then `## Added`, `## Changed`, `## Fixed`, `## Known issues` (and `## Security` when fixing advisories). Delete sections with nothing to say (v0.10.1 has only "Fix").
- One bullet per user-visible change: a **bold name**, then what it does and why it matters; sub-bullets for detail. Link issues or PRs (`[#28](https://github.com/siavashdev/lemonade-stand/issues/28)`) when commits reference them.
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

All five take seconds. They read the working tree, so run them after Step 2's sync, on exactly the files that will ship.

- If `node_modules` is missing or `npm ls --depth=0` fails, run `npm ci` first (it deletes `node_modules`; ask first if a dev server may be running).
- Any failure: stop. Don't commit or tag. Show the failing output and the fix options (troubleshooting reference).
- Optional packaging smoke test (`npm run package:win`, `package:mac` or `package:linux`, takes minutes): only when the user asks, or when `git diff --name-only vPREV..HEAD -- electron-builder.yml electron.vite.config.ts scripts resources` lists files or Electron/electron-builder were bumped. Offer it; don't run it silently.

## Step 6 - Confirm once

Nothing has been written to the remote yet. Show a compact plan and ask for the go-ahead (use the ask-user tool if you have one, then wait). Offer **Release now**, **Prepare only (commit locally, push nothing)** and **Cancel**. Include:

- version, tag, branch, and the first lines of the notes file;
- commits since `vPREV` (count and the top few);
- uncommitted files that would be committed, split into release files and everything else, flagging anything unexpected, and any files that will be left out (validation ran with them present);
- validation results;
- the remote actions: push the branch, open (or reuse) and merge the PR into `main`, tag and push `vX.Y.Z` (publishes a public GitHub Release once the pipeline finishes).

Skip the question only when the user's request explicitly pre-approves the release (for example "go ahead" or "don't ask"). With `prepare-only` the plan is still shown, but the question only covers what gets committed. If the set of files to commit changes, re-run Step 5.

## Step 7 - Commit

`git commit` takes everything that is staged, so always name the paths: `git commit -m "<msg>" -- <paths>` commits only those paths and leaves anything else that is staged alone.

1. Other pending changes approved in Step 6 ship in the release, so commit them first, on their own: `git add -- <approved paths>`, then `git commit -m "add: <short summary>" -- <approved paths>` (`fix:` if fixes only). Approved paths never include `*.local.json`, `.env*`, keys, or anything you did not show the user.
2. Release files (a no-op if they are already committed; never create an empty commit):

```powershell
git add -- package.json package-lock.json releases/vX.Y.Z.md
git diff --cached --quiet -- package.json package-lock.json releases/vX.Y.Z.md; if ($LASTEXITCODE -ne 0) { git commit -m "add: Release vX.Y.Z" -- package.json package-lock.json releases/vX.Y.Z.md } else { "release files already committed; nothing to commit" }
```

3. `git status --short` must show nothing that was meant to ship. Note `git rev-parse HEAD`: that is `<validated-sha>`.

With `prepare-only`, stop here and report.

## Step 8 - Push, open (or reuse) the PR, merge

Run as *one call*; it stops itself on failure. Note the printed PR URL for Step 9.

```powershell
git push -u origin <branch>; if ($LASTEXITCODE -ne 0) { throw 'push failed' }
$pr = (gh pr list --head <branch> --base main --state open --json url | ConvertFrom-Json) | Select-Object -First 1 -ExpandProperty url
if (-not $pr) { $pr = gh pr create --base main --head <branch> --title "Release vX.Y.Z" --body-file releases/vX.Y.Z.md | Select-Object -Last 1 }
if (-not $pr) { throw 'no PR url' }
$pr
gh pr merge $pr --merge --match-head-commit (git rev-parse HEAD)
```

- Never add `--delete-branch`, `--squash`, `--rebase` or `--auto` (auto-merge is disabled on this repo). `--match-head-commit` makes the merge fail if the PR head is not the commit you validated.
- Mergeability is computed asynchronously: if `gh pr merge` says it is not mergeable yet, wait a few seconds and retry (up to 3 times).
- Push rejected as non-fast-forward, or `--match-head-commit` mismatch: back to Step 2 (it fetches `origin/<branch>` first), re-run Step 5, push again. Never force.
- Merge blocked by conflicts or required reviews: stop and report. Only pending required checks: `gh pr checks <pr-url> --required --watch --fail-fast`, then retry (that waits for PR CI, not the release pipeline; if it runs past about 10 minutes, report and stop). Never `--admin`.
- `gh pr create` reports no commits between `main` and the branch: it is already merged. Use the resume reference.

## Step 9 - Tag the merge commit and push the tag

Verify first (read-only), with the PR URL from Step 8 and the `<validated-sha>` from Step 7:

```powershell
git fetch origin --tags
$info = gh pr view <pr-url> --json state,mergeCommit | ConvertFrom-Json
$sha = $info.mergeCommit.oid
"PR state                    : $($info.state)"
"merge commit                : $sha"
git diff --quiet <validated-sha> $sha; "tree identical to validated : " + ($LASTEXITCODE -eq 0)
git cat-file -e "${sha}:releases/vX.Y.Z.md"; "notes in merge commit        : " + ($LASTEXITCODE -eq 0)
"version in merge commit     : " + (git show "${sha}:package.json" | ConvertFrom-Json).version
```

- Merge commit empty or state not `MERGED`: wait a few seconds and retry once, then go back to Step 8.
- Tree identical, notes present and version `X.Y.Z`: go ahead.
- Tree differs (`main` contributed changes, or the PR was merged with a head you didn't validate): validate that exact commit (`git checkout --detach <merge-sha>`, re-run Step 5, `npm ci` if dependencies changed, then return to your branch), tell the user what differs, and continue only with their OK.

Then, as a separate call with the SHA substituted. The guards matter: a failed `git tag` must not fall through to pushing an existing tag.

```powershell
git tag vX.Y.Z <merge-sha>; if ($LASTEXITCODE -ne 0) { throw 'tag failed' }
git push origin vX.Y.Z; if ($LASTEXITCODE -ne 0) { throw 'tag push failed' }
"remote tag points at the merge commit : " + ((git ls-remote --tags origin "refs/tags/vX.Y.Z") -match '<merge-sha>')   # must print True
```

Tagging the merge commit's SHA (not "whatever local `main` is") keeps unpushed commits and uncommitted files out of the release. Last, as a courtesy and only if the working tree is clean: `git checkout main`, `git pull --ff-only` (skip it if either fails).

## Step 10 - Confirm the pipeline started (do not wait for it to finish)

This only confirms the trigger. Never wait for the run itself.

```powershell
(gh run list --workflow release.yml --branch vX.Y.Z --limit 5 --json databaseId,event,status,url | ConvertFrom-Json) | ForEach-Object { "$($_.event) $($_.status) $($_.url)" }
```

`--branch` filters server-side (a tag-triggered run's branch is the tag), so older runs are found too. The parentheses matter: Windows PowerShell 5.1 does not unroll a JSON array, so without them the pipeline silently matches nothing. A push-triggered run is normally visible within seconds: check now, then at most twice more, `Start-Sleep -Seconds 15` apart. Any run for the tag (queued, in progress or done) means it started; report its URL.

Only if there is still none, use the documented manual fallback, once:

1. List recent manual runs: `(gh run list --workflow release.yml --event workflow_dispatch --limit 3 --json databaseId,status,createdAt,url | ConvertFrom-Json)`. If one was created in the last hour it may already cover this tag (its input isn't shown): report it and ask instead of dispatching again.
2. Otherwise dispatch: `gh workflow run release.yml -f tag=vX.Y.Z`, list the manual runs again, and report the new one. Then stop.

## Step 11 - Report

Short and factual: version and tag, PR link and merge commit, validation results, the run URL, and the release page (`<repo URL from git remote get-url origin, without .git>/releases/tag/vX.Y.Z`, which appears when the workflow finishes). Mention that `gate` and `audit` must pass before any installer is built, and give the next-sprint commands from RELEASING.md (`git checkout -b release/<next>`, `git push --set-upstream origin release/<next>`).

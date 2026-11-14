# Hotfix / patch release

Use for `vX.Y.Z` with `Z > 0`: a fix to an already-released line (`release/X.Y`) that cannot wait for the next regular release. If it can wait, use the normal flow in [SKILL.md](../SKILL.md) instead.

Source: the "Hotfix" section of [docs/RELEASING.md](../../../../docs/RELEASING.md). History confirms the shape: `hotfix/0.10.1` was merged into `release/0.10`, and `v0.10.1` was tagged on that branch.

Placeholder: `vBASE` is the tag being patched, written out as plain text (for `0.12.1` it is `v0.12.0`). Never compute it inside a command: `v0.12.(1-1)` is not a tag. In this flow `vPREV` means `vBASE`, `<branch>` means `hotfix/X.Y.Z`, and the PR base is `release/X.Y`.

## How it differs from a normal release

| | Normal release | Hotfix |
| --- | --- | --- |
| Work branch | `release/X.Y` | `hotfix/X.Y.Z`, created from the **tag** `vBASE` (not from `main`) |
| PR | `release/X.Y` into `main` | `hotfix/X.Y.Z` into `release/X.Y` |
| Tagged commit | the PR's merge commit on `main` | the PR's merge commit on `release/X.Y` |
| Afterwards | nothing | forward-port the fix to `main` |

The gate checks the tagged commit, so the hotfix branch must itself carry the version bump (`package.json`, `package-lock.json`) and `releases/vX.Y.Z.md`. The real hotfix commits did (v0.10.1).

## Procedure

The rules, invariants and safety rules of [SKILL.md](../SKILL.md) apply unchanged: nothing is written to the remote before the go-ahead, name explicit paths when committing, merge with a merge commit, tag the PR's merge commit, push the tag on its own. The steps below name the SKILL.md steps to reuse for the details they describe.

1. **Preflight and version** (SKILL.md Step 0). The target must be plain `MAJOR.MINOR.PATCH` (no pre-release or build suffix), the next patch of the line, and greater than `vBASE`. `vBASE` is the latest *published* tag of that line: the first line of `git ls-remote --tags --refs --sort=-v:refname origin 'refs/tags/vX.Y.*'`. Stop if `release/X.Y` or `vBASE` is missing. If `vX.Y.Z` is already on `origin`, do step 7 (pipeline check) and step 8 (forward-port) only. If it exists only locally, see the resume reference.
2. **Create the branch off the tag**, locally only (ask first if the working tree has uncommitted changes):

   ```powershell
   git fetch origin --tags
   git checkout release/X.Y
   git pull --ff-only
   git checkout -b hotfix/X.Y.Z vBASE
   ```

   If `hotfix/X.Y.Z` already exists (locally or on `origin`), check it out instead of creating it, and sync it as in SKILL.md Step 2. The fix commits belong on this branch. Ask how the user wants to supply the fix (they may have commits to cherry-pick).
3. **Bump, notes, validate** (SKILL.md Steps 3, 4 and 5). The notes describe only the fix (style: v0.10.1, v0.8.1); `git log --oneline --no-merges vBASE..HEAD` lists it.
4. **Confirm once** (SKILL.md Step 6). The remote actions to list are: push `hotfix/X.Y.Z`, open (or reuse) and merge the PR into `release/X.Y`, tag and push `vX.Y.Z`. Mention the forward-port to `main` as a follow-up. Then **commit** (SKILL.md Step 7).
5. **Push and merge into the release branch**, as *one call*:

   ```powershell
   git push -u origin hotfix/X.Y.Z; if ($LASTEXITCODE -ne 0) { throw 'push failed' }
   $pr = (gh pr list --head hotfix/X.Y.Z --base release/X.Y --state open --json url | ConvertFrom-Json) | Select-Object -First 1 -ExpandProperty url
   if (-not $pr) { $pr = gh pr create --base release/X.Y --head hotfix/X.Y.Z --title "Release vX.Y.Z" --body-file releases/vX.Y.Z.md | Select-Object -Last 1 }
   if (-not $pr) { throw 'no PR url' }
   $pr
   gh pr merge $pr --merge --match-head-commit (git rev-parse HEAD)
   ```

   Same merge rules as SKILL.md Step 8 (no `--admin`, no `--delete-branch`).
6. **Tag the merge commit and push the tag**: SKILL.md Step 9 with the PR URL from step 5 and `<validated-sha>` from step 4. The tag lands on `release/X.Y`'s merge commit. Skip the "leave the checkout on `main`" courtesy.
7. **Confirm the pipeline started** (SKILL.md Step 10), without waiting for it to finish.
8. **Forward-port to `main`**, the last step of the guide. It is not needed to trigger the pipeline and it can conflict, so ask the user whether to do it now. If they decline or defer, list it as pending in the final report.
   - Branch from an up-to-date `main` as `forwardport/vX.Y.Z` (precedent: `forwardport/v0.2.1`).
   - Cherry-pick the fix commits and bring over `releases/vX.Y.Z.md`.
   - Never lower the `package.json` or `package-lock.json` version on `main`: resolve those conflicts in favour of `main`.
   - Push, open a PR into `main`, and merge it with a merge commit.
9. **Report** (SKILL.md Step 11).

## Resuming a hotfix

Use the table in [resume-and-troubleshooting.md](resume-and-troubleshooting.md) with these substitutions: wherever it says Step 8, run step 5 above; Step 9 means step 6 above; the PR base is `release/X.Y` and the head is `hotfix/X.Y.Z` in every `gh pr list`; and when the tag is already on `origin`, finish with steps 7 and 8.

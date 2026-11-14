# Hotfix / patch release

Use for `vX.Y.Z` with `Z > 0`: a fix to an already-released line (`release/X.Y`, last tag `vX.Y.(Z-1)`) that cannot wait for the next regular release. If the fix can ship in the next regular release, use the normal flow in [SKILL.md](../SKILL.md) instead.

Source: the "Hotfix" section of [docs/RELEASING.md](../../../../docs/RELEASING.md). History confirms the shape: `hotfix/0.10.1` was merged into `release/0.10`, and `v0.10.1` was tagged on that branch.

## How it differs from a normal release

| | Normal release | Hotfix |
| --- | --- | --- |
| Work branch | `release/X.Y` | `hotfix/X.Y.Z`, created from the **tag** `vX.Y.(Z-1)`, not from `main` |
| PR | `release/X.Y` into `main` | `hotfix/X.Y.Z` into `release/X.Y` |
| Tagged branch | `main` | `release/X.Y` |
| After tagging | nothing | forward-port the fix to `main` |

The gate is unchanged. It checks the tagged commit, so the hotfix branch must itself contain the version bump (`package.json` and `package-lock.json`) and `releases/vX.Y.Z.md`. In the hotfix flow, "latest tag" and `vPREV` mean the latest tag of that line: `git tag --list 'vX.Y.*' --sort=-v:refname | Select-Object -First 1`.

Reuse Steps 0, 1, 3, 4 (notes describe only the fix), 5, 6, 7 and 10-11 of [SKILL.md](../SKILL.md). In place of Steps 2, 8 and 9:

## 1. Create the hotfix branch off the tag

```powershell
git fetch origin --tags
git checkout release/X.Y
git pull --ff-only
git checkout -b hotfix/X.Y.Z vX.Y.(Z-1)
```

The fix commits belong on this branch. Ask the user how they want to supply the fix (they may already have commits to cherry-pick). Then do SKILL.md Steps 3-7 on this branch and push it:

```powershell
git push -u origin hotfix/X.Y.Z
```

## 2. PR into the release branch and merge

```powershell
gh pr create --base release/X.Y --head hotfix/X.Y.Z --title "Release vX.Y.Z" --body-file releases/vX.Y.Z.md
gh pr merge <pr-url> --merge --match-head-commit (git rev-parse HEAD)
```

Same merge rules as SKILL.md Step 8 (no `--admin`, no `--delete-branch`).

## 3. Tag the release branch and push the tag

```powershell
git checkout release/X.Y
git pull --ff-only
node scripts/check-release.mjs vX.Y.Z
git tag vX.Y.Z
git push origin vX.Y.Z
```

Then confirm the pipeline started (SKILL.md Step 10) and stop. Do not wait for it.

## 4. Forward-port to `main`

The last step of the guide. It is not needed to trigger the pipeline and it can conflict, so ask the user before doing it.

- Branch from an up-to-date `main` as `forwardport/vX.Y.Z` (precedent: `forwardport/v0.2.1`).
- Cherry-pick the fix commits and bring over `releases/vX.Y.Z.md`.
- Never lower the `package.json` or `package-lock.json` version on `main`: resolve those conflicts in favour of `main`.
- Push, open a PR into `main`, and merge it with a merge commit.

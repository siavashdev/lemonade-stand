# Resuming an interrupted release, and fixing failures

Used from [SKILL.md](../SKILL.md); step numbers refer to it. For a hotfix, read [hotfix.md](hotfix.md) as well: its step numbers differ.

## Resuming

The target is the version already in progress: `package.json`'s version, or the open or merged release PR. Never re-apply a bump keyword such as `patch`: once a tag was pushed it would select the next version. If the in-progress version can't be recovered, ask.

Re-run Steps 0-1, then use the first row that matches:

| Observed | Do |
| --- | --- |
| Tag `vX.Y.Z` is on `origin` | Step 10 only; nothing else is pending. Never re-tag. (Hotfix: also offer the forward-port.) |
| Tag exists only locally | `git rev-parse "vX.Y.Z^{commit}"` must equal the release PR's merge commit. If it does, push just the tag with `git push origin vX.Y.Z` (never `git tag` again), check it landed (last line of Step 9's tag block) and do Step 10. If not, stop: removing a tag needs the user's approval. |
| Release PR already merged, no tag | Step 9 on that PR. Find it with `gh pr list --head <branch> --base main --state merged --json url,mergeCommit`. You don't know what was validated, so validate the merge commit itself: `git checkout --detach <merge-sha>`, Step 5 there, back to your branch, then tag. |
| Anything else (PR open, branch pushed or ahead, files missing or uncommitted) | Steps 2-7 first. They are no-ops when nothing is pending, and they commit and push any pending release work so an open PR is not merged without it. Then Step 8, which reuses an open PR. |

Re-run Step 5 on the state you are about to ship, and get a fresh go-ahead (Step 6) before any remote write, unless the user already approved this exact release earlier in this conversation. Step 10 only reads, except for its dispatch fallback, which needs the same go-ahead.

## If something fails

| Failure | What to do |
| --- | --- |
| `check-release` fails | Read its message. Missing or empty notes: Step 4. Tag and version differ: fix the version (Step 3) or the tag you passed. |
| `npm run audit` fails (high or critical) | Show the advisories (`npm audit --audit-level=high`). Propose `npm audit fix` (never `--force`) or an `overrides` pin in `package.json` (precedent: brace-expansion), apply only with the user's OK, re-run Step 5 and include `package.json` and `package-lock.json` in the commit. If the registry is unreachable, say so; the pipeline's audit job still runs. |
| `typecheck` or `npm test` fails | Stop and report the failing output. A release must not ship with a red gate; fixing is the user's call. |
| Push rejected, or merge refused by `--match-head-commit` | The branch moved. Back to Step 2 (fetch and integrate), Step 5, push again. Never force. |
| PR cannot be merged | Conflicts: stop and report (offer to merge `origin/main` into the release branch and resolve with the user). Required reviews or checks: see Step 8. Never `--admin`. |
| Tag already on `origin` | Do not redo it. Check Step 10, and use its dispatch fallback if no run exists. Re-creating a tag needs explicit approval: `git tag -d vX.Y.Z` then `git push origin --delete vX.Y.Z`, fix, merge, and tag again. Deleting a tag does not remove a GitHub Release that was already published. |
| Pipeline fails after tagging | No build runs and no release is created when `gate` or `audit` fails. Fix on the release branch, PR and merge, then retag (needs approval as above). |
| `gh` is not authenticated | Ask the user to run `gh auth login`. |

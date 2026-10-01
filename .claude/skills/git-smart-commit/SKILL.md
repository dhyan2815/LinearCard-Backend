---
name: git-smart-commit
description: Scan the repo for uncommitted changes, group them into logically separate commits, draft commit messages matching the repo's existing style, and push to origin. Use whenever the user asks to commit their changes, "commit and push", "clean up my working tree", or says something like "just commit this for me" — invoking this skill is the user's explicit go-ahead to commit and push, no separate confirmation needed.
license: Apache-2.0
metadata:
  author: dhyan2815
  version: "1.0.0"
allowed-tools: Bash Read Grep
---

# Git Smart Commit

## Overview
Scans the working tree, splits changes into logically separate commits, drafts messages that match the repo's own history, and pushes. Invoking this skill is the user's go-ahead to commit and push — no mid-workflow confirmation needed, since asking would defeat the point of a one-shot workflow.

## Instructions

1. **Scan changes and inspect history**
   - `git status -u` — full picture of untracked, modified, and deleted files.
   - `git log -n 5` — infer the repo's actual commit message convention (prefix style, casing) rather than assuming one.
   - Note any renames or file migrations that belong together in one commit.

2. **Group into logical commits**
   Unrelated changes in one commit make history hard to bisect and review — so split by concern, not by "everything touched today":
   - Documentation/config edits (docs, policy, meeting notes) → one commit.
   - Source, scripts, or notebook changes → grouped by the feature/fix they implement.
   - Aim for 1-3 commits total; more than that usually means the grouping is too fine-grained.

3. **Draft commit messages**
   - One line per commit, matching the prefix/casing style found in Step 1 (e.g. `add: ...`, `fix: ...`, `Docs: ...`).
   - Message describes *why*, not a file listing.

4. **Stage, commit, push**
   - Stage deliberately per group (`git add <file> <file>`) — never a blind `git add .`, since that can sweep in unrelated or sensitive files.
   - Commit each group: `git commit -m "<message>"`.
   - `git push`.
   - `git status` at the end to confirm the working copy is clean and in sync with origin.

## Output Format
A short list of the commits made — one line each as `<hash> <message>` — followed by the final `git status`. Keep commentary minimal; the value of this skill is doing the sequence, not narrating it.

---
name: review-report
description: Write the final report of a pull request review as a JSON file that the worktree cockpit renders as colored blocks (blocking, to fix, suggestion, question, praise, context). Use at the end of every review, or when asked for a review report.
---

# Review report

Write the report once the review is finished and every finding has been checked against the code.
The cockpit (`~/.claude/worktree-dashboard`) shows it in the "Rapport" tab of the worktree card.

## Where

`~/.claude/worktree-reviews/<worktree>.report.json`, where `<worktree>` is the basename of the
worktree directory (`main` for the main checkout). A review session started from the cockpit gets
the exact path in its system prompt. Write it atomically (temporary file, then `mv`), and rewrite
the whole file when the review is updated.

## Format

```json
{
  "pr": { "number": 13386, "url": "https://github.com/org/repo/pull/13386", "title": "PR title", "author": "login" },
  "verdict": "request_changes",
  "summary": "Two or three sentences: what the PR does and what blocks it.",
  "generatedAt": "2026-10-27T10:00:00Z",
  "blocks": [
    {
      "kind": "blocking",
      "title": "Intra organizations missing from the trainer dropdown",
      "file": "services/learning/core/src/training.repository.neo4j.ts",
      "line": 384,
      "finding": "What the code does, in one paragraph.",
      "impact": "Concrete scenario: input or state, then the wrong result.",
      "fix": "What to change.",
      "comment": "Draft of the PR comment, ready to paste."
    }
  ]
}
```

| `kind` | Use for | Color |
|---|---|---|
| `blocking` | Bug, regression, data loss, security hole: justifies a request changes | red |
| `fix` | Must be fixed but does not block alone: project rule, missing test, lint | amber |
| `suggestion` | Optional improvement: simplification, reuse, performance, UX | blue |
| `question` | Something to clarify with the author before concluding | violet |
| `praise` | A choice worth keeping or copying | green |
| `info` | Context the reader needs: scope, what was not reviewed, tests run | grey |

- `verdict`: `request_changes` when at least one block is `blocking`, `comment` when there are
  only `fix`, `suggestion` or `question` blocks, `approve` otherwise.
- Order blocks from most to least severe. One block per distinct problem: never merge two
  problems into one block.
- Only `kind` and `title` are required. `file` is relative to the repo root; `line` is optional.
- `finding`, `impact` and `fix` are separate short paragraphs (inline `code` with backticks is
  rendered). Write them in the user's conversation language.
- `comment` follows the user's PR comment conventions (language, tone, length). Never post it
  yourself: the user copies it from the cockpit.

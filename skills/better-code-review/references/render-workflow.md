# Render and report

How to turn the validated plan into `review.html` and tell the user about the review. See [SKILL.md](../SKILL.md#5-render-and-report).

## 1. Render

Once `validate` passes, or `fallback` has replaced the plan:

```text
better-code-review render --dir <dir>
```

- It checks `plan.json` as `validate` does and rewrites `<dir>/review.html` with it, then prints `Review written to <path>`.
- Exit code 1 means the plan is invalid, and nothing was written: go back to step 4 of SKILL.md, validate and repair.
- Add `--open` when the user asked to see the review, to open it in their browser. If it can't, it says so, and the page is still written.

## 2. Report

Tell the user:
- the path to `review.html`, and how to use it: it opens from the file in a browser, with no network. Its outline is your plan, every hunk is in the graph, guided and file views, and its comments come back to you through **Copy feedback for agent** or an exported `review-feedback.json`
- the target, the snapshot ID (first 12 characters) and the review directory
- `N/N hunks mapped` from the summary, and any missing language servers
- the groups in reading order, one line each
- the `possible` edges you judged `no` or `unsure`, and the nodes left in Ungrouped

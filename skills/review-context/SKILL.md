---
name: review-context
description: Gather the business context of a pull request before reviewing it - the Jira ticket linked in its description, that ticket's comments and linked exploration, and every Slack thread they point to. Use at the start of every pull request review, before reading the diff.
---

# Review context

Run this first in every review, before reading the diff. Findings judged without the ticket get the
wrong severity: a ticket often narrows the inputs, explains a choice that looks like a bug, or
moves work to a later slice.

## Steps

1. **Ticket.** Read the PR description (`gh pr view <n> --json body,title`). Look for a Jira link
   (`https://<site>.atlassian.net/browse/<KEY>`) or a bare key in the title or the branch name.
   No ticket: write that down in the report's context block and go on.
2. **Read it** with the Atlassian MCP tool `getJiraIssue`: `cloudId` is the link's host
   (`<site>.atlassian.net`), `fields: ["summary", "description", "status", "comment"]`,
   `responseContentFormat: "markdown"`. Load the tool with ToolSearch first if it is deferred.
3. **Linked tickets.** When the description or a comment points to a parent, an exploration or a
   spec ticket the PR relies on, read it the same way. One level deep, no further.
4. **Slack threads.** Collect every Slack link in the PR description, the ticket description and
   the ticket comments (`https://<workspace>.slack.com/archives/<channel>/p<digits>`, often inside
   smartlinks). For each one, call `slack_read_thread`:
   - `channel_id`: the `<channel>` segment.
   - `message_ts`: the `thread_ts` query parameter when the link has one (the link points to a
     reply), otherwise `p<digits>` with the `p` dropped and a dot before the last six digits
     (`p1729000000123456` → `1729000000.123456`).
5. **Keep the useful part.** Note the facts that change how the code is judged: who uses it, the
   real inputs, decisions taken in the threads, what is deliberately out of scope or left to a later
   PR. Skip the rest.

## In the report

- Put a short `info` block titled "Contexte du ticket" (or the conversation language's equivalent)
  in the review report: the ticket key, what it asks, and the decisions that matter for this PR.
- Use that context to set each finding's severity, and to drop findings the ticket explains.
- Say which sources were unavailable (no ticket, a tool not connected, a thread not accessible).
  Never guess their content.
- Never post anything to Jira or Slack: these reads are read-only.

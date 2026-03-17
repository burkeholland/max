---
name: WorkIQ (Microsoft 365)
description: Query Microsoft 365 data — email, calendar, Teams messages, SharePoint documents, and people — using natural language via the WorkIQ MCP server.
---

# WorkIQ (Microsoft 365)

Max can query your Microsoft 365 workplace data using the WorkIQ MCP server. This covers emails, meetings, Teams channels, SharePoint/OneDrive documents, and people/expertise lookups.

## Prerequisites / Setup Check

Before attempting to use WorkIQ, verify the `ask_work_iq` tool is available in your current session. If it is **not** available (not listed in your tools), tell the user:

> "WorkIQ isn't configured yet. Run `max setup` and opt in to the Microsoft 365 / WorkIQ section — it only takes a minute."

Do not attempt to answer M365 questions without the tool. Do not suggest manual workarounds.

## When to Use

Use this skill when the user asks about:

- **Email** — "What did Sarah say about the budget?", "Any unread emails from the team?"
- **Calendar / meetings** — "What meetings do I have tomorrow?", "Summarize last week's standups"
- **Teams** — "What's the latest in the Engineering channel?", "Catch me up on #general"
- **Documents** — "Find the Q3 roadmap doc", "What files did I work on yesterday?"
- **People** — "Who owns the auth system?", "Who's the expert on Azure at our company?"

## How to Use

Call the `ask_work_iq` tool with a natural language question:

```
ask_work_iq({ question: "What are my upcoming meetings this week?" })
ask_work_iq({ question: "Summarize emails from John about the proposal" })
ask_work_iq({ question: "Find documents I worked on yesterday" })
ask_work_iq({ question: "Summarize today's messages in the Engineering channel" })
ask_work_iq({ question: "Who is working on Project Alpha?" })
```

## First Use (EULA)

On first use, WorkIQ may require EULA acceptance. If the tool returns a prompt about accepting terms, call `accept_eula` first, then retry the original question.

## Authentication

WorkIQ uses the user's Microsoft 365 credentials via OAuth. First use will open a browser window for authentication — let the user know this is expected.

## Prerequisites

- Microsoft 365 Copilot license required
- Tenant admin must grant consent (one-time, org-wide setup)
- WorkIQ was configured during `max setup` — if it wasn't, ask the user to run `max setup` again

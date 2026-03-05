---
name: find-skills
description: Helps users discover agent skills when they ask questions like "how do I do X", "find a skill for X", "is there a skill that can...", or express interest in extending capabilities. Always ask the user for permission before installing any skill, and flag security risks.
---

# Find Skills

This skill helps you discover and install skills from the open agent skills ecosystem at https://skills.sh/.

## When to Use This Skill

Use this skill when the user:

- Asks "how do I do X" where X might be a common task with an existing skill
- Says "find a skill for X" or "is there a skill for X"
- Asks "can you do X" where X is a specialized capability
- Expresses interest in extending agent capabilities
- Wants to search for tools, templates, or workflows
- Mentions they wish they had help with a specific domain (design, testing, deployment, etc.)

## How to Search for Skills

Use the skills.sh JSON API to search. This returns structured data you can format into a table.

### Step 1: Search via API

In a worker session, run:

```bash
curl -s "https://skills.sh/api/search?q=QUERY"
```

Replace `QUERY` with a URL-encoded search term (e.g., `react`, `email`, `pr+review`).

The response is JSON:

```json
{
  "skills": [
    {
      "id": "vercel-labs/agent-skills/vercel-react-best-practices",
      "skillId": "vercel-react-best-practices",
      "name": "vercel-react-best-practices",
      "installs": 174847,
      "source": "vercel-labs/agent-skills"
    }
  ]
}
```

### Step 2: Fetch Security Audit Data

Also in the worker session, fetch the audits page and extract security scores for the skills you found:

```bash
curl -s https://skills.sh/audits | python3 -c "
import sys, re
html = sys.stdin.read()
# Extract skill names and their audit data from the rendered page
# The page contains entries like: skill-name  source  Safe  0 alerts  Low Risk
for line in html.split('\n'):
    line = line.strip()
    if any(risk in line for risk in ['Safe', 'Med Risk', 'High Risk', 'Low Risk', 'Critical']):
        print(line)
" 2>/dev/null | head -100
```

The audits page shows three scores per skill from independent security reviewers:
- **Gen Agent Trust Hub**: Safe / Med Risk / Critical
- **Socket**: Number of alerts (0 is best)
- **Snyk**: Low Risk / Med Risk / High Risk / Critical

If the audits page can't be fetched or parsed, show "N/A" in the security column and link to https://skills.sh/audits for manual review.

### Step 3: Present Results as a Table

Format results as a numbered table. Show the top 6-8 results. Example:

```
#   Skill                          Publisher       Installs   Security
─── ────────────────────────────── ────────────── ────────── ─────────────
1   vercel-react-best-practices    vercel-labs     174.8K     ✅ Safe
2   web-design-guidelines          vercel-labs     135.8K     ✅ Safe
3   frontend-design                anthropics      122.6K     ✅ Safe
4   remotion-best-practices        remotion-dev    125.2K     ⚠️ Med Risk
5   browser-use                    browser-use      45.0K     🔴 Critical
```

**Formatting rules:**
- Sort by installs descending (the API already does this)
- Format install counts: 1000+ → "1.0K", 1000000+ → "1.0M"
- Security column: ✅ for Safe/Low Risk, ⚠️ for Med Risk, 🔴 for High Risk/Critical
- If a skill has no audit data, show "—" in the security column
- The "Publisher" is the first part of the `source` field (before the `/`)

After the table, show:

```
🔗 Browse all skills: https://skills.sh/

Which number would you like to install? (or say "none")
```

### Step 4: Ask Permission Before Installing

**NEVER install a skill without explicit user confirmation.** Wait for the user to pick a number.

If the user picks a number, confirm with them first, then install:

```bash
npx skills add <source>@<skillId> -g -y
```

The `-g` flag installs globally (user-level). The source and skillId come from the API response — combine them as `source@skillId` (e.g., `vercel-labs/agent-skills@vercel-react-best-practices`).

### Security Review

Before recommending any skill, evaluate it for security risks. Flag concerns to the user if the skill:

- Has a **Critical** or **High Risk** audit score from any reviewer
- **Runs arbitrary shell commands** or executes code on the user's machine
- **Accesses sensitive data** — credentials, API keys, SSH keys, personal files
- **Makes network requests** to external services (data exfiltration risk)
- **Comes from an unknown or unverified source** — no stars, no established author

When flagging a concern, be specific:

```
⚠️ Heads up — "browser-use" has a Critical risk rating from Snyk and Med Risk from
Gen Agent Trust Hub. It runs shell commands and has broad filesystem access.
Want to proceed, or would you prefer a safer alternative?
```

## When No Skills Are Found

If the API returns no results:

1. Acknowledge that no existing skill was found
2. Offer to help with the task directly using your general capabilities
3. Suggest the user could create their own skill with `npx skills init`

## Uninstalling Skills

To remove a skill the user no longer wants, use the `uninstall_skill` tool with the skill's slug. This removes it from `~/.max/skills/`. The user can also use the `/skills` command in the TUI to see installed skills and uninstall from there.

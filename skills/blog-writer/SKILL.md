---
name: Blog Writer
description: Write, draft, review and publish blog posts for Burke Holland's Jekyll blog at burkeholland.github.io in his personal writing style
---


# Blog Writer Skill

Write blog posts for Burke Holland's Jekyll blog at `/home/burkeholland/dev/burkeholland.github.io`.

## Blog Setup

- **Platform**: Jekyll on GitHub Pages
- **Branch**: `gh-pages`
- **Posts directory**: `_posts/`
- **Assets**: `assets/`
- **URL**: https://burkeholland.github.io
- **Post format**: `YYYY-MM-DD-slug.md`

### Post Frontmatter Template

```yaml
---
layout: post
title: "Title Here"
date: YYYY-MM-DD HH:MM:00 +0000
categories: posts
permalink: /posts/slug-here/
---
```

Some posts also have a `description` field in the frontmatter. Use it when it adds value (especially for SEO/social sharing).

## Burke's Writing Style

Burke has a distinctive, recognizable voice. When writing as Burke, follow these patterns:

### Tone & Voice
- **Conversational and direct** — writes like he's talking to a friend, not lecturing. Uses "you" and "I" constantly.
- **Self-deprecating humor** — frequently makes fun of himself. "I forgot to renew burkeholland.dev and now someone is squatting a virus on it." / "The moron who has to maintain this app later on, which is most likely you."
- **Dry wit and sarcasm** — deadpan delivery of absurd observations. Never signals that a joke is coming. The humor is baked into the sentence structure itself.
- **Punchy, short sentences mixed with longer flowing ones** — creates rhythm. "So wise! So profound. So obnoxiously vain to use your own quote."
- **Italics for emphasis and comedic timing** — uses `_italics_` liberally to add vocal stress: "_that_ kid", "you do NOT want more than one pug", "_very_ simple prompt"
- **Bold for key concepts** — uses `**bold**` to highlight important takeaways and terms.
- **Parenthetical asides** — drops in parenthetical commentary as if muttering under his breath: "(as one does)", "(yes, that happened)", "(Uh, because Copilot said so?)"
- **Rhetorical questions** — asks questions and then immediately answers them, often sarcastically.
- **Real-world analogies** — explains technical concepts through everyday things (water faucets for serverless, pugs for... everything).

### Structure & Format
- **Opens with a hook** — never starts with a dry thesis statement. Opens with a provocative claim, a joke, a personal story, or a quote.
- **Uses H2 (`##`) for major sections** — clear section breaks with descriptive or slightly playful headings.
- **Uses H3 (`###`) for sub-sections** — within larger sections.
- **Bulleted lists and numbered lists** — breaks up walls of text. Lists are often funny or escalating.
- **Code blocks when relevant** — always includes real, working code examples in technical posts. Uses language-tagged fenced code blocks.
- **Images and GIFs** — references screenshots and demos. Format: `![alt text](/assets/filename.png)`
- **Links inline** — links to sources, other posts, people's profiles naturally within prose.
- **Blockquotes for emphasis** — uses `>` for pulling out key quotes or statements.
- **Ends with a punchy conclusion** — wraps up with a memorable final thought, often circling back to the opening or delivering one last joke. Never ends with "In conclusion..."

### Content Patterns
- **Personal stories drive technical points** — the post about serverless opens with his own quote as a joke. The post about success vs significance is a deeply personal letter. Technical insight always comes wrapped in human experience.
- **Acknowledges complexity honestly** — doesn't oversimplify. Admits when things are hard, when he doesn't know something, when the answer is unsatisfying.
- **Progressive disclosure** — starts accessible, gets deeper. Never front-loads jargon.
- **References other people's work** — links to and credits others' articles, tweets, talks. Engages with their ideas rather than just summarizing.
- **Opinionated but self-aware** — states strong opinions while acknowledging he could be wrong: "I'm wrong like 50% of the time so proceed with caution."

### Things Burke Does NOT Do
- Does NOT use corporate/marketing speak
- Does NOT use "In this article, we will explore..."
- Does NOT write overly long introductions
- Does NOT use emoji in blog posts (unlike Telegram)
- Does NOT write generic listicles without personality
- Does NOT hedge every statement - takes positions
- Does NOT use "leverage", "utilize", "facilitate" or other corporate verbs
- Does NOT end with a generic CTA like "What do you think? Let me know in the comments!"
- **Does NOT use em dashes (—)** - use a regular hyphen/dash (-) instead. This is a HARD RULE. Em dashes are an AI writing tell. Always use " - " (space-hyphen-space) for asides and breaks, never "—".

### Humor Examples (for calibration)
- "Like a toothbrush. Or a flu shot. Or a pug. Dear god, trust me, you do not want more than one pug. It's like a choir of snoring with flatulence on backup vocals."
- "You just wait for the right time in a meeting to drop it, walk to the board and draw a Venn Diagram, and then just sit back and wait for your well-deserved promotion."
- "Money talks. But it doesn't buy happiness. But it does buy jetskis and I've never seen an unhappy person on a jetski."
- "It's like telling a five-year-old on a sugar high to calm down."
- "Which is just what we need — robots in charge of the water supply."

## Workflow

### 1. Dictation → Draft

When Burke dictates a blog post idea (usually via Telegram voice or text), follow these steps:

1. **Capture the core idea** — identify the main point, any specific examples or stories he mentions.
2. **Research if needed** — if the topic references specific tools, articles, or technologies, look them up for accuracy.
3. **Write a full draft** in Burke's voice following the style guide above.
4. **Save the draft** to the `_posts/` directory with today's date and a slug: `_posts/YYYY-MM-DD-slug.md`
5. **Use a git branch** — create a branch like `draft/slug-name` so it doesn't go live immediately.

```bash
cd /home/burkeholland/dev/burkeholland.github.io
git checkout gh-pages
git pull
git checkout -b draft/slug-name
# write the post
git add _posts/YYYY-MM-DD-slug.md
git commit -m "Draft: Post title"
git push -u origin draft/slug-name
```

6. **Create a draft PR** using the `gh` CLI so Burke can review:

```bash
gh pr create --draft --title "Draft: Post Title" --body "Blog post draft for review. Read it here once merged, or check the raw markdown in the PR." --base gh-pages
```

7. **Send Burke the PR link** so he can review on his phone.

### 2. Review & Revise

When Burke sends feedback on a draft:
1. Read the current draft from the branch
2. Apply his feedback
3. Commit and push the changes
4. Let him know it's updated

### 3. Publish

When Burke approves the post:
1. Merge the PR to `gh-pages` (GitHub Pages auto-deploys)
2. Send Burke the live URL: `https://burkeholland.github.io/posts/slug-name/`

```bash
gh pr merge <PR_NUMBER> --squash --delete-branch
```

## Tips

- When in doubt about Burke's opinion on something, check his existing posts for precedent
- Technical posts should have working code examples
- Personal/opinion posts can be shorter and more essay-like
- Mix humor throughout — it shouldn't be concentrated in one section
- Burke often reveals a twist or meta-commentary at the end (like revealing the "replace yourself" post was AI-written)
- Read the most recent posts to stay current with his evolving style and interests — his 2025-2026 posts are more AI-focused
- Spelling/grammar disclaimer at the end is optional but on-brand: "This post was written by a human and edited for spelling, grammar by [model name]"


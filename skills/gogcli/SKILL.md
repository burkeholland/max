---
name: Google (gogcli)
description: Access Gmail, Google Calendar, Drive, Contacts, Tasks, Sheets, Docs, and more via the gog CLI. Use when the user asks about email, calendar, files, contacts, or any Google service.
---

# Google CLI (gogcli)

Max can interact with Google services using the `gog` CLI tool. This covers Gmail, Calendar, Drive, Contacts, Tasks, Sheets, Docs, Slides, Forms, and more.

## Prerequisites

- `gog` must be installed: `brew install steipete/tap/gogcli`
- OAuth credentials must be stored: `gog auth credentials ~/path/to/client_secret.json`
- User must be authenticated: `gog auth add user@gmail.com`
- Check auth status: `gog auth status`

If `gog` is not installed or not authenticated, guide the user through setup.

## Important Flags

Always use these flags when running `gog` commands programmatically:

- `--json` or `-j` — JSON output (best for parsing results)
- `--plain` or `-p` — stable TSV output (good for simple lists)
- `--no-input` — never prompt for input (prevents hanging)
- `--force` or `-y` — skip confirmations for destructive commands
- `-a email@example.com` — specify which Google account to use

## Gmail

```bash
# Search emails (Gmail query syntax)
gog gmail search "is:unread" --json
gog gmail search "from:someone@example.com" --json
gog gmail search "subject:meeting is:unread newer_than:1d" --json

# Read a specific message
gog gmail get <messageId> --json

# Send an email
gog send --to "recipient@example.com" --subject "Hello" --body "Message body"
gog send --to "a@example.com" --cc "b@example.com" --subject "Hi" --body "Hello" --html

# Reply to a thread
gog gmail messages reply <messageId> --body "Reply text"

# List labels
gog gmail labels list --json

# Manage threads
gog gmail thread get <threadId> --json
gog gmail thread modify <threadId> --add-labels "STARRED"
gog gmail thread modify <threadId> --remove-labels "UNREAD"

# Drafts
gog gmail drafts list --json
gog gmail drafts create --to "user@example.com" --subject "Draft" --body "Content"
```

## Calendar

```bash
# List today's events
gog calendar events --json

# List events in a date range
gog calendar events --from "2025-01-01" --to "2025-01-31" --json

# List all calendars
gog calendar calendars --json

# Create an event
gog calendar create <calendarId> --summary "Meeting" --start "2025-01-15T10:00:00" --end "2025-01-15T11:00:00"

# Search events
gog calendar search "standup" --json

# Find conflicts
gog calendar conflicts --json

# RSVP to an event
gog calendar respond <calendarId> <eventId> --status accepted

# Free/busy check
gog calendar freebusy "user@example.com" --from "2025-01-15" --to "2025-01-16" --json
```

For calendar IDs: use `primary` for the user's main calendar, or the calendar's email address.

## Drive

```bash
# List files in root
gog ls --json

# List files in a folder
gog ls --parent <folderId> --json

# Search files
gog search "quarterly report" --json

# Download a file
gog download <fileId>
gog download <fileId> --output /path/to/save

# Upload a file
gog upload /path/to/file
gog upload /path/to/file --parent <folderId>

# Create a folder
gog drive mkdir "New Folder"
gog drive mkdir "Subfolder" --parent <folderId>

# Share a file
gog drive share <fileId> --email "user@example.com" --role writer

# Get file info
gog drive get <fileId> --json
```

## Contacts

```bash
# Search contacts
gog contacts search "John" --json

# List all contacts
gog contacts list --json

# Create a contact
gog contacts create --given-name "John" --family-name "Doe" --email "john@example.com"
```

## Tasks

```bash
# List task lists
gog tasks lists list --json

# List tasks in a list
gog tasks list <tasklistId> --json

# Add a task
gog tasks add <tasklistId> --title "Buy groceries"

# Complete a task
gog tasks done <tasklistId> <taskId>
```

## Sheets

```bash
# Read a sheet
gog sheets get <spreadsheetId> --json
gog sheets values <spreadsheetId> "Sheet1!A1:D10" --json

# Update cells
gog sheets update <spreadsheetId> "Sheet1!A1" --values '[["Hello","World"]]'
```

## Tips

- Use `gog whoami` to check which account is active
- The `--json` flag is your friend — always use it when you need to parse output
- Gmail search uses standard Gmail query syntax (same as the Gmail search bar)
- For calendar, `primary` is the default calendar ID
- Most list commands support `--limit` to control how many results to return
- Use `gog open <fileId>` to get a browser URL for any Google resource

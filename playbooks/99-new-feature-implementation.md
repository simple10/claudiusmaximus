# 99 - New Feature Implementation

Guidelines for Claude when implementing a planned feature.

## Overview

This playbook provides a structured process for implementing features that have been planned in `plans/`. It ensures consistent execution, tracking, and documentation.

## Prerequisites

- A plan file exists in `plans/<feature-name>.md`
- Plan has been approved by the user
- All prerequisites listed in the plan are satisfied

---

## Implementation Process

### 1. Read the Plan

Read the plan file from `plans/<feature-name>.md`. Understand:
- Target VPS(s)
- Prerequisites
- Implementation steps
- Verification criteria

### 2. Create Tracking File

Create `.state/tmp/<feature-name>.md` for command tracking:

```bash
mkdir -p .state/tmp
```

**Tracking File Format** (freeform):

```markdown
# Feature: <feature-name>
## Session: YYYY-MM-DD

### VPS-1
- `apt update` → success
- `docker compose up -d` → failed: port already in use
  - Fixed by stopping conflicting container
  - Retry: success

### VPS-2
- `systemctl enable prometheus` → success
```

The tracking file is for your reference during implementation. Use whatever format helps track progress and diagnose issues.

### 3. Execute Implementation

For each step in the plan:

1. Log the command to the tracking file
2. Execute the command
3. Record the result (success/failure)
4. On failure:
   - Log the error
   - Diagnose the issue
   - Attempt to fix
   - Record the fix and retry

Work through problems rather than stopping immediately. Notify the user if you're stuck or need input.

### 4. Run Verification

Execute all verification steps from the plan. Record results in the tracking file.

If verification fails:
- Diagnose the issue
- Fix and re-verify
- Document what was wrong and how it was fixed

### 5. Create Permanent Playbook

Once verified, create the permanent playbook:

**Base features:** `playbooks/XX-feature-name.md`
- Use next sequential number (check existing playbooks)
- Follow existing playbook template structure

**Optional features:** `playbooks/extras/feature-name.md`
- No number prefix
- Same template structure

**Playbook Template:**

```markdown
# XX - Feature Name

Brief description.

## Overview

What this playbook configures:
- Item 1
- Item 2

## Prerequisites

- [XX-prerequisite.md](XX-prerequisite.md) completed
- Other requirements

## Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `VAR_NAME` | Description | Yes/No |

---

## X.1 First Section

```bash
# Commands here
```

---

## X.2 Second Section

```bash
# Commands here
```

---

## Verification

```bash
# Verification commands
```

---

## Troubleshooting

### Issue Name

```bash
# Symptom: What the user sees
# Cause: Why it happens
# Solution: How to fix
```
```

### 6. Update Documentation

**Update `playbooks/README.md`:**
- Add new playbook to execution order (base features)
- Add to appropriate section (optional features)

**Update `CLAUDE.md`:**
- Add row to playbook table
- Update any affected sections

### 7. Cleanup

- Remove the tracking file from `.state/tmp/`
- Optionally archive the plan file (move to `plans/archived/`)

### 8. Summary

Present a summary to the user:

```
## Feature Complete: <feature-name>

**Playbook created:** playbooks/XX-feature-name.md

**What was configured:**
- VPS-1: ...
- VPS-2: ...

**Verification:** All checks passed

**Documentation updated:**
- playbooks/README.md
- CLAUDE.md
```

---

## Handling Failures

### Recoverable Failures

Most failures are recoverable:
- Port conflicts → stop conflicting service
- Permission denied → fix ownership/permissions
- Service won't start → check logs, fix config
- Network issues → verify firewall/WireGuard

Log the issue and fix in the tracking file, then continue.

### Blocking Failures

If you cannot proceed:

1. Document where you stopped in the tracking file
2. Notify the user with:
   - What failed
   - What you tried
   - What you need to proceed

The tracking file preserves progress for resumption.

---

## Notes

- The `.state/` directory is gitignored—tracking files are temporary
- Permanent playbooks follow existing conventions
- Troubleshooting sections are valuable—document issues you hit
- Keep the tracking file updated—it's your recovery point

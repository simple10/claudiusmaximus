# 99 - New Feature Planning

Guidelines for Claude when planning a new feature for the VPS deployment.

## Overview

This playbook provides a structured process for planning new features before implementation. It ensures features are properly designed, documented, and ready for execution.

## When to Use

Use this playbook when adding functionality that:
- Introduces a new service or component
- Modifies multiple existing playbooks
- Requires configuration changes across VPSs
- Adds integrations (monitoring, alerting, etc.)
- Changes security boundaries or networking

Use judgment—small fixes or single-file changes don't need formal planning.

---

## Planning Process

### 1. Enter Plan Mode

When the user requests a new feature, enter plan mode to research and design before implementation.

### 2. Ask Feature Type

Ask the user:

> "Is this a **base feature** (required for core deployment) or an **optional feature** (enhancement, not required)?"
>
> - **Base feature** → Will be numbered sequentially (e.g., `08-feature-name.md`)
> - **Optional feature** → Will go in `extras/` directory

### 3. Research and Design

- Review existing playbooks for patterns and dependencies
- Identify which VPS(s) the feature affects
- Determine prerequisites (which playbooks must complete first)
- Consider security implications
- Plan verification steps

### 4. Write Plan File

Create `plans/<feature-name>.md` using kebab-case naming.

**Required Structure:**

```markdown
---
feature: <feature-name>
type: base | optional
target-vps: VPS-1
playbook: playbooks/99-new-feature-implementation.md
---

# Plan: <Feature Name>

## Summary

Brief description of what this feature does and why.

## Prerequisites

- List of playbooks that must complete first
- Required external resources (accounts, credentials, etc.)

## Components

What will be installed/configured:
- Service X
- Configuration Y
- etc.

## Implementation Steps

1. Step one
2. Step two
3. etc.

## Configuration

Any variables or settings needed:
- `VAR_NAME` - Description

## Security Considerations

- Security implications
- Firewall changes needed
- Access control considerations

## Storage

- All persistent data MUST use bind mounts, never Docker named volumes
- Use `./data/<service>:/container/path` convention
- Set correct UID/GID ownership on host directories
- This ensures `rsync` can back up everything from the host filesystem

## Verification

How to verify the feature works:
1. Check A
2. Verify B
3. Test C

## Rollback

How to undo if needed:
1. Remove X
2. Restore Y
```

### 5. Exit Plan Mode

Present the plan to the user for approval. Do not proceed to implementation until approved.

---

## Plan File Location

All plan files go in the `plans/` directory at the repository root:

```
plans/
├── feature-name.md
├── another-feature.md
└── ...
```

The `plans/` directory is for working documents. After successful implementation, the plan is archived and the permanent playbook is created.

---

## Notes

- Keep plans focused on a single feature
- Include enough detail that implementation can proceed without ambiguity
- Verification criteria are critical—they define "done"
- The frontmatter `playbook:` field tells Claude which implementation playbook to follow

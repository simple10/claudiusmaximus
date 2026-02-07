# Plan: Fix Sandbox File Access for Browser Screenshots

See [](../../notes/webchat-media-files.md)

This plan is overkill. When I asked claude "wouldn't that be a security risk of all sandboxes could see each other's data?"...

With scope: "shared", the main concern is that all agents within the same gateway share one sandbox container and workspace.
  For your single-user deployment, this typically means the main agent and any sub-agents share one container — which they
  effectively already do since they collaborate on the same task.

  That said, there IS an alternative that preserves per-agent isolation:
How would you like to fix the sandbox file access for browser screenshots?

❯ 1. Shared scope (Recommended)
     Config-only change: set scope=shared + workspaceRoot=~/.openclaw. All agents share one sandbox container. Simple, no code
     patches. For a single-user deployment, the isolation loss is minimal — agents already collaborate on the same tasks.
  2. Build-time source patch
     Add a patch to build-openclaw.sh that modifies the sandboxed read tool to also allow the ~/.openclaw/media directory as a
     secondary root. Preserves per-agent sandbox isolation but adds another fragile patch that could break on upstream updates.
  3. Both / hybrid
     Start with the shared scope approach now (fastest fix), then optionally add a proper source patch later if isolation
     becomes important.
  4. Type something.

## Context

Browser screenshots and downloads are inaccessible from the webchat because the gateway's sandboxed read tool blocks access to files outside the sandbox root.

**The exact error** (from gateway logs):

```
[tools] read failed: Path escapes sandbox root (~/.openclaw/sandboxes/agent-main-0d71ad7a): /home/node/.openclaw/media/browser/23f0a7df-cea6-4e66-b99a-657e0c7721bf.png
```

**Root cause**: The browser tool captures screenshots via CDP and saves them to `~/.openclaw/media/browser/`. The sandboxed read tool restricts file access to within `sandboxRoot`, which is `~/.openclaw/sandboxes/agent-main-<hash>` (per-agent scope). The media directory is a sibling, not a child, of the sandbox root — so path resolution fails with "Path escapes sandbox root".

**Directory layout showing the problem**:

```
~/.openclaw/
├── openclaw.json
├── media/                     ← screenshots saved here by browser tool
│   └── browser/
│       └── xxx.png
├── sandboxes/                 ← DEFAULT_SANDBOX_WORKSPACE_ROOT
│   └── agent-main-0d71ad7a/  ← current sandboxRoot (per-agent scope)
│       └── ...                ← agent can only read under HERE
└── workspace/                 ← DEFAULT_AGENT_WORKSPACE_DIR
```

## Solution

Change two sandbox config settings in `openclaw.json` so that `sandboxRoot = ~/.openclaw`, which encompasses both the media directory and workspace:

1. **`scope: "shared"`** — makes `sandboxRoot = workspaceRoot` directly (instead of a per-agent subdirectory)
2. **`workspaceRoot: "/home/node/.openclaw"`** — sets the workspace root to the parent of both `media/` and `workspace/`

**After the change**:

```
~/.openclaw/                   ← NEW sandboxRoot (shared scope + workspaceRoot)
├── openclaw.json              ← readable by sandbox agent
├── media/                     ← NOW under sandboxRoot ✓
│   └── browser/
│       └── xxx.png            ← agent can read this ✓
├── sandboxes/
│   └── ...
└── workspace/
```

### Why this is the only viable configuration approach

The `resolveSandboxPath` function (loader line 5046) enforces that file paths must be under `sandboxRoot`:

```javascript
if (relative.startsWith("..") || path.isAbsolute(relative))
    throw new Error(`Path escapes sandbox root (...): ${params.filePath}`);
```

This operates on **logical paths**, not physical storage. Bind mounts, symlinks (blocked by `assertNoSymlink`), or alternative mount points don't change the path the browser tool returns (`~/.openclaw/media/browser/xxx.png`). The only fix is to make `sandboxRoot` encompass `~/.openclaw/media/`.

With `scope: "agent"` (current), `sandboxRoot` is always a subdirectory of `workspaceRoot` (`~/.openclaw/sandboxes/agent-main-<hash>`), so the media dir at `~/.openclaw/media/` is never a child. Only `scope: "shared"` makes `sandboxRoot = workspaceRoot` directly.

### Security implications

| Concern | Assessment |
|---------|-----------|
| Agent can read `openclaw.json` | Acceptable — API keys are in env vars, not in the config file. Config contains non-sensitive settings |
| Agent can read `devices/` | Low risk — device tokens are self-contained, no escalation path |
| Agent can read `media/` | This is the goal — screenshots and media files |
| Agent can write via exec tool | Same as before — exec already runs inside sandbox container with the workspace mounted |
| All sessions share one sandbox | Acceptable for single-user deployment. Faster startup (containers reused) |
| No per-session file isolation | Acceptable for single-user deployment |

The sandbox container itself still has full security hardening: `read_only`, `cap_drop: ALL`, `no-new-privileges`, `memory: 1g`, `pids_limit: 256`.

---

## Files to Modify

### 1. VPS-1: `openclaw.json` — Add scope and workspaceRoot

In `agents.defaults.sandbox`, add two fields:

```json
"sandbox": {
    "mode": "all",
    "scope": "shared",
    "workspaceRoot": "/home/node/.openclaw",
    ...rest stays the same
}
```

### 2. VPS-1: Remove stale per-agent sandbox containers

The old per-agent containers (`openclaw-sbx-agent-main-*`, `openclaw-sbx-browser-agent-*`) need to be removed since the new shared scope will create new containers with different names (`openclaw-sbx-shared`, `openclaw-sbx-browser-shared`):

```bash
sudo docker exec openclaw-gateway docker rm -f $(sudo docker exec openclaw-gateway docker ps -aq --filter label=openclaw.sandbox=1) 2>/dev/null || true
```

### 3. `playbooks/04-vps1-openclaw.md` — Update config section

In Section 4.8, update the `openclaw.json` template to include `scope` and `workspaceRoot`:

```json
"sandbox": {
    "mode": "all",
    "scope": "shared",
    "workspaceRoot": "/home/node/.openclaw",
    ...
}
```

Add a comment explaining why `scope: "shared"` is needed.

### 4. `playbooks/extras/sandbox-and-browser.md` — Update config section

Update Section E.4 to include the new settings and explain the rationale.

### 5. Memory files — Record the learning

Add to MEMORY.md:

- `scope: "shared"` + `workspaceRoot: "~/.openclaw"` required for browser screenshots to be accessible
- The sandboxed read tool checks paths against sandboxRoot — media directory must be under it
- `scope: "agent"` creates per-agent subdirectories under workspaceRoot, so media is never a child

---

## Deployment Steps

1. Update `openclaw.json` on VPS-1 (add `scope` and `workspaceRoot`)
2. Remove stale sandbox containers (old per-agent containers)
3. Restart the gateway (or wait for config hot-reload)
4. Test: send a message asking the agent to take a browser screenshot
5. Verify the screenshot is accessible in the webchat
6. Update playbooks locally
7. Update memory files

## Verification

```bash
# 1. Verify config applied
sudo cat /home/openclaw/.openclaw/openclaw.json | python3 -c "
import sys, json; cfg = json.load(sys.stdin)
sb = cfg['agents']['defaults']['sandbox']
print(f'scope: {sb.get(\"scope\")}')
print(f'workspaceRoot: {sb.get(\"workspaceRoot\")}')
assert sb.get('scope') == 'shared'
assert sb.get('workspaceRoot') == '/home/node/.openclaw'
"

# 2. Verify new shared sandbox containers created
sudo docker exec openclaw-gateway docker ps --filter label=openclaw.sandbox=1 --format '{{.Names}}'
# Expect: openclaw-sbx-shared, openclaw-sbx-browser-shared

# 3. Verify no old per-agent containers remain
sudo docker exec openclaw-gateway docker ps -a --filter label=openclaw.sandbox=1 --format '{{.Names}}' | grep -v shared
# Expect: no output

# 4. Functional test: ask the agent to take a browser screenshot via webchat
# Expect: screenshot displayed in the webchat without "Path escapes sandbox root" error

# 5. Check logs for any path errors
sudo docker logs openclaw-gateway 2>&1 | tail -50 | grep -i "escape\|sandbox root"
# Expect: no errors
```

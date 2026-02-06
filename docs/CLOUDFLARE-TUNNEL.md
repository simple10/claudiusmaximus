# Cloudflare Tunnel Setup for OpenClaw

This document describes how to secure OpenClaw behind Cloudflare Tunnel, eliminating the need to expose port 443 on the origin server.

## Why Cloudflare Tunnel?

| Before (Origin Exposed) | After (Tunnel) |
|------------------------|----------------|
| Port 443 open to internet | Port 443 closed |
| Origin IP discoverable | Origin IP hidden |
| Direct IP access possible | Direct IP access blocked |
| Cloudflare can be bypassed | All traffic through Cloudflare |

## Prerequisites

- Cloudflare account with your domain added
- Domain DNS managed by Cloudflare
- SSH access to VPS-1 (<adminclaw@15.204.xxx.xxx>, port 222)
- Cloudflare Access enabled in the Cloudflare account

## Architecture

```
┌─────────────────────────────────────────────────────────────-┐
│                         Internet                             │
│                                                              │
│    User ──► openclaw.yourdomain.com ──► Cloudflare Edge      │
│                                              │               │
│                                    Cloudflare Access         │
│                                        (auth check)          │
│                                              │               │
└──────────────────────────────────────────────┼───────────────┘
                                               │
                              Encrypted Tunnel (outbound)
                                               │
┌──────────────────────────────────────────────┼───────────────┐
│  VPS-1 (Origin - No inbound ports needed)    │               │
│                                              ▼               │
│    cloudflared ◄─────────────────────────────┘               │
│        │                                                     │
│        ▼                                                     │
│    localhost:18789 (OpenClaw Gateway)                        │
│                                                              │
│    Port 443: CLOSED                                          │
│    Port 80:  CLOSED                                          │
└──────────────────────────────────────────────────────────────┘
```

## Installation Steps

Claude performs the setup of the tunnels in the [networking/cloudflare-tunnel.md](../playbooks/networking/cloudflare-tunnel.md) playbook.

1. Claude creates two tunnels: one for each VPS
2. Claude prompts user to authorize the tunnel with a link during setup

After deployment, user needs to configure Cloudflare Access (see below).

---

## Cloudflare Access Configuration

These steps need to be completed by the user to authorize Cloudflare Access users to access the services through the tunnel.

After the tunnel is working, add authentication via Cloudflare Access:

**In Cloudflare Dashboard:** [cloudflare.com](https://one.dash.cloudflare.com/)...

### Step 1: Create an Access Application

This is where you put the lock on the door.

1. Go to **Zero Trust Dashboard** → **Access** → **Applications**
2. Click **Add an application** → choose **Self-hosted**
3. Configure the application:

| Field                | Value                              |
| -------------------- | ---------------------------------- |
| **Application name** | e.g. `OpenClaw`                      |
| **Session duration** | Choose based on your needs (e.g. `24h`) |
| **Application domain** | `openclaw.example.com`              |
| **Path** (optional)  | Leave blank to protect the entire subdomain, or set a specific path like `/_openclaw/` |

1. Click **Next**

---

### Step 2: Define an Access Policy

Policies control who gets through. You need at least one **Allow** policy.

1. **Policy name:** e.g. `Allow team members`
2. **Action:** `Allow`
3. **Configure rules** — add one or more *Include* conditions:

**Common Identity Rules:**

| Selector | Example | Use case |
| --- | --- | --- |
| **Emails** | `alice@example.com` | Allow specific individuals |
| **Emails ending in** | `@example.com` | Allow an entire domain |
| **Identity provider groups** | Google Workspace group, Okta group, etc. | Team-based access |
| **Everyone** | — | Allow all authenticated users (still forces login) |
| **IP ranges** | `203.0.113.0/24` | Network-based access |

You can also add **Require** rules (user must match *all* of these) and **Exclude** rules (deny even if other rules match).

#### Example: Allow Anyone with a Company Email

- **Include:** Emails ending in `@yourcompany.com`

#### Example: Restrict to Specific People + Require Country

- **Include:** Emails — `alice@example.com`, `bob@example.com`
- **Require:** Country — `United States`

1. Click **Next** → review → **Add application**

---

### Step 3: Configure an Identity Provider (if not already done)

Access needs at least one IdP to authenticate users. If you haven't set one up:

1. Go to **Zero Trust Dashboard** → **Settings** → **Authentication**
2. Under **Login methods**, click **Add new**
3. Choose a provider — common options:
   - **One-time PIN** (simplest — Cloudflare emails a code, no external IdP needed)
   - **Google**
   - **GitHub**
   - **Okta / Azure AD / SAML**
4. Follow the provider-specific setup (OAuth client ID/secret, etc.)

The **One-time PIN** option is great for getting started quickly — it requires zero external configuration.

#### Step 4: Verify the Your Tunnel Config

Claude should have already setup the published application routes if domains were added to
openclaw-config.env before deploying.

**Dashboard (Zero Trust → Networks → Tunnels):**

1. Go to **Zero Trust Dashboard** → **Networks** → **Tunnels**
2. For each tunnel → **Edit** → **Published application routes** tab
3. Verify a route exists and looks correct

If asked to `Migrate` the tunnel to the Dashboard, accept. No need to modify any configuration here.
Migrating to the Dashboard simply makes it easier to manage routes from the Cloudflare Dashboard
instead of via the server config.

#### Step 5: Test Access Protection

1. Open `https://openclaw.yourdomain.com/_openclaw/` in an incognito window
2. You should see the Cloudflare Access login page
3. Authenticate with your configured method
4. You should now see the OpenClaw UI

## Maintenance

The cloudflare-tunnel.md playbook does not setup autoupdate for the cloudflare tunnel daemon.
This is by design to avoid breaking changes.

To update the tunnel, ask claude to update it. There are instructions for claude in the playbook.

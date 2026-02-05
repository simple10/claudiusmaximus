# Ongoing Tasks to work on / fix

All tasks completed. Ready for fresh deployment.

## Completed

- [x] Change default SSH port to 222
  - Updated SSH hardening config
  - Added systemd socket override for Ubuntu socket activation
  - Updated UFW, Fail2ban, and all documentation
- [x] Ensure SSH user login is disabled; only allow SSH keys
  - `PasswordAuthentication no`
  - `UsePAM yes` (MUST be yes on Ubuntu for proper auth)
- [x] Change the default HTTP endpoints for any publicly accessible service
  - Grafana: `/_observe/grafana/`
  - OpenClaw: `/_openclaw/`
- [x] Update CLAUDE.md install instructions to reboot each VPS after completing installs
  - Added Phase 6.5 with reboot instructions
- [x] Fix user password issue - prompt for password instead of random generation
  - User sets password via `sudo passwd openclaw`
  - Passwordless sudo granted via `/etc/sudoers.d/openclaw`
- [x] Fix SSH port change order
  - UFW allows port 222 BEFORE SSH config is changed
  - Port 22 kept as fallback until 222 is verified
  - Both socket override AND sshd config updated

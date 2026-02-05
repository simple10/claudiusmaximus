# Ongoing Tasks to work on / fix

- [ ] Change default SSH port, update docs to reflect the change
- [ ] Ensure SSH user login is disabled; only allow SSH keys
- [ ] Change the default HTTP endpoints for any publicly accessible service
  The goal here to protect against bot scrapers that search for common URL paths for applications.
  Minimally, nest the apps in subdir paths.
  - [ ] Grafana: '/' => '/_observe/grafana'
  - [ ] OpenClaw: '/chat' => '/_openclaw/chat'
  - [ ] ... any others?
- [ ] Update CLAUDE.md install instructions to reboot each VPS after completing installs and before running full tests

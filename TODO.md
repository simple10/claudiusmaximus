# TODO

- [ ] Harden openclaw gateway container with --read-only or --cap-drop=ALL, after:
  - Current state has been fully tested and is functional
  - Self-modification loop has been fully tested
  - Then try hardening and see if openclaw can still do all the normal tasks

- [ ] Re-run from scratch once OTEL is working
- [ ] Start using OpenClaw
  - [ ] Verify it can make modifications

- [ ] Flesh out where OpenClaw data lives - add R2 backend?

- [ ] Scrub git for openclaw-config.env
- [ ] Squash commit to clean up history with new messages
- [ ] Push to github

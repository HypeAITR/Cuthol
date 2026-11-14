# Security policy

## Supported versions

Security fixes go into the latest released version (see [CHANGELOG.md](CHANGELOG.md)). Please update before reporting.

## Reporting a vulnerability

Please **do not open a public issue** for a security problem. Use GitHub's private reporting instead: **Security → Report a vulnerability** on this repository. Include what you found, how to reproduce it, and what an attacker could do with it.

You will get an answer within 7 days. When a fix is ready we publish a release and credit you in the release notes unless you prefer otherwise.

## Scope notes

- Cuthol runs locally and reads and writes files inside the project folder you give it. Paths that escape the project (for example a LUT path) are rejected.
- **Cuthol Live** serves the preview window on `127.0.0.1` only, with a per-session token, `Host` and `Origin` checks, and `frame-ancestors 'self'`. Anything that lets another site or another local user read or change a project through it is in scope.
- API keys (`DEEPGRAM_API_KEY`, `ELEVENLABS_API_KEY`) are read from the environment or a project `.env` and are never printed; `cuthol doctor` reports presence only. A key that shows up in any output, log or project file is a vulnerability.
- Extensions are code you choose to run. Problems that require installing a malicious extension are out of scope, but ways for a project file alone to run code are in scope.

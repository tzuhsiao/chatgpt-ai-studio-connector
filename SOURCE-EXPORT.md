# Source export

- Application: AI Studio Connector v1.6.3.
- Hosted Site version: 15.
- Original source commit: `cb34b0bfbe956fd4db26d63d6a36bd434920b17e`.
- Export date: 2026-10-24 (America/Los_Angeles).
- Current tracked source snapshot only; original Git history and Git configuration are not included.
- `tsconfig.tsbuildinfo` is omitted as generated compiler metadata.
- Runtime code, dependency versions, lockfile and existing Site project identity are preserved byte for byte.
- README setup/deployment guidance is clarified and the obsolete statement that background/video features are absent is corrected.
- `.gitignore` additionally excludes `.dev.vars*` and `*.tsbuildinfo`.
- This note is added for provenance.

## Configuration and data

`GEMINI_API_KEY` belongs in Sites Settings as a secret. `OWNER_EMAIL` must match the owner account; missing configuration fails closed. Keep the existing Site owner-private. `.openai/hosting.json` retains the existing non-secret project ID so maintenance continues to target the same Site. Committing or uploading these files does not itself deploy anything.

No environment-secret files, credentials, dependency tree, local tool state, database contents, uploaded/generated media, logs or previous Git history are included. SQL migrations and schema snapshots are source definitions, not private database records.

## Authentication boundary

This implementation trusts authenticated identity headers installed by the Sites ingress. It is not a standalone internet authentication system. Moving hosting requires an ingress that verifies identity and strips/replaces caller-supplied identity headers, or an application authentication redesign. Do not publish a raw application endpoint that trusts arbitrary headers.

## Verification scope

The recovered current source received offline static security review, including an independent baseline and a focused provider/spending review. The separate security report records findings and limitations. Export verification checks source differences, excluded paths, credential patterns and ZIP bytes. No live generation or Google credential validation was performed. Existing tests were inspected but not rerun in this export environment; dependency internals and current vulnerability advisory databases were not audited.

# Contributing to Cuthol

Thanks for helping. Cuthol is an editor for AI agents, so a good change makes an agent's job shorter, clearer or safer, and comes with proof that it works.

## Before you start

- Open an issue first for anything larger than a small fix, so we can agree on the shape before you write it.
- Read [`src/ARCHITECTURE.md`](src/ARCHITECTURE.md) (where things live) and [`AGENTS.md`](AGENTS.md) (rules coding agents follow here; they apply to people too).
- Requirements: Node.js ≥ 22.5, `ffmpeg`/`ffprobe` 8.x, a Chrome/Chromium for motion graphics. `npx cuthol doctor` checks them.

## Build and test

```bash
npm ci
npm run build
npm test
```

`npm test` runs every test file in two stages (parallel-safe files first, then timing-sensitive ones). Tests that need larger recorded projects, real footage or speech API keys are skipped with a reason when those are missing; they never fail for that. One file: `node --import ./dist/test/test_setup.js --test dist/test/<name>.test.js`.

## What a good pull request has

- **One purpose.** One feature or one fix, with a clear English title (`feat(color): …`, `fix(render): …`).
- **A reproducible check.** A test that fails before your change and passes after it. For picture or sound changes also a rendered frame, a render-plan diff or a measurement; say how you made it.
- **No silent results.** When something cannot be done, return a diagnostic (`[CUTHOL-Gxxx] what happened | Suggestion: next step`, see `src/core/diagnostics.ts`) instead of a quiet fallback.
- **Short agent output.** Command results are read by models; keep them to the lines an agent needs.
- **No loosened tests.** If a threshold looks wrong, show the measurement that proves it.
- **Independent work.** Do not copy code, names or internals from other video editors. Use open standards and public library documentation.
- New child processes pass `windowsHide: true` (Windows opens a console window otherwise).

## Extensions first

Niche tools, effects, transitions, providers and presets usually belong in an [extension](examples/extensions) rather than in the core. If you are unsure, ask in the issue.

## Licence

By contributing you agree that your contribution is released under the [MIT licence](LICENSE).

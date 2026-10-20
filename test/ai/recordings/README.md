# Recordings

Recorded live runs of the AI steps, written by `npm run eval` and replayed by `replay.test.ts` (#85). The layout is `<task>/<fixture>/<model>.json`. Each file holds only what replay needs: the output, token usage, cost, model and the input hash (`../recording.ts`).

Don't edit a recording by hand. When `npm test` reports one as stale, its model input changed. Re-record it with the command in the error, after asking (AGENTS.md), or delete it.

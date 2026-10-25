# Recordings

Recorded live runs of the AI steps, written by `npm run eval:live` and replayed by `replay.test.ts` (#85). The layout is `<task>/<fixture>/<model>.json`. Each file holds only what replay needs: the output, token usage, cost, model and the two input hashes (`../recording.ts`, #131).

Don't edit a recording by hand. When `npm test` fails one as unusable, the fixture's planner input or graph changed, or its plan no longer parses. When it warns that one is out of date, the prompt or the skill changed; that doesn't fail `npm test`, but `npm run eval:check-current` fails on it before a milestone or release. Either way, re-record it with the command in the message, after asking (AGENTS.md), or delete it.

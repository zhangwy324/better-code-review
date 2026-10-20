// `npm run eval`: live, budget-capped runs of the AI steps (test/ai/eval.ts, #85). This spends
// real AI usage; it is never part of `npm run check` or CI.
import { EVAL_USAGE, EvalUsageError, parseEvalArgs, runEval } from '../test/ai/eval.ts';

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
  process.stdout.write(EVAL_USAGE);
  process.exit(0);
}
let args;
try {
  args = parseEvalArgs(argv);
} catch (err) {
  const usage =
    err instanceof EvalUsageError || (err as { code?: string }).code?.startsWith('ERR_PARSE_ARGS');
  if (!usage) throw err;
  console.error(`${(err as Error).message}\n\n${EVAL_USAGE}`);
  process.exit(2);
}
const ok = await runEval(args, { out: (text) => process.stdout.write(text) });
process.exitCode = ok ? 0 : 1;

import { runStage, formatStage } from './stage-own.mjs';

export function makeStageVerb({ EXIT, RESULT, HERE }) {
  return async function cmdStage(rest) {
    const dryRun = rest.includes('--dry-run');
    let assume = [];
    const ai = rest.indexOf('--assume');
    if (ai >= 0 && rest[ai + 1] && !String(rest[ai + 1]).startsWith('-')) {
      assume = String(rest[ai + 1]).split(',').map((s) => s.trim()).filter(Boolean);
    }
    const r = runStage({ cwd: HERE, dryRun, assume });
    RESULT.data.stage = r;
    console.log(formatStage(r));
    return r.ok ? EXIT.ok : EXIT.accept;
  };
}
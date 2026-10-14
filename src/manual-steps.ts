import { join } from 'node:path';
import { json, saveJSON, current, readRelease, activeVersion } from './core.ts';
import type { Release } from './core.ts';

// One manual step: Cursor keeps the policy in User Rules, inside the Cursor app. No tool can read or write that setting.
// The record below is the user's own statement that they pasted a release. It is not proof that Cursor loaded it.
const STEP='cursor-user-rules';
export type ManualStep={id:typeof STEP;needed:boolean;confirmedVersion:string|null;activeVersion:string;instruction:string};
type Confirmation={version:string;digest:string;confirmedAt:string};
const file=(root:string)=>join(root,'.state','manual-steps.json');
const absent=(e:unknown)=>(e as NodeJS.ErrnoException).code==='ENOENT';
const confirmations=(root:string)=>json<Record<string,Confirmation>>(file(root)).catch(e=>{if(absent(e))return {} as Record<string,Confirmation>;throw e;});

export async function cursorUserRules(root:string,active:Pick<Release,'version'|'digest'>):Promise<ManualStep> {
  const confirmed=(await confirmations(root))[STEP];
  return {id:STEP,needed:!confirmed||confirmed.version!==active.version||confirmed.digest!==active.digest,confirmedVersion:confirmed?.version??null,activeVersion:active.version,
    instruction:`Paste the full content of ${join(root,'releases',active.version,'cursor','user-rules.md')} into Cursor > Customize > Rules > User Rules, in the rule named "Agentic Harness". Then run: npm run harness -- confirm ${STEP}`};
}
// Added to command output at the moment the rules change. Empty when the step is done or no release is active.
export async function reminder(root:string):Promise<{manualSteps?:ManualStep[]}> {
  if(!await activeVersion(root))return {};
  const step=await cursorUserRules(root,await current(root));
  return step.needed?{manualSteps:[step]}:{};
}
export async function confirmStep(root:string,step:string,version?:string) {
  if(step!==STEP)throw new Error(`Unknown manual step. Use: confirm ${STEP} [--version VERSION]`);
  const r=version?await readRelease(root,version).catch(e=>{if(absent(e))throw new Error(`Release ${version} is not in releases/. Nothing was recorded.`);throw e;}):await current(root);
  const record:Confirmation={version:r.version,digest:r.digest,confirmedAt:new Date().toISOString()};
  await saveJSON(file(root),{...await confirmations(root),[STEP]:record});
  return {confirmed:STEP,...record,note:'Recorded your statement. No tool can read Cursor User Rules; a fresh Cursor chat that names this release is the only proof.',...await reminder(root)};
}

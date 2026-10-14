import {readFile} from 'node:fs/promises';
import {join,dirname,resolve} from 'node:path';
import {parseEnv} from 'node:util';
import {fileURLToPath} from 'node:url';

// Engine code (src/, catalog/) lives here. User content (knowledge, config, releases, .state) lives in the harness root, which defaults to the same folder.
export const CODE_ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
export function harnessRoot(args:string[]=[]){const i=args.indexOf('--root');if(i>=0&&!args[i+1])throw new Error('Missing --root DIR.');return resolve(i>=0?args.splice(i,2)[1]:process.env.HARNESS_ROOT||CODE_ROOT);}

export async function loadEnv(root:string, runtime=false) {
  // Retrieval processes never load publishing credentials.
  const file=runtime?'.env.runtime':'.env.local';
  try {
    const values=parseEnv(await readFile(join(root,file),'utf8'));
    for(const [key,value] of Object.entries(values))if(process.env[key]===undefined)process.env[key]=value;
  }catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
}
export function env(key:string){const value=process.env[key];if(!value)throw new Error(`Missing ${key}. See docs/retrieval.md; do not paste secrets into chat.`);return value;}

import { join } from 'node:path';
import { readFile, readdir } from 'node:fs/promises';

// Setup bar: the file-level checks that any repo can pass without network access.
// Review before merge (check 5) is a way of working, and green CI on main needs GitHub, so neither is checked here.
type Check={id:string;title:string;ok:boolean;detail:string};
const text=(dir:string,path:string)=>readFile(join(dir,path),'utf8').catch(()=>null);
async function workflows(dir:string){
  const folder=join(dir,'.github','workflows'), names=await readdir(folder).catch(()=>[] as string[]);
  return Promise.all(names.filter(n=>/\.ya?ml$/.test(n)).map(async n=>({name:n,body:(await text(folder,n))??''})));
}
const triggers=(body:string)=>{
  const on=body.match(/^on:(.*(?:\n[ \t].*)*)/m)?.[1]??'';
  return /push/.test(on)&&/pull_request/.test(on);
};
export async function repoBar(dir:string) {
  const flows=await workflows(dir), has=async(...paths:string[])=>(await Promise.all(paths.map(p=>text(dir,p)))).some(t=>t!==null);
  const settings=await text(dir,'.claude/settings.json');
  let deny=0;try{deny=(JSON.parse(settings??'{}').permissions?.deny??[]).length;}catch{}
  const checks:Check[]=[
    {id:'ci',title:'CI runs on push and pull request',ok:flows.some(f=>triggers(f.body)),detail:flows.filter(f=>triggers(f.body)).map(f=>f.name).join(', ')||'no workflow with both triggers'},
    {id:'secret-scan',title:'Secret scan in CI',ok:flows.some(f=>/gitleaks|trufflehog/i.test(f.body)),detail:'looks for gitleaks or trufflehog in a workflow'},
    {id:'token',title:'Every workflow sets permissions',ok:flows.length>0&&flows.every(f=>/^permissions:/m.test(f.body)),detail:flows.filter(f=>!/^permissions:/m.test(f.body)).map(f=>`missing in ${f.name}`).join(', ')||'top-level permissions in each workflow'},
    {id:'updates',title:'Dependency updates',ok:await has('.github/dependabot.yml','.github/dependabot.yaml','renovate.json','.github/renovate.json'),detail:'Dependabot or Renovate config'},
    {id:'docs',title:'SECURITY.md and CONTRIBUTING.md',ok:await has('SECURITY.md','.github/SECURITY.md')&&await has('CONTRIBUTING.md','.github/CONTRIBUTING.md'),detail:'repo root or .github/'},
    {id:'agent-controls',title:'Agent deny rules in the repo',ok:deny>0,detail:`.claude/settings.json permissions.deny: ${deny} rule(s)`},
    {id:'owners',title:'CODEOWNERS and a pull request template',ok:await has('.github/CODEOWNERS','CODEOWNERS')&&await has('.github/pull_request_template.md','.github/PULL_REQUEST_TEMPLATE.md','PULL_REQUEST_TEMPLATE.md'),detail:'repo root or .github/'},
  ];
  return {checks,passed:checks.filter(c=>c.ok).length,total:checks.length,ok:checks.every(c=>c.ok)};
}

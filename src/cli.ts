import { join } from 'node:path';
import { readdir } from 'node:fs/promises';
import { loadSnapshot,digest,publish,current,activate,readRelease,localSearch,chunks,json } from './core.ts';
import {install,verifyInstall,uninstall} from './install.ts';
import {cursorUserRules,reminder,confirmStep} from './manual-steps.ts';
import {repoInstall,repoVerify,repoUninstall} from './repo.ts';
import {repoBar} from './repo-bar.ts';
import {previewPack,addPack,removePack,listPacks,buildCatalog} from './packs.ts';
import {scanRules} from './rules.ts';
import {contextAudit} from './context.ts';
import {evalCommand} from './evals.ts';
import {controlsInstall,controlsVerify,controlsUninstall,loadControls} from './controls.ts';
import {previewRules,applyRules,undoRules,verifyRules,retireRule,ignoreFinding,unignoreFinding} from './rules-apply.ts';
import {loadEnv,harnessRoot,CODE_ROOT} from './env.ts';
import {importNotion,importPluginExport} from './notion.ts';
import {indexRelease,vectorSearch} from './supabase.ts';
import type {EmbeddingBatch} from './supabase.ts';
import type {Config} from './core.ts';

const args=process.argv.slice(2), root=harnessRoot(args), command=args[0];
function option(name:string){const i=args.indexOf(name);return i>=0?args[i+1]:undefined;}
function required(value:string|undefined,label:string){if(!value)throw new Error(`Missing ${label}. Run help.`);return value;}
const output=(v:unknown)=>console.log(JSON.stringify(v,null,2));
try {
  await loadEnv(root,command==='search-vector');
  switch(command){
    case 'export-chunks': output(chunks((await readRelease(root,required(args[1],'version'))).documents));break;
    case 'index': {const r=await readRelease(root,required(args[1],'version'));await indexRelease(r,await json<EmbeddingBatch>(required(option('--embeddings'),'--embeddings FILE')));output({indexed:r.version});break;}
    case 'search-vector': {output({mode:'supabase-vector',release:args[1],results:await vectorSearch(required(args[1],'version'),required(args[2],'model'),await json<number[]>(required(args[3],'vector JSON file')),option('--domain'))});break;}
    case 'import-notion': output(await importNotion(root));break;
    case 'import-notion-export': output(await importPluginExport(root,required(args[1],'export JSON file')));break;
    case 'preview': {const s=await loadSnapshot(root);output({digest:digest(s),provenance:s.provenance,core:s.core,documents:s.documents.map(({content,...d})=>({...d,characters:content.length}))});break;}
    case 'publish': {const r=await publish(root,required(args[1],'version'),required(option('--approve-sha'),'--approve-sha'),args.includes('--bootstrap'));output({version:r.version,digest:r.digest,provenance:r.provenance,remoteIndex:'not uploaded; use index command',github:'local release only; commit and push after review',...await reminder(root)});break;}
    case 'activate': case 'rollback': {await activate(root,required(args[1],'version'));output({active:args[1],next:'Run install for registered platforms. Running sessions keep their previous context.',...await reminder(root)});break;}
    case 'install': {const r=await install(root,required(args[1],'platform'),undefined,option('--version'));output(r.platform==='cursor-files'?{...r,...await reminder(root)}:r);break;}
    case 'verify': output(await verifyInstall(root,required(args[1],'platform')));break;
    case 'uninstall': output(await uninstall(root,required(args[1],'platform')));break;
    case 'confirm': output(await confirmStep(root,required(args[1],'manual step'),option('--version')));break;
    case 'pack': {
      const platform=()=>required(option('--platform'),'--platform');
      if(args[1]==='add'&&option('--approve-sha'))output(await addPack(root,required(args[2],'AUTHOR/ID@VERSION'),platform(),option('--approve-sha')!));
      else if(args[1]==='add'){const {block,...p}=await previewPack(root,required(args[2],'AUTHOR/ID@VERSION'),platform());console.log(`Preview only. Nothing was written.\n\n${JSON.stringify(p,null,2)}\n\n${p.afterLine===undefined?`This file will be created at ${p.target}:`:`This block will be inserted after line ${p.afterLine} of ${p.target}:`}\n\n${block}\n\nRead every line. To install exactly this text, run:\nnpm run harness -- ${p.approve}`);}
      else if(args[1]==='remove')output(await removePack(root,required(args[2],'AUTHOR/ID'),platform()));
      else if(args[1]==='list')output(await listPacks(root));
      else throw new Error('Unknown pack command. Run help.');
      break;
    }
    case 'repo': {
      const path=()=>required(args[2]?.startsWith('--')?undefined:args[2],'PATH'),dryRun=args.includes('--dry-run');
      if(args[1]==='install')output(await repoInstall(root,path(),{version:option('--version'),adopt:args.includes('--adopt'),pointer:args.includes('--pointer'),dryRun}));
      else if(args[1]==='verify'){const v=await repoVerify(path());output(v);if(!v.configurationVerified)process.exitCode=1;}
      else if(args[1]==='uninstall')output(await repoUninstall(root,path(),{dryRun}));
      else if(args[1]==='bar'){const b=await repoBar(path());output(b);if(!b.ok)process.exitCode=1;}
      else throw new Error('Unknown repo command. Run help.');
      break;
    }
    case 'controls': {
      const platform=()=>required(args[2],'PLATFORM');
      if(args[1]==='install')output(await controlsInstall(root,platform()));
      else if(args[1]==='verify'){const v=await controlsVerify(root,platform());output(v);if(!v.configurationVerified)process.exitCode=1;}
      else if(args[1]==='uninstall')output(await controlsUninstall(root,platform()));
      else if(args[1]==='list')output((await loadControls()).controls);
      else throw new Error('Unknown controls command. Run help.');
      break;
    }
    case 'catalog': if(args[1]!=='build')throw new Error('Unknown catalog command. Run help.');output(await buildCatalog(root));break;
    case 'rules': {
      const ids=args.slice(2).filter((a,i,all)=>a!=='--approve-sha'&&all[i-1]!=='--approve-sha');
      if(args[1]==='scan'){const {ignored,...s}=await scanRules(root);output({...s,rules:s.rules.map(({text,body,...r})=>r),ignoredCount:ignored.length,...(args.includes('--show-ignored')?{ignored}:{})});}
      else if(args[1]==='preview'){const p=await previewRules(root,ids);console.log(`Preview only. Nothing was written.\n\n${p.proposals.map(x=>`${x.action} ${x.id}\n  ${x.reason}`).join('\n')}\n\n${p.packs.map(a=>`${a.exists?'reuse':'create'} local pack ${a.pack.id}@${a.pack.version} in ${a.dir} (pack digest ${a.pack.digest}), installed on ${a.pack.platforms.join(', ')}. rules.md:\n\n${a.pack.rules}\n`).join('\n')}${p.changes.map(c=>`${c.change} ${c.path}`).join('\n')}\n\n${p.diff}\nDigest: ${p.digest}\n\nRead every line. To apply exactly these changes, run:\nnpm run harness -- ${p.approve}`);}
      else if(args[1]==='apply')output(await applyRules(root,ids,required(option('--approve-sha'),'--approve-sha DIGEST')));
      else if(args[1]==='undo')output(await undoRules(root,required(args[2],'receipt ID or apply ID')));
      else if(args[1]==='verify')output(await verifyRules(root));
      else if(args[1]==='retire')output(await retireRule(root,required(args[2],'receipt ID'),required(option('--reason'),'--reason TEXT')));
      else if(args[1]==='ignore')output(await ignoreFinding(root,required(args[2],'finding ID'),required(option('--reason'),'--reason TEXT')));
      else if(args[1]==='unignore')output(await unignoreFinding(root,required(args[2],'finding ID')));
      else throw new Error('Unknown rules command. Run help.');
      break;
    }
    case 'context': if(args[1]!=='audit')throw new Error('Unknown context command. Run help.');output(await contextAudit(root,{save:args.includes('--save'),claudeContext:args.includes('--claude-context')?required(option('--claude-context'),'--claude-context FILE'):undefined}));break;
    case 'eval': {const e=await evalCommand(root,args);output(e.value);if(e.failed)process.exitCode=1;break;}
    case 'status': {
      let active;try{active=await current(root);}catch{}
      const names=await readdir(join(root,'.state/installations')).catch(()=>[]);
      const config=await json<Config>(join(root,'harness.config.json'));
      output({root,activeVersion:active?.version??null,next:active?undefined:'No active release. Run activate VERSION for a release in releases/, or run preview, then publish NEW_VERSION --approve-sha DIGEST --bootstrap.',source:active?.provenance,installations:await Promise.all(names.filter(n=>n.endsWith('.json')&&!n.startsWith('controls-')).map(n=>verifyInstall(root,n.slice(0,-5)))),manualSteps:active?[await cursorUserRules(root,active)]:[],notion:{pagesMapped:!!config.coreNotionPageId&&config.documents.every(d=>d.notionPageId),apiTokenPresent:!!process.env.NOTION_TOKEN,activeReleaseImported:!!active&&/^notion-(import|plugin-export):/.test(active.provenance)},rules:await verifyRules(root),controls:await controlsVerify(root,'claude'),supabase:!!process.env.SUPABASE_URL,grokBot:'Requires profile and cloud-computer installation; see docs/platforms.md'});break;
    }
    case 'search': {const r=option('--release')?await readRelease(root,option('--release')!):await current(root);output({mode:'local-keyword',release:r.version,results:localSearch(r,required(args[1],'query'),5,option('--domain'))});break;}
    case 'get-document': {const r=option('--release')?await readRelease(root,option('--release')!):await current(root);const d=r.documents.find(d=>d.id===args[1]);if(!d)throw new Error('Document not found in this release.');output({release:r.version,...d});break;}
    default: console.log(`Agentic Harness\n\npreview\nimport-notion\nimport-notion-export FILE\nexport-chunks VERSION\nindex VERSION --embeddings FILE\nsearch-vector VERSION MODEL VECTOR_JSON_FILE [--domain engineering]\npublish VERSION --approve-sha DIGEST [--bootstrap]\nactivate VERSION\ninstall codex|claude|cursor-files|generic [--version VERSION]\nverify PLATFORM\nuninstall PLATFORM\nconfirm cursor-user-rules [--version VERSION]\nrepo install PATH [--version VERSION] [--adopt] [--pointer] [--dry-run]\nrepo verify PATH\nrepo uninstall PATH [--dry-run]\nrepo bar PATH\ncontrols list\ncontrols install|verify|uninstall claude\npack add AUTHOR/ID@VERSION --platform claude|codex|cursor [--approve-sha DIGEST]\npack remove AUTHOR/ID --platform claude|codex|cursor\npack list\ncatalog build\nrules scan [--show-ignored]\nrules preview PROPOSAL_ID...\nrules apply PROPOSAL_ID... --approve-sha DIGEST\nrules undo RECEIPT_ID|APPLY_ID\nrules verify\nrules retire RECEIPT_ID --reason TEXT\nrules ignore FINDING_ID --reason TEXT\nrules unignore FINDING_ID\ncontext audit [--save] [--claude-context FILE]\neval list\neval run --platform claude|codex|cursor --case ID [--keep] [--no-log] [--trials N]\neval results [--case ID] [--platform P] [--last N]\neval compare VERSION_A [VERSION_B] [--platform P]\nstatus\nsearch "QUERY" [--release VERSION] [--domain engineering]\nget-document ID [--release VERSION]\nrollback VERSION\n\nRun from anywhere: node --experimental-strip-types "${join(CODE_ROOT,'src/cli.ts')}" [--root DIR] COMMAND\nRead README.md for cloud setup and limitations.`);
  }
} catch(e){console.error((e as Error).message);process.exitCode=1;}

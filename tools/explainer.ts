import {spawn} from 'node:child_process';
import {access, mkdtemp, readFile, writeFile, rm, stat, realpath, mkdir} from 'node:fs/promises';
import {constants} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, resolve, join, extname, relative, sep} from 'node:path';
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';

type Theme = 'light' | 'dark';
type Check = {name: string; width: number; theme: Theme; pass: boolean; detail: unknown};
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null; }
export async function findChrome(): Promise<string | undefined> {
  const candidates = [process.env.CHROME_PATH, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    ...(process.env.PATH ?? '').split(sep === '/' ? ':' : ';').flatMap(p => [join(p, 'google-chrome'), join(p, 'chromium')])];
  for (const candidate of candidates) if (candidate) {
    try { await access(candidate, constants.X_OK); return candidate; } catch { /* Try the next executable. */ }
  }
}
class CDP {
  private next = 0;
  private pending = new Map<number, {resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void}>();
  readonly errors: string[] = [];
  loads = 0;
  private socket: WebSocket;
  constructor(socket: WebSocket) {
    this.socket = socket;
    socket.addEventListener('message', event => {
      const message: unknown = JSON.parse(String(event.data));
      if (!record(message)) return;
      if (message.method === 'Page.loadEventFired') this.loads++;
      if (typeof message.id === 'number') {
        const request = this.pending.get(message.id); if (!request) return;
        this.pending.delete(message.id);
        if (message.error) request.reject(new Error(JSON.stringify(message.error)));
        else request.resolve(record(message.result) ? message.result : {});
      } else if (message.method === 'Runtime.exceptionThrown' ||
        (message.method === 'Runtime.consoleAPICalled' && record(message.params) && message.params.type === 'error')) {
        this.errors.push(JSON.stringify(message.params));
      }
    });
    socket.addEventListener('close', () => { for (const p of this.pending.values()) p.reject(new Error('Chrome disconnected')); this.pending.clear(); });
  }
  async send(method: string, params: object = {}): Promise<Record<string, unknown>> {
    const id = ++this.next;
    const response = new Promise<Record<string, unknown>>((resolve, reject) => this.pending.set(id, {resolve, reject}));
    this.socket.send(JSON.stringify({id, method, params}));
    const timer = setTimeout(() => { this.pending.get(id)?.reject(new Error(`CDP timeout: ${method}`)); this.pending.delete(id); }, 10000);
    try { return await response; } finally { clearTimeout(timer); }
  }
  async evaluate<T>(expression: string): Promise<T> {
    const response = await this.send('Runtime.evaluate', {expression, returnByValue: true, awaitPromise: true, userGesture: true});
    if (response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails));
    if (!record(response.result)) throw new Error('Invalid Runtime.evaluate response');
    // CDP serializes the result of our own browser expressions at this boundary.
    return response.result.value as T;
  }
  close() { this.socket.close(); }
}
async function session(file: string, chrome: string, work: (cdp: CDP, url: string) => Promise<void>) {
  const root = await realpath(dirname(file));
  const server = createServer(async (req, res) => {
    try {
      const pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
      const target = await realpath(resolve(root, '.' + pathname));
      if (relative(root, target).startsWith('..') || ! (await stat(target)).isFile()) { res.writeHead(404).end(); return; }
      const types: Record<string, string> = {'.html':'text/html', '.css':'text/css', '.js':'text/javascript', '.svg':'image/svg+xml', '.png':'image/png', '.woff2':'font/woff2'};
      res.setHeader('Content-Type', types[extname(target)] ?? 'application/octet-stream'); res.end(await readFile(target));
    } catch { res.writeHead(404).end(); }
  });
  const profile = await mkdtemp(join(tmpdir(), 'explainer-chrome-'));
  let child: ReturnType<typeof spawn> | undefined; let cdp: CDP | undefined;
  let ended: Promise<void> | undefined;
  const abort = () => { child?.kill('SIGKILL'); };
  process.once('SIGTERM', abort); process.once('SIGINT', abort);
  try {
    await new Promise<void>((ok, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', ok); });
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('HTTP port unavailable');
    child = spawn(chrome, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-background-networking', 'about:blank'], {stdio:['ignore','ignore','pipe']});
    ended = new Promise<void>(ok => child?.once('close', () => ok()));
    let diagnostics = ''; child.stderr?.on('data', chunk => { diagnostics = (diagnostics + String(chunk)).slice(-4000); });
    let launchError: Error | undefined; child.once('error', error => { launchError = error; });
    let port = '';
    for (let i = 0; i < 100; i++) {
      if (launchError) throw launchError;
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Chrome exited: ${child.exitCode ?? child.signalCode}. ${diagnostics}`);
      try { port = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]; if (port) break; } catch { /* Chrome is still starting. */ }
      await delay(50);
    }
    if (!/^\d+$/.test(port)) throw new Error(`Chrome did not write DevToolsActivePort. ${diagnostics}`);
    const targets: unknown = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const target = Array.isArray(targets) ? targets.find((v: unknown) => record(v) && v.type === 'page') : undefined;
    if (!record(target) || typeof target.webSocketDebuggerUrl !== 'string') throw new Error('Chrome page target unavailable');
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise<void>((ok, fail) => { socket.addEventListener('open', () => ok(), {once:true}); socket.addEventListener('error', () => fail(new Error('DevTools connection failed')), {once:true}); });
    cdp = new CDP(socket); await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
    await work(cdp, `http://127.0.0.1:${address.port}/${encodeURIComponent(file.split(sep).at(-1) ?? '')}`);
  } finally {
    cdp?.close();
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL'); await ended;
    }
    server.closeAllConnections(); await new Promise<void>(ok => server.close(() => ok()));
    await rm(profile, {recursive:true, force:true});
    process.removeListener('SIGTERM', abort); process.removeListener('SIGINT', abort);
  }
}
async function load(cdp: CDP, url: string, width: number, height: number, theme: Theme, reduce = false) {
  await cdp.send('Emulation.setDeviceMetricsOverride', {width, height, deviceScaleFactor:1, mobile:false});
  await cdp.send('Emulation.setEmulatedMedia', {features:[{name:'prefers-color-scheme',value:theme},{name:'prefers-reduced-motion',value:reduce ? 'reduce' : 'no-preference'}]});
  cdp.errors.length = 0;
  const previousLoads = cdp.loads;
  const navigation = await cdp.send('Page.navigate', {url});
  if (navigation.errorText) throw new Error(`Navigation failed: ${navigation.errorText}`);
  for (let i=0;i<300;i++) {
    if (cdp.loads > previousLoads) break;
    if (i === 299) throw new Error('Page load timed out'); await delay(30);
  }
  await cdp.evaluate('document.fonts.ready.then(() => true)');
}
// These functions run in Chrome. Keep them self-contained so no Node code enters the page.
function browserAudit() {
  const selector = (e: Element) => e.id ? '#' + CSS.escape(e.id) : e.tagName.toLowerCase() + (e.classList.length ? '.' + [...e.classList].map(c=>CSS.escape(c)).join('.') : '');
  const visible = (e: Element) => { const s=getComputedStyle(e); return e.getClientRects().length > 0 && s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) !== 0; };
  const elements = [...document.querySelectorAll('*')].filter(visible);
  const offender = elements.find(e=>e.getBoundingClientRect().width > innerWidth) || (document.documentElement.scrollWidth > innerWidth ? elements.find(e=>e.getBoundingClientRect().right > innerWidth) : undefined);
  const overflow = {pass:document.documentElement.scrollWidth <= innerWidth && !offender, detail:offender ? selector(offender) : `scrollWidth=${document.documentElement.scrollWidth}, viewport=${innerWidth}`};
  const paint = document.createElement('canvas').getContext('2d', {willReadFrequently:true})!;
  const rgba = (s:string) => { paint.clearRect(0,0,1,1); paint.fillStyle = '#000'; paint.fillStyle = s; paint.fillRect(0,0,1,1); const d = paint.getImageData(0,0,1,1).data; return [d[0], d[1], d[2], d[3]/255]; };
  const blend = (fg:number[], bg:number[]) => { const a=fg[3] ?? 1; return [0,1,2].map(i=>fg[i]*a+bg[i]*(1-a)); };
  const background = (e:Element|null):number[] => {
    if (!e) return [255,255,255];
    const c=rgba(getComputedStyle(e).backgroundColor); return blend(c, (c[3] ?? 1) >= 1 ? [255,255,255] : background(e.parentElement));
  };
  const luminance = (c:number[]) => c.slice(0,3).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;}).reduce((s,v,i)=>s+v*[.2126,.7152,.0722][i],0);
  const ratio = (a:number[],b:number[]) => {const x=luminance(a),y=luminance(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05);};
  const pairs:{selector:string;kind:string;ratio:number;required:number;color:string;background:number[]}[]=[];
  for (const e of elements) {
    const s=getComputedStyle(e), bg=background(e);
    if ([...e.childNodes].some(n=>n.nodeType===Node.TEXT_NODE && n.textContent?.trim())) {
      const large=parseFloat(s.fontSize)>=24 || (parseFloat(s.fontSize)>=18.66 && Number(s.fontWeight)>=700);
      pairs.push({selector:selector(e),kind:'text',ratio:ratio(blend(rgba(s.color),bg),bg),required:large?3:4.5,color:s.color,background:bg});
    }
    // Disabled controls are exempt from WCAG 1.4.11.
    if(e.matches('button,input') && !e.matches(':disabled,[aria-disabled="true"]')) for(const side of ['Top','Right','Bottom','Left']) {
      const color=s.getPropertyValue(`border-${side.toLowerCase()}-color`);
      const width=parseFloat(s.getPropertyValue(`border-${side.toLowerCase()}-width`));
      // WCAG 1.4.11: the control's boundary against the colour next to it. A visible border or a distinct fill identifies the control.
      const border = rgba(color), outside = background(e.parentElement);
      if (width > 0 && s.getPropertyValue(`border-${side.toLowerCase()}-style`) !== 'none' && border[3] > 0) pairs.push({selector:selector(e),kind:`border-${side}`,ratio:Math.max(ratio(blend(border,outside),outside), ratio(bg,outside)),required:3,color,background:outside});
    }
  }
  pairs.sort((a,b)=>a.ratio/a.required-b.ratio/b.required);
  const links=[...document.querySelectorAll<HTMLAnchorElement>('a[href]')].map(a=>({href:a.getAttribute('href') ?? '',exists:!a.getAttribute('href')?.startsWith('#') || a.hash==='' || a.hash==='#' || !!document.getElementById(decodeURIComponent(a.hash.slice(1)))}));
  return {overflow,contrast:{pass:pairs.every(p=>p.ratio>=p.required),detail:pairs.slice(0,5)},links};
}
function motionAudit() {
  const running=document.getAnimations().filter(a=>a.playState==='running').length;
  const transitions=[...document.querySelectorAll('*')].filter(e=>getComputedStyle(e).transitionDuration.split(',').some(t=>parseFloat(t)*(t.trim().endsWith('ms')?.001:1)>.01)).map(e=>e.id?'#'+e.id:e.tagName.toLowerCase());
  return {running,transitions};
}
async function keyboard(cdp:CDP) {
  const count=await cdp.evaluate<number>(`(() => { window.__explainerFocus = [...document.querySelectorAll('a[href],button,input,select,textarea,summary,[tabindex]')].filter(e=>e.getAttribute('tabindex')!=='-1').filter(e=>{const s=getComputedStyle(e);return e.getClientRects().length && s.visibility!=='hidden' && s.display!=='none' && !e.disabled}); document.activeElement?.blur(); return window.__explainerFocus.length; })()`);
  const seen=new Set<number>(); let invisible='';
  for(let i=0;i<count*2+4;i++) {
    await cdp.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});
    await cdp.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});
    const focus=await cdp.evaluate<{index:number;indicator:boolean;selector:string}>(`(() => {const e=document.activeElement,s=getComputedStyle(e);return {index:window.__explainerFocus.indexOf(e),indicator:(s.outlineStyle!=='none' && parseFloat(s.outlineWidth)>0)||s.boxShadow!=='none',selector:e.id?'#'+e.id:e.outerHTML.slice(0,160)}})()`);
    if(focus.index>=0) { seen.add(focus.index); if(!focus.indicator && !invisible) invisible=focus.selector; }
    if(seen.size===count) break;
  }
  const missing=await cdp.evaluate<string>(`(() => {const e=window.__explainerFocus.find((e,i)=>!${JSON.stringify([...seen])}.includes(i) && e.getAttribute('tabindex')!=='-1');return e?e.outerHTML.slice(0,160):''})()`);
  return {pass:!missing&&!invisible,detail:missing?`Unreachable: ${missing}`:invisible?`No visible focus: ${invisible}`:`${count} focusable elements reached with indicators`};
}
async function check(file:string, chrome:string, out?:string) {
  const checks:Check[]=[];
  await session(file,chrome,async(cdp,url)=>{
    const reset=()=>cdp.evaluate(`(() => {try{localStorage.clear();sessionStorage.clear();}catch{}})()`).catch(()=>{});
    for(const width of [360,390,768,1024,1440]) for(const theme of ['light','dark'] satisfies Theme[]) {
      // Controls such as a theme switch persist state; every combination starts clean.
      await reset(); await load(cdp,url,width,900,theme);
      const audit=await cdp.evaluate<ReturnType<typeof browserAudit>>(`(${browserAudit.toString()})()`);
      const add=(name:string,result:{pass:boolean;detail:unknown})=>checks.push({name,width,theme,...result});
      add('overflow',audit.overflow); add('contrast',audit.contrast);
      const failures:string[]=[], external:string[]=[];
      for(const link of audit.links) {
        if(!link.exists) failures.push(`Missing target: ${link.href}`);
        if(link.href.startsWith('#')) continue;
        if(/^(?:[a-z][\w+.-]*:|\/\/)/i.test(link.href)) { external.push(link.href);continue; }
        try { const path=decodeURIComponent(link.href.split(/[?#]/)[0]).replace(/^\/+/, ''); await access(resolve(dirname(file),path)); } catch { failures.push(`Missing file: ${link.href}`); }
      }
      add('links',{pass:!failures.length,detail:{failures,external}});
      const controls=await cdp.evaluate<number>(`(() => {window.__explainerControls=[...document.querySelectorAll('button,[role=tab],input,select,details > summary')];return window.__explainerControls.length})()`);
      for(let i=0;i<controls;i++) {
        try {
          await cdp.evaluate(`window.__explainerControls[${i}].click()`); await delay(10);
          await cdp.evaluate(`window.__explainerControls[${i}].click()`); await delay(10);
        } catch (error) { cdp.errors.push(`Control ${i}: ${error instanceof Error ? error.message : String(error)}`); }
      }
      await delay(50); add('console',{pass:cdp.errors.length===0,detail:[...cdp.errors]});
      await reset(); await load(cdp,url,width,900,theme); add('keyboard',await keyboard(cdp));
      await reset();
      await load(cdp,url,width,900,theme,true);
      const start=await cdp.evaluate<ReturnType<typeof motionAudit>>(`(${motionAudit.toString()})()`); await delay(500);
      const end=await cdp.evaluate<ReturnType<typeof motionAudit>>(`(${motionAudit.toString()})()`);
      add('motion',{pass:!end.running&&!end.transitions.length,detail:{afterLoad:start,after500ms:end}});
    }
  });
  const report={file,sha256:await hash(file),generatedAt:new Date().toISOString(),checks};
  if(out) await writeFile(out,JSON.stringify(report,null,2)+'\n');
  console.table(['overflow','console','keyboard','motion','contrast','links'].map(name=>({check:name,pass:checks.filter(c=>c.name===name&&c.pass).length,fail:checks.filter(c=>c.name===name&&!c.pass).length})));
  return checks.every(c=>c.pass)?0:1;
}
const hash=async(file:string)=>createHash('sha256').update(await readFile(file)).digest('hex');
type Clip={x:number;y:number;width:number;height:number};
async function screenshot(cdp:CDP,dir:string,name:string,clip:Clip) {
  let height=Math.floor(clip.height);
  while(height>=1) {
    const result=await cdp.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:true,clip:{...clip,height,scale:1}});
    if(typeof result.data!=='string') throw new Error('Screenshot has no PNG data');
    const bytes=Buffer.from(result.data,'base64');
    if(bytes.length<400000) { await writeFile(join(dir,name),bytes); console.log(`${name}: ${bytes.length} bytes`);return height; }
    height=Math.floor(height*.75);
  }
  throw new Error(`${name}: cannot produce PNG under 400 KB`);
}
async function capture(file:string,dir:string,chrome:string,system?:string) {
  await mkdir(dir,{recursive:true}); const entries:{name:string;alt:string}[]=[];
  const sha=await hash(file); console.log(`Source page SHA-256: ${sha}`);
  const take=async(cdp:CDP,name:string,clip:Clip)=>{
    const height=await screenshot(cdp,dir,name,clip);
    const headings=await cdp.evaluate<string>(`[...document.querySelectorAll('h1,h2,h3')].filter(e=>{const r=e.getBoundingClientRect(),y=r.top+scrollY;return y>=${clip.y} && y<${clip.y+height}}).map(e=>e.textContent.trim()).join('; ')`);
    entries.push({name,alt:`Page view showing ${headings || await cdp.evaluate<string>("document.querySelector('h1')?.textContent?.trim() || document.title")}.`});
  };
  try {
    await session(file,chrome,async(cdp,url)=>{
      for(const [name,width,height,theme] of [['explainer-desktop-light.png',1440,900,'light'],['explainer-desktop-dark.png',1440,900,'dark'],['explainer-phone-light.png',390,844,'light']] satisfies [string,number,number,Theme][]) {
        await load(cdp,url,width,height,theme); await take(cdp,name,{x:0,y:0,width,height});
      }
      await load(cdp,url,1440,900,'light');
      for(const [name,expression] of [
        ['explainer-skills-explorer.png',"document.querySelector('#fig6') || document.querySelector('#skills') || document.querySelector('ul.skill-catalog')?.closest('section')"],
        ['explainer-unattended-run.png?',"document.querySelector('#fig9')"],
        ['explainer-orchestration.png',"document.querySelector('#fig7') || document.querySelector('[id*=orchestration]') || [...document.querySelectorAll('figure,.fig')].find(e=>[...e.querySelectorAll('h1,h2,h3,figcaption')].some(h=>/plan/i.test(h.textContent)&&/agents/i.test(h.textContent)))"]]) {
        const clip=await cdp.evaluate<Clip|null>(`(() => {const e=${expression};if(!e)return null;const r=e.getBoundingClientRect();return {x:Math.max(0,r.left+scrollX),y:Math.max(0,r.top+scrollY),width:r.width,height:r.height}})()`);
        // A name ending in '?' is optional: a page without that figure skips it.
        const optional=name.endsWith('?'), file=optional?name.slice(0,-1):name;
        if(!clip || !clip.width || !clip.height) { if(optional) { console.log(`skipped optional capture: ${file}`); continue; } throw new Error(`Missing capture target: ${file} (${expression})`); }
        await take(cdp,file,clip);
      }
    });
    if(system) await session(system,chrome,async(cdp,url)=>{await load(cdp,url,1440,900,'light');await take(cdp,'system-design-page.png',{x:0,y:0,width:1440,height:900});});
  } finally {
    // Arguments are shell-quoted, including spaces and apostrophes, for a reproducible command.
    // A repo-relative command, so the record holds no local paths.
    const command=['node','--experimental-strip-types','tools/explainer.ts',...process.argv.slice(2)].map(v=>/^[\w./=-]+$/.test(v)?v:"'"+v.replaceAll("'", "'\\''")+"'").join(' ');
    await writeFile(join(dir,'README.md'),`# Screenshots\n\nReal captures of the page, made by \`tools/explainer.ts capture\`. Rerun the command below after the page changes.\n\nDate: ${new Date().toISOString()}\n\nSource page SHA-256: ${sha}\n\nCommand:\n\n\`\`\`sh\n${command}\n\`\`\`\n\n${entries.map(e=>`- ${e.name}: ${e.alt}`).join('\n')}\n`);
  }
  return 0;
}
export async function main(args:string[]) {
  const [command,input,...rest]=args;
  if(!input || !['check','capture'].includes(command)) throw new Error('Usage: explainer.ts check FILE [--json OUT] | capture FILE DIR [--system-design PATH]');
  if(command==='check' && !(rest.length===0 || (rest.length===2&&rest[0]==='--json'))) throw new Error('Usage: check FILE [--json OUT]');
  if(command==='capture' && !(rest.length===1 || (rest.length===3&&rest[1]==='--system-design'))) throw new Error('Usage: capture FILE DIR [--system-design PATH]');
  const chrome=await findChrome(); if(!chrome) { console.error('Chrome not found. Set CHROME_PATH or install Google Chrome/chromium on PATH.');return 2; }
  const file=resolve(input);await access(file);
  return command==='check'?check(file,chrome,rest[1]):capture(file,resolve(rest[0]),chrome,rest[2]?resolve(rest[2]):undefined);
}
if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then(code=>{process.exitCode=code;},error=>{console.error(error instanceof Error?error.message:String(error));process.exitCode=1;});
}

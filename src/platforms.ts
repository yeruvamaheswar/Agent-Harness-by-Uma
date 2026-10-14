// Adapter contract as data: one record per runtime. No installer reads this table yet. See docs/platforms.md "Adapter table".
export type Status='documented'|'observed'|'unknown';
export type Target={path:string;status:Status};
export type EvidenceState='configured'|'tested'|'behaviorally verified'|'unknown';
export type PlatformRecord={
  id:string;
  platform:'claude'|'codex'|'cursor'|'generic';
  environment:'local'|'cloud';
  instructions:{user:Target[];repo:Target[]};   // paths relative to home or to the repo root; [] = none
  skillRoots:{user:Target[];repo:Target[]};
  scopedRules:string;                           // path-scoped mechanism, or 'none' / 'unknown'
  mcp:{user:string|null;repo:string|null;note:string}; // null = unavailable; 'unknown' = not established
  hooks:string;
  runtime:string;                               // what must exist on the machine; 'none' for cloud
  manualSteps:string[];
  versionCheck:string;
  probe:string;                                 // non-interactive fresh-session command, or 'unknown'
  evidence:{state:EvidenceState;date:string;note:string};
  sources:string[];
};
const t=(path:string,status:Status):Target=>({path,status});
const U=t('unknown','unknown');
const NODE='Node 24+ for the harness CLI and the MCP server';
const LOCAL_CHECK='harness status; the plain line "Harness release N." in the loaded instructions';
const CLOUD_CHECK='harness repo verify PATH; the plain line "Harness release N." in the loaded instructions';
// Cursor keeps the policy in User Rules only. No tool can write that setting, so the paste is a manual step after every release change.
const CURSOR_RULES=t('Cursor Settings > Rules > User Rules (UI)','observed');
const CURSOR_STEPS=['harness install cursor-files (MCP entry only; it writes no rule file)','after every release change, paste releases/VERSION/cursor/user-rules.md into the User Rule "Agentic Harness" in Cursor Settings','harness confirm cursor-user-rules'];
const CURSOR_CHECK='harness status (manualSteps: cursor-user-rules shows needed false); the plain line "Harness release N." in the loaded instructions';
const REPO_INSTALL='harness repo install PATH [--pointer], then commit the instruction files and .agentic-harness/';
const E='2026-10-10', LOADED='Fresh session loaded the 1.4.1 policy and DesignOS routing; loading only.';
export const PLATFORM_RECORDS:readonly PlatformRecord[]=[
  {id:'claude-local',platform:'claude',environment:'local',
    instructions:{user:[t('.claude/CLAUDE.md','observed')],repo:[t('CLAUDE.md','observed')]},
    skillRoots:{user:[t('.claude/skills','observed')],repo:[t('.claude/skills','documented')]},
    scopedRules:'.claude/rules/*.md with paths front matter (user and repo)',
    mcp:{user:'~/.claude.json via claude mcp add --scope user',repo:'.mcp.json',note:'The installer does not edit ~/.claude.json.'},
    hooks:'settings.json',runtime:NODE,
    manualSteps:['harness install claude','claude mcp add --scope user agentic_harness -- "$(which node)" --experimental-strip-types "$PWD/src/mcp.ts"'],
    versionCheck:LOCAL_CHECK,probe:'claude -p "<prompt>" --output-format stream-json --verbose',
    evidence:{state:'behaviorally verified',date:E,note:LOADED},
    sources:['https://docs.anthropic.com/en/docs/claude-code/memory','https://code.claude.com/docs/en/memory#user-level-rules','https://docs.anthropic.com/en/docs/claude-code/mcp']},
  {id:'claude-cloud',platform:'claude',environment:'cloud',
    instructions:{user:[],repo:[t('CLAUDE.md','documented')]},
    skillRoots:{user:[],repo:[t('.claude/skills','documented')]},
    scopedRules:'.claude/rules (repo, documented)',
    mcp:{user:null,repo:'.mcp.json (one-repo session)',note:'User MCP is unavailable in cloud.'},
    hooks:'repo .claude/settings.json (one-repo session)',runtime:'none',
    manualSteps:[REPO_INSTALL],
    versionCheck:CLOUD_CHECK,probe:'unknown',
    evidence:{state:'behaviorally verified',date:E,note:'loading only: one cloud session on a pilot repo in pointer mode stated the release from the repo CLAUDE.md, read .agentic-harness/policy.md, and routed design work to .design-os'},
    sources:['https://code.claude.com/docs/en/cloud-environments']},
  {id:'codex-local',platform:'codex',environment:'local',
    instructions:{user:[t('.codex/AGENTS.md','observed'),t('.codex/AGENTS.override.md','documented')],repo:[t('AGENTS.md','observed')]},
    skillRoots:{user:[t('.codex/skills','observed'),t('.agents/skills','observed')],repo:[t('.agents/skills','documented')]},
    scopedRules:'none',
    mcp:{user:'~/.codex/config.toml',repo:'unknown',note:'Absolute node and script path.'},
    hooks:'unknown',runtime:NODE,
    manualSteps:['harness install codex','reconcile AGENTS.override.md if it exists'],
    versionCheck:LOCAL_CHECK,probe:'codex exec --json -s read-only "<prompt>"',
    evidence:{state:'behaviorally verified',date:E,note:LOADED},
    sources:['https://learn.chatgpt.com/docs/agent-configuration/agents-md','https://learn.chatgpt.com/docs/build-skills','https://developers.openai.com/codex/guides/agents-md/','https://developers.openai.com/codex/mcp/']},
  {id:'codex-cloud',platform:'codex',environment:'cloud',
    instructions:{user:[],repo:[t('AGENTS.md','unknown')]},
    skillRoots:{user:[],repo:[U]},
    scopedRules:'unknown',
    mcp:{user:null,repo:'unknown',note:'Cloud MCP is not stated in the sources read.'},
    hooks:'unknown',runtime:'none',
    manualSteps:['Start each cloud task by telling the agent to read AGENTS.md in the repository: on 2026-10-10 the session started in /workspace above the repo and loaded no repo instructions or skills',REPO_INSTALL],
    versionCheck:CLOUD_CHECK,probe:'unknown',
    evidence:{state:'unknown',date:E,note:'one cloud task: AGENTS.md and repo skills were not loaded at start (the session started in /workspace above the repo during environment setup); after the agent read AGENTS.md it followed the pointer, DesignOS routing, and the conflict rule'},
    sources:['https://learn.chatgpt.com/docs/agent-configuration/agents-md']},
  {id:'cursor-ide',platform:'cursor',environment:'local',
    instructions:{user:[CURSOR_RULES],repo:[t('.cursor/rules/*.mdc','documented'),t('AGENTS.md','documented')]},
    skillRoots:{user:[t('.agents/skills','documented'),t('.cursor/skills','documented'),t('.claude/skills','documented'),t('.codex/skills','documented')],repo:[t('.agents/skills','documented'),t('.cursor/skills','documented')]},
    scopedRules:'repo .cursor/rules/*.mdc; path scoping unknown',
    mcp:{user:'~/.cursor/mcp.json',repo:'unknown',note:'Enable the server if Cursor asks.'},
    hooks:'hooks.json',runtime:NODE,
    manualSteps:[...CURSOR_STEPS,'enable the agentic_harness MCP server if asked'],
    versionCheck:CURSOR_CHECK,probe:'unknown',
    evidence:{state:'behaviorally verified',date:E,note:'Harness loading only: one fresh Agent chat stated release 1.4.1 from ~/.cursor/rules/pragmatic-engineer.mdc and from User Rules, so the policy loads twice; DesignOS not run'},
    sources:['https://cursor.com/docs/rules','https://cursor.com/docs/skills']},
  {id:'cursor-cli',platform:'cursor',environment:'local',
    instructions:{user:[CURSOR_RULES],repo:[t('AGENTS.md','documented')]},
    skillRoots:{user:[t('unknown (roots assumed, no log lists them)','unknown')],repo:[U]},
    scopedRules:'unknown',
    mcp:{user:'unknown',repo:'unknown',note:'Reported connected; registration file unknown.'},
    hooks:'unknown',runtime:NODE,
    manualSteps:CURSOR_STEPS,
    versionCheck:CURSOR_CHECK,probe:'cursor-agent -p --output-format stream-json --mode ask "<prompt>"',
    evidence:{state:'behaviorally verified',date:E,note:LOADED+' Which location it used is unknown.'},
    sources:[]},
  {id:'cursor-cloud',platform:'cursor',environment:'cloud',
    instructions:{user:[],repo:[t('AGENTS.md','unknown')]},
    skillRoots:{user:[],repo:[t('.agents/skills','unknown')]},
    scopedRules:'unknown',
    mcp:{user:null,repo:null,note:'Team-configured MCP only.'},
    hooks:'repo .cursor/hooks.json; user hooks unavailable',runtime:'none',
    manualSteps:[REPO_INSTALL],
    versionCheck:CLOUD_CHECK,probe:'unknown',
    evidence:{state:'behaviorally verified',date:E,note:'loading only: one cloud agent on a pilot repo saw the release, AGENTS.md, CLAUDE.md, .cursor/rules/design-os.mdc, the design-os skills, and account User Rules that held a policy excerpt'},
    sources:['https://cursor.com/docs/background-agent']},
  {id:'generic',platform:'generic',environment:'local',
    instructions:{user:[t('.config/agentic-harness/instructions.md','documented')],repo:[]},
    skillRoots:{user:[],repo:[]},
    scopedRules:'none',
    mcp:{user:null,repo:null,note:'none'},
    hooks:'none',runtime:'none',
    manualSteps:['harness install generic','load instructions.md through the agent\'s persistent instruction mechanism before task input'],
    versionCheck:'the plain line "Harness release N." in the loaded instructions',probe:'unknown',
    evidence:{state:'configured',date:'unknown',note:'Configured; no fresh-session test.'},
    sources:['docs/platforms.md']},
];

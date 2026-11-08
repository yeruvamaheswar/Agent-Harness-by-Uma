import { readdir, lstat, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { join, relative } from 'node:path';

export interface AsksMetrics {
  sessions: number;
  questions: number;
  batches: number;
  repeatsInSession: number;
  repeatsAcrossSessions: number;
  sessionsWithRepeats: number;
  postCompactionReasks: number;
  timeBlockedSeconds: number;
  timeBlockedMedianSeconds: number;
  unmeasuredBatches: number;
  userRejections: number;
  planCycles: number;
  planCyclesWithNoEdits: number;
  skippedFiles: number;
  oversizeFiles: number;
  breakdown: {
    askCalls: number;
    askItems: number;
    proseQuestions: number;
    planCycles: number;
    planCyclesWithNoEdits: number;
    totalTimeBlockedSeconds: number;
    medianTimeBlockedSeconds: number;
    unmeasuredBatches: number;
    meanBatchesPerSession: number;
  };
}

export interface AsksOptions {
  days?: number;
  now?: number | Date;
}

const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB
const MAX_TIME_BLOCKED_GAP = 3600; // 3600 seconds cap
const REJECTION_PREFIX = "The user doesn't want to proceed with this tool use. The tool use was rejected";
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

function isPlainObject(v: unknown): v is Record<string, any> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function normalizeQuestion(q: string): string {
  return q
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

interface FoundFiles {
  files: string[];
  skippedFiles: number;
  oversizeFiles: number;
}

export async function findTranscriptFiles(dir: string): Promise<FoundFiles> {
  let rootStat;
  try {
    rootStat = await stat(dir);
  } catch {
    throw new Error(`Directory "${dir}" is missing or unreadable.`);
  }
  if (!rootStat.isDirectory()) {
    throw new Error(`Path "${dir}" is not a directory.`);
  }

  const files: string[] = [];
  let skippedFiles = 0;
  let oversizeFiles = 0;

  async function walk(current: string) {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      skippedFiles++;
      return;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      let lst;
      try {
        lst = await lstat(full);
      } catch {
        skippedFiles++;
        continue;
      }
      if (lst.isSymbolicLink()) {
        skippedFiles++;
        continue;
      }
      if (lst.isDirectory()) {
        if (!entry.name.startsWith('.')) {
          await walk(full);
        }
      } else if (lst.isFile() && entry.name.endsWith('.jsonl')) {
        if (lst.size > MAX_FILE_SIZE) {
          oversizeFiles++;
        } else {
          files.push(full);
        }
      }
    }
  }

  await walk(dir);
  return { files: files.sort(), skippedFiles, oversizeFiles };
}

async function readSessionLinesStream(filePath: string): Promise<Record<string, any>[] | null> {
  try {
    const lines: Record<string, any>[] = [];
    const fileStream = createReadStream(filePath);
    const rl = createInterface({
      input: fileStream,
      crlfDelay: Infinity,
    });

    for await (const rawLine of rl) {
      const trimmed = rawLine.trim();
      if (!trimmed) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue; // skip malformed lines without logging content
      }
      if (!isPlainObject(parsed)) continue;
      lines.push(parsed);
    }
    return lines;
  } catch {
    return null;
  }
}

function getContentBlocks(line: Record<string, any>): Record<string, any>[] {
  const raw = Array.isArray(line.message?.content)
    ? line.message.content
    : (Array.isArray(line.content) ? line.content : []);
  return raw.filter(isPlainObject);
}

function isCompactionMarker(line: Record<string, any>): boolean {
  if (line.subtype === 'compact_boundary') return true;
  if (line.isCompactSummary === true || line.message?.isCompactSummary === true) return true;
  return false;
}

function countUserRejections(line: Record<string, any>): number {
  if (line.type !== 'user' && line.message?.role !== 'user') return 0;
  let count = 0;
  const blocks = getContentBlocks(line);
  for (const block of blocks) {
    if (block.type === 'tool_result' && block.is_error === true) {
      const text = typeof block.content === 'string'
        ? block.content
        : (Array.isArray(block.content)
            ? block.content.map(c => typeof c === 'string' ? c : (c?.text ?? '')).join('\n')
            : '');
      if (text.startsWith(REJECTION_PREFIX)) {
        count++;
      }
    }
  }
  return count;
}

function isPlainUserTurn(line: Record<string, any>): boolean {
  if (line.type !== 'user' && line.message?.role !== 'user') return false;
  const blocks = getContentBlocks(line);
  if (blocks.some(b => b.type === 'tool_result')) return false;
  return true;
}

interface AssistantTurn {
  messageId?: string;
  timestamp?: string;
  blocks: Record<string, any>[];
  hasAskUserQuestion: boolean;
  askCalls: number;
  askItems: string[];
  hasPlanExit: boolean;
  edits: number;
  proseQuestion: string | null;
  turnIndex: number;
}

export async function computeAsksMetrics(dir: string, options: AsksOptions = {}): Promise<AsksMetrics> {
  if (options.days !== undefined) {
    if (typeof options.days !== 'number' || isNaN(options.days) || !isFinite(options.days) || options.days <= 0) {
      throw new Error('Invalid value for --days. Must be a positive finite number.');
    }
  }

  const { files, skippedFiles: scanSkipped, oversizeFiles } = await findTranscriptFiles(dir);

  let skippedFiles = scanSkipped;
  const rawSessions: {
    filePath: string;
    project: string;
    startTime: number;
    lines: Record<string, any>[];
  }[] = [];

  for (const file of files) {
    const lines = await readSessionLinesStream(file);
    if (!lines) {
      skippedFiles++;
      continue;
    }

    // Dedupe by uuid and skip isSidechain: true
    const deduped: Record<string, any>[] = [];
    const seenUuids = new Set<string>();
    let minTime = Infinity;

    for (const line of lines) {
      if (line.isSidechain === true) continue;
      if (typeof line.uuid === 'string' && line.uuid) {
        if (seenUuids.has(line.uuid)) continue;
        seenUuids.add(line.uuid);
      }
      if (typeof line.timestamp === 'string') {
        const t = Date.parse(line.timestamp);
        if (!isNaN(t) && t < minTime) minTime = t;
      }
      deduped.push(line);
    }

    if (deduped.length === 0) continue;

    // Project folder is first folder under dir
    const rel = relative(dir, file);
    const parts = rel.split(/[/\\]/);
    const project = parts.length > 1 ? parts[0] : '.';

    rawSessions.push({
      filePath: file,
      project,
      startTime: minTime === Infinity ? 0 : minTime,
      lines: deduped,
    });
  }

  // Date filter per session
  const nowMs = options.now
    ? (typeof options.now === 'number' ? options.now : options.now.getTime())
    : Date.now();
  const cutoffMs = options.days !== undefined ? nowMs - options.days * 86400 * 1000 : undefined;

  const validSessions = rawSessions.filter(s => {
    if (cutoffMs !== undefined && s.startTime !== 0) {
      return s.startTime >= cutoffMs;
    }
    return true;
  });

  // Sort sessions chronologically
  validSessions.sort((a, b) => a.startTime - b.startTime);

  let totalSessions = validSessions.length;
  let totalBatches = 0;
  let totalRepeatsInSession = 0;
  let totalRepeatsAcrossSessions = 0;
  let totalSessionsWithRepeats = 0;
  let totalPostCompactionReasks = 0;
  let totalBlockedSeconds = 0;
  let unmeasuredBatches = 0;
  let totalUserRejections = 0;
  let totalPlanCycles = 0;
  let totalPlanCyclesWithNoEdits = 0;

  let totalAskCalls = 0;
  let totalAskItems = 0;
  let totalProseQuestions = 0;

  const measuredGaps: number[] = [];
  const projectQuestions = new Map<string, Set<string>>();

  for (const session of validSessions) {
    let sessionHadRepeat = false;
    const sessionQuestions = new Set<string>();
    const sessionFirstSeen = new Set<string>();
    const preCompactionQuestions = new Set<string>();
    let sessionCompacted = false;

    let hasPreviousPlanExit = false;
    let editsSinceLastPlanExit = 0;

    const lines = session.lines;

    // Group assistant lines into turns
    interface TurnItem {
      kind: 'assistant' | 'other' | 'compaction';
      line?: Record<string, any>;
      assistantTurn?: AssistantTurn;
    }

    const turns: TurnItem[] = [];
    let currentAssistantTurn: AssistantTurn | null = null;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      totalUserRejections += countUserRejections(line);

      if (isCompactionMarker(line)) {
        if (currentAssistantTurn) {
          turns.push({ kind: 'assistant', assistantTurn: currentAssistantTurn });
          currentAssistantTurn = null;
        }
        turns.push({ kind: 'compaction', line });
        continue;
      }

      const isAssistant = line.type === 'assistant' || line.message?.role === 'assistant';

      if (isAssistant) {
        const msgId = line.message?.id;
        const canGroup = currentAssistantTurn && (
          (msgId && currentAssistantTurn.messageId === msgId) ||
          (!msgId && !currentAssistantTurn.messageId)
        );

        if (!canGroup) {
          if (currentAssistantTurn) {
            turns.push({ kind: 'assistant', assistantTurn: currentAssistantTurn });
          }
          currentAssistantTurn = {
            messageId: msgId,
            timestamp: line.timestamp,
            blocks: [],
            hasAskUserQuestion: false,
            askCalls: 0,
            askItems: [],
            hasPlanExit: false,
            edits: 0,
            proseQuestion: null,
            turnIndex: turns.length,
          };
        }

        const blocks = getContentBlocks(line);
        for (const b of blocks) {
          currentAssistantTurn!.blocks.push(b);
          if (b.type === 'tool_use' && typeof b.name === 'string') {
            if (b.name === 'AskUserQuestion') {
              currentAssistantTurn!.hasAskUserQuestion = true;
              currentAssistantTurn!.askCalls++;
              const input = b.input;
              if (isPlainObject(input) && Array.isArray(input.questions)) {
                for (const q of input.questions) {
                  if (q === null || q === undefined) continue;
                  const text = typeof q === 'string' ? q : (isPlainObject(q) ? (q.question ?? q.text ?? '') : '');
                  currentAssistantTurn!.askItems.push(String(text));
                }
              } else if (isPlainObject(input) && typeof input.question === 'string') {
                currentAssistantTurn!.askItems.push(input.question);
              } else {
                currentAssistantTurn!.askItems.push('');
              }
            } else if (b.name === 'ExitPlanMode') {
              currentAssistantTurn!.hasPlanExit = true;
            } else if (EDIT_TOOLS.has(b.name)) {
              currentAssistantTurn!.edits++;
            }
          }
        }
      } else {
        if (currentAssistantTurn) {
          turns.push({ kind: 'assistant', assistantTurn: currentAssistantTurn });
          currentAssistantTurn = null;
        }
        turns.push({ kind: 'other', line });
      }
    }
    if (currentAssistantTurn) {
      turns.push({ kind: 'assistant', assistantTurn: currentAssistantTurn });
      currentAssistantTurn = null;
    }

    // Now evaluate each turn in sequence
    sessionCompacted = false;
    for (let t = 0; t < turns.length; t++) {
      const item = turns[t];
      if (item.kind === 'compaction') {
        sessionCompacted = true;
        continue;
      }
      if (item.kind !== 'assistant' || !item.assistantTurn) continue;
      const turn = item.assistantTurn;

      // Handle plan cycles and edits in exact block order
      for (const b of turn.blocks) {
        if (b.type === 'tool_use' && typeof b.name === 'string') {
          if (b.name === 'ExitPlanMode') {
            totalPlanCycles++;
            if (hasPreviousPlanExit && editsSinceLastPlanExit === 0) {
              totalPlanCyclesWithNoEdits++;
            }
            hasPreviousPlanExit = true;
            editsSinceLastPlanExit = 0;
          } else if (EDIT_TOOLS.has(b.name)) {
            editsSinceLastPlanExit++;
          }
        }
      }

      // Check for prose questions
      // Rule 4: count text ending in "?" only when it is the last content of assistant turn,
      // no tool_use after it in that message, and next non-assistant line is a plain user turn.
      // Do not count prose that directly precedes an AskUserQuestion in the same turn.
      if (!turn.hasAskUserQuestion && turn.blocks.length > 0) {
        const lastBlock = turn.blocks[turn.blocks.length - 1];
        if (lastBlock.type === 'text' && typeof lastBlock.text === 'string') {
          const trimmed = lastBlock.text.trim();
          if (/\?\s*$/.test(trimmed)) {
            // Find next non-assistant line
            let nextNonAssistantLine: Record<string, any> | undefined;
            for (let next = t + 1; next < turns.length; next++) {
              if (turns[next].kind === 'other') {
                nextNonAssistantLine = turns[next].line;
                break;
              }
            }
            if (nextNonAssistantLine && isPlainUserTurn(nextNonAssistantLine)) {
              turn.proseQuestion = trimmed;
            }
          }
        }
      }

      // Model questions asked in this turn
      const questionsInTurn: { type: 'ask' | 'prose'; text: string }[] = [];

      if (turn.hasAskUserQuestion) {
        totalAskCalls += turn.askCalls;
        totalAskItems += turn.askItems.length;
        for (const itemText of turn.askItems) {
          questionsInTurn.push({ type: 'ask', text: itemText });
        }
      }

      if (turn.proseQuestion) {
        totalProseQuestions++;
        questionsInTurn.push({ type: 'prose', text: turn.proseQuestion });
      }

      if (questionsInTurn.length > 0) {
        totalBatches++;

        // Measure time blocked until next user turn
        if (turn.timestamp) {
          const tAsk = Date.parse(turn.timestamp);
          let nextUserTime: number | undefined;
          for (let next = t + 1; next < turns.length; next++) {
            const nextItem = turns[next];
            if (nextItem.kind === 'other' && nextItem.line) {
              const l = nextItem.line;
              if (l.type === 'user' || l.message?.role === 'user') {
                if (typeof l.timestamp === 'string') {
                  const tU = Date.parse(l.timestamp);
                  if (!isNaN(tU)) {
                    nextUserTime = tU;
                    break;
                  }
                }
              }
            }
          }

          if (nextUserTime !== undefined && !isNaN(tAsk)) {
            let gap = Math.max(0, Math.round((nextUserTime - tAsk) / 1000));
            if (gap > MAX_TIME_BLOCKED_GAP) gap = MAX_TIME_BLOCKED_GAP;
            measuredGaps.push(gap);
            totalBlockedSeconds += gap;
          } else {
            unmeasuredBatches++;
          }
        } else {
          unmeasuredBatches++;
        }

        // Process repeats
        for (const q of questionsInTurn) {
          if (q.type === 'prose') {
            const words = q.text.trim().split(/\s+/).filter(Boolean);
            if (words.length < 5) {
              continue; // Exclude generic prose shorter than 5 words from repeat matching
            }
          }

          const norm = normalizeQuestion(q.text);
          if (!norm) continue;

          // In-session repeat
          if (sessionQuestions.has(norm)) {
            totalRepeatsInSession++;
            sessionHadRepeat = true;
          } else {
            sessionQuestions.add(norm);
          }

          // Post-compaction re-ask
          if (sessionCompacted && preCompactionQuestions.has(norm)) {
            totalPostCompactionReasks++;
          }
          if (!sessionCompacted) {
            preCompactionQuestions.add(norm);
          }

          // Cross-session repeat within project
          if (!projectQuestions.has(session.project)) {
            projectQuestions.set(session.project, new Set<string>());
          }
          const projSet = projectQuestions.get(session.project)!;
          if (projSet.has(norm) && !sessionFirstSeen.has(norm)) {
            totalRepeatsAcrossSessions++;
            sessionHadRepeat = true;
          }
          sessionFirstSeen.add(norm);
        }
      }
    }

    if (sessionHadRepeat) {
      totalSessionsWithRepeats++;
    }

    if (!projectQuestions.has(session.project)) {
      projectQuestions.set(session.project, new Set<string>());
    }
    const projSet = projectQuestions.get(session.project)!;
    for (const q of sessionQuestions) {
      projSet.add(q);
    }
  }

  // Calculate median time blocked
  measuredGaps.sort((a, b) => a - b);
  let medianTimeBlockedSeconds = 0;
  if (measuredGaps.length > 0) {
    const mid = Math.floor(measuredGaps.length / 2);
    if (measuredGaps.length % 2 === 1) {
      medianTimeBlockedSeconds = measuredGaps[mid];
    } else {
      medianTimeBlockedSeconds = Math.round((measuredGaps[mid - 1] + measuredGaps[mid]) / 2);
    }
  }

  const totalQuestions = totalAskCalls + totalProseQuestions;
  const meanBatchesPerSession = totalSessions > 0
    ? Math.round((totalBatches / totalSessions) * 10) / 10
    : 0;

  return {
    sessions: totalSessions,
    questions: totalQuestions,
    batches: totalBatches,
    repeatsInSession: totalRepeatsInSession,
    repeatsAcrossSessions: totalRepeatsAcrossSessions,
    sessionsWithRepeats: totalSessionsWithRepeats,
    postCompactionReasks: totalPostCompactionReasks,
    timeBlockedSeconds: totalBlockedSeconds,
    timeBlockedMedianSeconds: medianTimeBlockedSeconds,
    unmeasuredBatches,
    userRejections: totalUserRejections,
    planCycles: totalPlanCycles,
    planCyclesWithNoEdits: totalPlanCyclesWithNoEdits,
    skippedFiles,
    oversizeFiles,
    breakdown: {
      askCalls: totalAskCalls,
      askItems: totalAskItems,
      proseQuestions: totalProseQuestions,
      planCycles: totalPlanCycles,
      planCyclesWithNoEdits: totalPlanCyclesWithNoEdits,
      totalTimeBlockedSeconds: totalBlockedSeconds,
      medianTimeBlockedSeconds,
      unmeasuredBatches,
      meanBatchesPerSession,
    },
  };
}

export function formatAsksSummary(m: AsksMetrics): string {
  return [
    `Asks metrics:`,
    `  Sessions: ${m.sessions}`,
    `  Questions: ${m.questions} (tool calls: ${m.breakdown.askCalls}, items: ${m.breakdown.askItems}, prose: ${m.breakdown.proseQuestions})`,
    `  Batches: ${m.batches} (${m.breakdown.meanBatchesPerSession.toFixed(1)}/session, unmeasured: ${m.unmeasuredBatches})`,
    `  Repeats in session: ${m.repeatsInSession}`,
    `  Repeats across sessions: ${m.repeatsAcrossSessions}`,
    `  Sessions with repeats: ${m.sessionsWithRepeats}`,
    `  Post-compaction re-asks: ${m.postCompactionReasks}`,
    `  Time blocked: ${m.timeBlockedSeconds}s (median: ${m.timeBlockedMedianSeconds}s)`,
    `  User rejections: ${m.userRejections}`,
    `  Plan cycles: ${m.planCycles} (no edits: ${m.planCyclesWithNoEdits})`,
    `  Files: skipped: ${m.skippedFiles}, oversize: ${m.oversizeFiles}`,
  ].join('\n');
}

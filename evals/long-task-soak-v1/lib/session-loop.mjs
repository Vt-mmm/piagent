import fs from 'node:fs';
import path from 'node:path';
import { Persona, asksWhatFails } from './persona.mjs';
import { classifyTurn, asksMember, claimsDone, verdict } from './judge.mjs';
import { runOracle, protectedChanges, phasesOf, phaseOracle } from './workspace.mjs';

const MINUTE = 60_000;
// What a member sees fail: the check's name and its first problem line.
const failingOf = oracle => oracle.checks.filter(c => !c.pass).map(c => {
  const line = c.tail.split('\n').map(l => l.trim()).find(l => /problem|fail|error|assert|✖|expected/i.test(l) && l.length < 240);
  return line ? `${c.name}: ${line}` : c.name;
});
const wait = ms => new Promise(r => setTimeout(r, ms));

// One scenario on one surface, played by the simulated member until the
// oracle passes or the member would have given up.
//
// A surface implements: open({project, scenario, runDir, hooks}),
// send(text, delivery: 'new'|'steer'|'follow_up'), nextTurnEnd() →
// {lastText, turnEnd, error, crashed?, restarted?}, stop(), restart() → bool,
// close(). hooks: onEvent(normalized), onQuestion(q) → answer,
// onApproval(request) → boolean.
export async function playScenario({ scenario, surface, prepared, runDir }) {
  const budget = { maxMinutes: 120, maxNudges: 3, stallMinutes: 15, ...(scenario.budget ?? {}) };
  const persona = new Persona(scenario), started = Date.now(), log = fs.createWriteStream(path.join(runDir, 'events.jsonl'));
  const stats = { turns: 0, toolCalls: 0, toolErrors: 0, providerRetries: 0, compactions: 0, capacityWaits: 0, assistantMessages: 0,
    nudges: 0, stalls: 0, crashes: 0, restarts: 0, memberStops: 0, steers: 0, questions: 0, proseAnswers: 0, approvals: 0, inputTokens: 0, outputTokens: 0, workspaceActions: 0 };
  const turns = [], defects = [], actions = (scenario.userActions ?? []).map(a => ({ ...a, fired: false }));
  const record = (type, data = {}) => log.write(JSON.stringify({ t: Date.now() - started, type, ...data }) + '\n');
  let lastActivity = Date.now(), pendingAction = null;

  const due = a => !a.fired && ((a.when?.toolCalls != null && stats.toolCalls >= a.when.toolCalls)
    || (a.when?.turns != null && stats.turns >= a.when.turns)
    || (a.when?.minutes != null && Date.now() - started >= a.when.minutes * MINUTE));
  const hooks = {
    onEvent(e) {
      lastActivity = Date.now();
      if (e.type === 'tool_start') stats.toolCalls++;
      if (e.type === 'tool_end' && e.isError) stats.toolErrors++;
      if (e.type === 'provider_retry') stats.providerRetries++;
      if (e.type === 'compaction') stats.compactions++;
      if (e.type === 'capacity_wait') stats.capacityWaits++;
      if (e.type === 'assistant_message') { stats.assistantMessages++; stats.inputTokens += e.inputTokens ?? 0; stats.outputTokens += e.outputTokens ?? 0; }
      if (e.type !== 'text_delta') record(e.type, e);
      const action = actions.find(due);
      if (action && !pendingAction) { action.fired = true; pendingAction = fire(action); }
    },
    onQuestion(q) {
      lastActivity = Date.now(); stats.questions++;
      const answer = persona.answerStructured(q);
      record('question', { question: q.question, options: q.options, answer });
      return answer;
    },
    onApproval(request) {
      lastActivity = Date.now(); stats.approvals++;
      const allow = scenario.approvals !== 'deny';
      record('approval', { title: request.title, allow });
      return allow;
    },
  };

  // The member acting while the agent works: adds a requirement, presses
  // Stop and writes again, or closes the window and reopens the conversation.
  async function fire(action) {
    record('member_action', { do: action.do, text: action.text });
    try {
      if (action.do === 'steer' || action.do === 'follow_up') { stats.steers++; await surface.send(action.text, action.do); }
      else if (action.do === 'stop_then_continue') { stats.memberStops++; await surface.stop(); return { resume: action.text ?? persona.afterStall() }; }
      else if (action.do === 'restart') {
        // 'reopened': the conversation stopped with the process and the
        // member writes again; 'reattached': it kept running meanwhile.
        stats.restarts++;
        const restarted = await surface.restart({ hard: !!action.hard });
        if (restarted === 'reopened') return { resume: action.text ?? persona.afterStall() };
        if (!restarted) record('member_action_unsupported', { do: action.do });
      }
      else if (['editor_save', 'terminal_test'].includes(action.do)) {
        if (!surface.memberAction) throw Error('workspace-actions-require-webui');
        const result = await surface.memberAction(action);
        action.completed = true; stats.workspaceActions++;
        record('member_action_completed', { do: action.do, ...result });
      }
    } catch (error) {
      record('member_action_failed', { do: action.do, error: String(error?.message ?? error) });
      if (['editor_save', 'terminal_test'].includes(action.do)) defects.push({ defect: 'workspace_action_failed', action: action.do });
    }
    return null;
  }

  // Waits for the turn to end; a turn with no activity for stallMinutes is a
  // stall the member answers with Stop.
  async function turnEnd() {
    const ended = surface.nextTurnEnd();
    for (;;) {
      const tick = await Promise.race([ended, wait(5000).then(() => null)]);
      if (tick) return tick;
      if (Date.now() - started > budget.maxMinutes * MINUTE) { await surface.stop().catch(() => {}); return { ...(await Promise.race([ended, wait(2 * MINUTE).then(() => ({}))])), timedOut: true }; }
      if (Date.now() - lastActivity > budget.stallMinutes * MINUTE) {
        stats.stalls++; record('stall', { minutes: budget.stallMinutes }); lastActivity = Date.now();
        await surface.stop().catch(() => {});
        const after = await Promise.race([ended, wait(2 * MINUTE).then(() => ({ lastText: '', turnEnd: null }))]);
        return { ...after, stalled: true };
      }
    }
  }

  await surface.open({ project: prepared.project, scenario, runDir, hooks });
  const phases = phasesOf(scenario);
  let oracle = null, finalTurn = null, phase = 0;
  const check = attempt => runOracle({ scenario, oracle: phaseOracle(scenario, phase), project: prepared.project, runDir, attempt: `${phases[phase].id}-${attempt}` });
  try {
    await surface.send(scenario.prompt, 'new');
    for (;;) {
      const turn = await turnEnd();
      stats.turns++; finalTurn = turn;
      const action = pendingAction ? await pendingAction : null; pendingAction = null;
      // Ordered member work at a settled turn must finish before oracle judging.
      for (const next of actions.filter(a => ['editor_save', 'terminal_test'].includes(a.do) && due(a))) {
        next.fired = true; await fire(next);
      }
      if (turn.crashed) {
        stats.crashes++; record('crash', { detail: turn.error });
        if (!(await surface.restart().catch(() => false))) { defects.push({ turn: stats.turns, defect: 'process_crashed_unrecoverable' }); break; }
      }
      if (turn.timedOut) { defects.push({ turn: stats.turns, defect: 'time_budget_exceeded' }); oracle = await check(stats.turns); break; }
      const text = turn.lastText ?? '';
      const asking = asksMember(text) && !claimsDone(text);
      oracle = asking && !asksWhatFails(text) && !turn.stalled && !turn.crashed ? null : await check(stats.turns);
      const judged = action?.resume && !oracle?.pass ? { kind: 'member_resumed', defect: null } : classifyTurn(turn, oracle);
      turns.push({ n: stats.turns, phase: phases[phase].id, minutes: +((Date.now() - started) / MINUTE).toFixed(1), kind: judged.kind, defect: judged.defect,
        turnEnd: turn.turnEnd?.state ?? null, error: turn.error ?? null, oracle: oracle && { pass: oracle.pass, failed: oracle.checks.filter(c => !c.pass).map(c => c.name) },
        lastText: text.slice(-1200) });
      record('turn', turns.at(-1));
      if (judged.defect) defects.push({ turn: stats.turns, defect: judged.defect });
      if (judged.kind === 'done') {
        // The member moves on to the next piece of work in the same
        // conversation, as members do in a long session.
        if (++phase >= phases.length) break;
        record('phase', { id: phases[phase].id });
        record('member_message', { text: phases[phase].prompt });
        oracle = null; await surface.send(phases[phase].prompt, 'new'); continue;
      }
      const pushes = stats.nudges + stats.stalls + stats.crashes;
      let reply;
      if (judged.kind === 'member_resumed') reply = action.resume;
      else if (judged.kind === 'asked') {
        // Answering is the member's job, but an agent that keeps asking is
        // pushing back as surely as one that stops: past the decisions it
        // could need, each further question costs a push.
        reply = oracle && !oracle.pass && asksWhatFails(text) ? persona.failingText(failingOf(oracle)) : persona.answerProse(text);
        if (++stats.proseAnswers > (scenario.decisions?.length ?? 0) + 2) { if (pushes >= budget.maxNudges) break; stats.nudges++; defects.push({ turn: stats.turns, defect: 'kept_asking' }); }
      }
      else if (judged.kind === 'stalled') reply = persona.afterStall();
      else if (judged.kind === 'crashed') reply = persona.afterStall();
      else { if (pushes >= budget.maxNudges) break; stats.nudges++; reply = persona.nudge(judged.kind, oracle ? failingOf(oracle) : []); }
      if (pushes > budget.maxNudges) break;
      if (Date.now() - started > budget.maxMinutes * MINUTE) { defects.push({ turn: stats.turns, defect: 'time_budget_exceeded' }); break; }
      record('member_message', { text: reply });
      await surface.send(reply, 'new');
    }
  } finally {
    await surface.close().catch(() => {});
    log.end();
  }
  const phasesDone = Math.min(phase, phases.length);
  if (phase >= phases.length) phase = phases.length - 1;
  if (!oracle) oracle = await check('final');
  const touched = protectedChanges(prepared.project, prepared.protect);
  const notAsked = persona.notAsked();
  for (const file of touched) defects.push({ defect: 'protected_file_changed', file });
  for (const id of notAsked) defects.push({ defect: 'business_decision_not_asked', decision: id });
  if (scenario.questionsExpected === false) for (const q of persona.unexpected) defects.push({ defect: 'unneeded_question', question: q.slice(0, 200) });
  const workspaceActionsComplete = actions.filter(a => ['editor_save', 'terminal_test'].includes(a.do)).every(a => a.completed);
  if (!workspaceActionsComplete) defects.push({ defect: 'workspace_actions_incomplete' });
  const pass = phasesDone === phases.length && oracle.pass && touched.length === 0 && workspaceActionsComplete;
  return {
    scenario: scenario.id, pass, verdict: verdict({ pass, ...stats, maxNudges: budget.maxNudges }),
    minutes: +((Date.now() - started) / MINUTE).toFixed(1), phases: `${phasesDone}/${phases.length}`, stats, defects, turns, oracle,
    decisions: Object.fromEntries(persona.asked), unexpectedQuestions: persona.unexpected, lastText: (finalTurn?.lastText ?? '').slice(-1500),
  };
}

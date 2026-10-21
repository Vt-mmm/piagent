// Skill feedback (after Cognee's proposal-first skill improvement): which
// skills a round used, and whether the round ended badly (its last check
// failed, or a command failed the same way twice). A skill that keeps ending
// badly gets a proposal file to review under .pi/piagent-state/skill-proposals;
// Piagent never edits a skill itself and makes no model call for this.
import fs from 'node:fs';
import path from 'node:path';

const MIN_FAILURES = 3, MIN_SHARE = 0.5, KEEP = 10, REPROPOSE_MS = 7 * 86400_000;
const safeName = name => String(name).replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 80);

export class SkillFeedback {
  // A managed round's tracker, when the conversation has skills.
  static forRound(self, text) {
    if (!self.resources?.skills?.length) return null;
    const feedback = new SkillFeedback({ cwd: self.cwd, skills: self.resources.skills });
    feedback.request(text);
    return feedback;
  }
  constructor({ cwd, skills = [], now = Date.now }) {
    this.cwd = cwd; this.now = now; this.used = new Set();
    this.skills = skills.filter(s => s?.name && s?.filePath).map(s => ({ name: s.name, file: path.resolve(s.filePath) }));
  }
  // A member's /skill:name arrives expanded as a <skill name="..."> block.
  request(text) {
    for (const m of String(text ?? '').matchAll(/<skill name="([^"]{1,80})"/g)) if (this.skills.some(s => s.name === m[1])) this.used.add(m[1]);
  }
  // The model reading a skill's SKILL.md is the skill being used.
  event(event) {
    if (event?.type !== 'tool_execution_start' || event.toolName !== 'read' || typeof event.args?.path !== 'string') return;
    const file = path.resolve(this.cwd, event.args.path);
    for (const s of this.skills) if (s.file === file) this.used.add(s.name);
  }
  // The round's end: counts for every skill it used; returns the proposals written.
  close({ checks = 'none', lessons = [] } = {}) {
    if (!this.used.size || !this.cwd) return [];
    const errors = lessons.filter(l => l.kind === 'tool_error');
    const bad = checks === 'failed' || errors.length > 0;
    const written = [];
    let dir;
    // Inside the project's own state folder only: never through a link.
    try {
      const state = path.join(fs.realpathSync(this.cwd), '.pi', 'piagent-state');
      dir = path.join(state, 'skill-proposals');
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      if (fs.realpathSync(dir) !== dir || fs.lstatSync(dir).isSymbolicLink()) return [];
    } catch { return []; }
    for (const name of this.used) {
      const file = path.join(dir, `${safeName(name)}.json`);
      let state = { name, uses: 0, failures: [], proposed_at: null };
      try { state = { ...state, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch { /* first use */ }
      state.uses++;
      if (bad) {
        const detail = checks === 'failed' ? 'the round\'s last check failed' : errors[0].line;
        state.failures = [...state.failures, { at: new Date(this.now()).toISOString(), detail: String(detail).slice(0, 400) }].slice(-KEEP);
      }
      const recent = state.failures.length, share = recent / Math.min(state.uses, KEEP);
      const due = recent >= MIN_FAILURES && share >= MIN_SHARE && (!state.proposed_at || this.now() - Date.parse(state.proposed_at) > REPROPOSE_MS);
      if (due) {
        state.proposed_at = new Date(this.now()).toISOString();
        const skill = this.skills.find(s => s.name === name);
        const proposal = path.join(dir, `${safeName(name)}.md`);
        fs.writeFileSync(proposal, [
          `# Review the skill "${name}"`, '',
          `Proposed ${state.proposed_at} by Piagent. Nothing was changed: read the evidence, then edit the skill yourself or delete this file.`, '',
          `Skill file: ${skill ? path.relative(this.cwd, skill.file) || skill.file : 'unknown'}`, '',
          `${recent} of the last ${Math.min(state.uses, KEEP)} rounds that used it ended badly:`, '',
          ...state.failures.map(f => `- ${f.at}: ${f.detail}`), '',
          'Look for: a step the skill tells the agent to run that no longer works here (a command, flag, path or check),',
          'instructions that contradict the repository\'s current conventions, or a missing prerequisite.', ''].join('\n'), { mode: 0o600 });
        written.push(proposal);
        state.failures = [];
      }
      fs.writeFileSync(file, JSON.stringify(state, null, 1), { mode: 0o600 });
    }
    this.used.clear();
    return written;
  }
}

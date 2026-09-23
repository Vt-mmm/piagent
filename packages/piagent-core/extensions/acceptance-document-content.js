import crypto from 'node:crypto';
import { acceptanceCriterionBindingValid } from './acceptance-behavior-proof.js';
import { durableContextEvidenceEntries } from './context-evidence.js';
import { matchesAnyPath } from './policy-core.js';
import { captureWorkspaceVerificationSnapshot } from './workspace-verification-snapshot.js';
import { readWorkspaceFile } from '../security/workspace-file-reader.ts';

const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const normalize = value => value.replace(/\s+/g, ' ').trim();
const safePath = value => /^[A-Za-z0-9_./-]{1,240}$/.test(value)
  && value.split('/').every(part => part && part !== '.' && part !== '..' && !part.startsWith('.'));

// Only operator-bound literal-copy requests qualify. Data values never supply
// paths, commands, permission or new obligations to this reader.
export function documentContentRule(request) {
  if (typeof request !== 'string' || request.length > 16000) return null;
  const text = normalize(request);
  const update = [...text.matchAll(/(?:^|[.!?] )Update `([^`]+)` with the ([A-Za-z][A-Za-z ,_-]{1,140}) from `([^`]+)`\./g)];
  const scope = [...text.matchAll(/(?:^|[.!?] )Change only `([^`]+)`, include (both|all) configuration values verbatim, and run the configured verification\./g)];
  if (update.length !== 1 || scope.length !== 1) return null;
  const [, documentPath, names, configPath] = update[0];
  if (scope[0][1] !== documentPath || !safePath(documentPath) || !safePath(configPath)
    || !/\.(?:md|txt)$/.test(documentPath) || !/\.json$/.test(configPath)) return null;
  const labels = names.split(/,\s*(?:and\s+)?|\s+and\s+/).map(value => value.trim());
  if (labels.length < 2 || labels.length > 8 || labels.some(value => !/^[A-Za-z][A-Za-z _-]{0,50}$/.test(value))
    || new Set(labels).size !== labels.length || scope[0][2] === 'both' && labels.length !== 2) return null;
  return { documentPath, configPath, labels, clauses: [update[0][0].replace(/^[.!?] /, ''), scope[0][0].replace(/^[.!?] /, '')] };
}

export function documentContentCriterionEvidence({task, criterion, corpus, cwd, passingVerifier, verifierEvidence, currentWorkingTreeDigest, workspaceRevisionDigest}) {
  const rule = documentContentRule(task?.operatorRequest);
  if (!rule) return {handled: false};
  const index = task.acceptanceReceipt?.criteria.findIndex(item => item.id === criterion?.id) ?? -1;
  const selected = task.acceptanceCriteria?.[index];
  if (typeof selected !== 'string' || !rule.clauses.includes(normalize(selected))) return {handled: false};
  const missing = {handled: true};
  if (task.operatorRequestDigest !== `operator-request-v1:${sha(task.operatorRequest)}`
    || !acceptanceCriterionBindingValid(task, task.acceptanceReceipt, criterion, index)
    || task.changeMode !== 'source-change' || !passingVerifier || !verifierEvidence || !cwd
    || verifierEvidence.workingTreeDigest !== currentWorkingTreeDigest || verifierEvidence.exitCode !== 0
    || corpus.files.length !== 1 || corpus.files[0] !== rule.documentPath) return missing;
  const forbidden = [...(task.protectedPaths ?? []), ...(task.outOfScope ?? [])];
  if ([rule.documentPath, rule.configPath].some(file => matchesAnyPath(file, forbidden))) return missing;
  if (!durableContextEvidenceEntries(task).some(entry => entry.path === rule.configPath)) return missing;
  try {
    const before = captureWorkspaceVerificationSnapshot(cwd);
    if (!before.proofCapable || before.digest !== currentWorkingTreeDigest
      || before.workspaceRevisionDigest !== workspaceRevisionDigest) return missing;
    const configBytes = readWorkspaceFile(cwd, rule.configPath, 65536);
    const documentBytes = readWorkspaceFile(cwd, rule.documentPath, 262144);
    const decode = bytes => new TextDecoder('utf-8', {fatal: true}).decode(bytes);
    const config = JSON.parse(decode(configBytes)), document = decode(documentBytes);
    if (!config || typeof config !== 'object' || Array.isArray(config)) return missing;
    const keyName = value => value.replace(/[ _-]/g, '').toLowerCase();
    const keys = rule.labels.map(label => {
      const labels = new Set([keyName(label), keyName(label.replace(/ name$/i, ''))]);
      const candidates = Object.keys(config).filter(key => labels.has(keyName(key)));
      return candidates.length === 1 ? candidates[0] : null;
    });
    if (keys.some(key => key === null) || new Set(keys).size !== keys.length) return missing;
    if (keys.some(key => typeof config[key] !== 'string' || !config[key].trim() || !document.includes(config[key]))) return missing;
    // Recheck both reads before publishing their combined content binding.
    if (!configBytes.equals(readWorkspaceFile(cwd, rule.configPath, 65536))
      || !documentBytes.equals(readWorkspaceFile(cwd, rule.documentPath, 262144))) return missing;
    const after = captureWorkspaceVerificationSnapshot(cwd);
    if (!after.proofCapable || before.digest !== after.digest || before.workspaceRevisionDigest !== after.workspaceRevisionDigest) return missing;
    const binding = sha(JSON.stringify({version: 1, request: task.operatorRequestDigest,
      criterion: criterion.hash, config: sha(configBytes), document: sha(documentBytes), keys}));
    return {handled: true, evidence: {...verifierEvidence, kind: 'document-content-proof',
      summary: `Operator-requested configuration values occur verbatim in the sole changed document; content binding sha256:${binding}.`,
      paths: [rule.documentPath, rule.configPath]}};
  } catch { return missing; }
}

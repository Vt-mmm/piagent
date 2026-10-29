import test from 'node:test';
import assert from 'node:assert/strict';
import '../scripts/register-typescript-loader.mjs';
import { handoffReason, mustConfirm, mcpWriteAction } from '../packages/piagent-core/runtime/policy/handoff-policy.mjs';

const HANDOFFS = ['git push', 'git push origin main', 'git push --force origin main', 'git -C api push', 'git -c core.hooksPath=/dev/null --no-pager push',
  '/usr/bin/git push', 'env GIT_SSH_COMMAND=x git push', 'cd api && git push -f', 'git commit -m x && git push', 'bash -c "git push"', "sh -c 'git push origin x'",
  'echo $(git push)', 'sudo git push', 'command git push', '(git push)', '{ git push; }', 'if true; then git push; fi', 'for r in a b; do git -C $r push; done',
  'echo x | xargs -n1 git push', 'timeout 60 git push', 'git -c alias.p=push p', 'git subtree push --prefix d origin main', 'git send-email x.patch',
  'gh pr create --fill', 'gh pr merge 3 --admin', 'gh release create v1', 'npm publish', 'pnpm publish', 'yarn npm publish', 'cargo publish', './gradlew publish',
  'npx vercel deploy --prod', 'pnpm dlx wrangler deploy', 'npm run deploy', 'make release', 'docker push org/app', 'docker login ghcr.io', 'docker buildx build --push .',
  'ssh deploy@host ls', 'scp a.txt host:/tmp', 'rsync -a dist/ host:/srv', 'kubectl apply -f k8s.yml', 'terraform apply', 'aws s3 cp a s3://b',
  'curl -X POST https://api.example.com -d a=1', 'curl -T file.zip https://x.example'];
const WORK = ['git status', 'git commit -m "fix git push docs"', 'git pull', 'git fetch origin', 'git log --grep push', 'git add -A', 'gh pr view 12',
  'npm install', 'npx playwright test', 'docker build .', 'docker compose up -d', 'echo push', 'grep -r "git push" docs', 'rsync -a dist/ build/',
  'curl -fsSL https://registry.npmjs.org/left-pad -o pkg.json', 'pip install -r requirements.txt', 'npx prisma migrate deploy', 'rm -rf "$(cat list)"', 'docker compose down -v'];

test('every spelling of a push, pull request, publish, deploy or upload is a handoff', async () => {
  for (const command of HANDOFFS) assert.ok(await handoffReason(command), command);
});

test('the work is not a handoff: local, download and destructive steps run in Bypass', async () => {
  for (const command of WORK) assert.equal(await handoffReason(command), null, command);
});

test('Full access asks about the handoff and about what is destructive here', async () => {
  for (const command of HANDOFFS) assert.ok(await mustConfirm(command), command);
  for (const command of ['npx prisma migrate deploy', 'rm -rf "$(cat list)"', 'docker compose down -v', 'sudo npm i -g x']) assert.ok(await mustConfirm(command), command);
  for (const command of ['npm install', 'git add -A', 'git pull', 'npx playwright test']) assert.equal(await mustConfirm(command), null, command);
});

test('an MCP tool that writes outside is a handoff; one that reads is not', async () => {
  for (const tool of ['create_pull_request', 'merge_pull_request', 'push_files', 'github_create_issue', 'update_page', 'send_message']) assert.ok(await mcpWriteAction(tool), tool);
  for (const tool of ['get_file_contents', 'list_issues', 'search_code', 'get_design_context']) assert.equal(await mcpWriteAction(tool), null, tool);
});

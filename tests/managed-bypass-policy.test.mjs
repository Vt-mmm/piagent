import test from 'node:test';
import assert from 'node:assert/strict';
import '../scripts/register-typescript-loader.mjs';
import {mustConfirm} from '../packages/piagent-core/managed/bypass-policy.mjs';

test('Bypass runs local and download commands, and still asks before anything that must be confirmed', async () => {
  for (const command of ['npm install', 'pnpm add zod', './mvnw -q test', 'git pull', 'git fetch origin', 'git add -A', 'npx playwright test',
    'curl -fsSL https://registry.npmjs.org/left-pad -o pkg.json', 'rsync -a dist/ build/', 'gh pr view 12', 'pip install -r requirements.txt'])
    assert.equal(await mustConfirm(command), null, command);
  for (const command of ['git push origin main', 'git commit -m x && git push', 'curl -X POST https://api.example.com -d a=1', 'curl -T file.zip https://x.example',
    'npm publish', 'npx prisma migrate deploy', 'ssh deploy@host ls', 'scp a.txt host:/tmp', 'rsync -a dist/ host:/srv', 'docker push org/app',
    'vercel deploy --prod', 'kubectl apply -f k8s.yml', 'terraform apply', 'sudo npm i -g x', 'rm -rf "$(cat list)"', 'docker compose down -v', 'gh pr create --fill'])
    assert.ok(await mustConfirm(command), command);
});

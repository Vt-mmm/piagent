import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {chromium, expect} from '@playwright/test';
import '../../scripts/register-typescript-loader.mjs';
import {startManagedGateway} from '../../packages/piagent-webui/gateway/managed-gateway.mjs';
import {requestGatewayControl} from '../../packages/piagent-webui/gateway/control-socket.ts';

export async function runWeb(config,configPath) {
 const packageRoot=path.resolve(import.meta.dirname,'../..');
 const agentDir=path.join(path.dirname(configPath),'managed-web');
 let gateway,browser;
 try {
  gateway=await startManagedGateway({config:{...config,profile_id:config.profileID,sdk_root:config.sdkRoot},configPath,cwd:config.project,agentDir,packageRoot});
  const launch=await requestGatewayControl(gateway.descriptor.controlSocket,{action:'issue-launch-url'});
  assert.equal(launch.ok,true);
  browser=await chromium.launch({headless:true,executablePath:process.env.PIAGENT_WEBUI_CHROMIUM || undefined});
  const page=await browser.newPage({viewport:{width:1280,height:860},locale:'vi-VN',reducedMotion:'reduce'});
  page.setDefaultTimeout(10000);
  const errors=[];page.on('pageerror',e=>errors.push(e.name));
  await page.goto(launch.value.launchUrl);
  await page.getByRole('button',{name:/Cuộc trò chuyện mới|New chat/}).last().click();
  await expect(page.getByRole('button',{name:/Model: agent-watch-auto/})).toBeVisible();
  await page.getByRole('button',{name:/Thêm tùy chọn|More options/}).click();
  await expect(page.getByRole('button',{name:/Quyền theo profile|Profile access/})).toHaveCount(0);
  await page.getByPlaceholder(/Nhắn cho Piagent|Message Piagent/).fill('alo 123');
  for(const width of [1280,768,390]) {
   await page.setViewportSize({width,height:860});
   await page.waitForTimeout(200);
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true,`overflow ${width}`);
  }
  await page.getByRole('button',{name:/^Gửi$|^Send$/}).click();
  await expect(page.getByText('STUDIO_FIXTURE_OK',{exact:true})).toBeVisible({timeout:15000});
  await expect(page.getByRole('main').getByText('alo 123',{exact:true}).last()).toBeVisible();
  assert.equal(await page.getByText('/taskalo 123',{exact:true}).count(),0);
  const output=path.join(packageRoot,'.cache');fs.mkdirSync(output,{recursive:true});
  await page.screenshot({path:path.join(output,`managed-web-${config.provider}.png`),fullPage:true});
  assert.deepEqual(errors,[]);
 } finally {await browser?.close();await gateway?.close();}
}

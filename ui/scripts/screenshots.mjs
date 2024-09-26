// Screenshots of the main views against the running stack (make app-up), desktop and mobile.
//   node ui/scripts/screenshots.mjs [http://localhost:8088]
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const base = process.argv[2] ?? 'http://localhost:8088';
const out = path.resolve(import.meta.dirname, '../../docs/screenshots');
fs.mkdirSync(out, { recursive: true });

async function signIn(page, org, user) {
  await page.goto(base);
  if (org === 'org2') await page.getByRole('tab', { name: 'Riverside Clinic' }).click();
  await page.getByRole('button', { name: new RegExp(user.label) }).click();
  await page.getByRole('button', { name: /^Sign in to/ }).click();
  await page.waitForSelector('.page-head', { timeout: 120_000 });
  await page.waitForLoadState('networkidle', { timeout: 120_000 }).catch(() => undefined);
}

const shots = [
  { name: 'login', org: 'org1', user: null },
  { name: 'patient', org: 'org1', user: { label: 'Alice Moreno' } },
  { name: 'doctor', org: 'org1', user: { label: 'Dr. Lin Chen' }, after: async (p) => {
      await p.getByRole('button', { name: 'Open' }).first().click();
      await p.waitForSelector('.phi', { timeout: 60_000 });
    } },
  { name: 'breakglass', org: 'org2', user: { label: 'Dr. Sofia Rivera' }, after: async (p) => {
      await p.getByRole('button', { name: /Emergency access/ }).click();
      await p.getByLabel('Patient ID', { exact: true }).fill('P-1002');
      await p.getByLabel('Retype patient ID').fill('P-1002');
      await p.getByLabel(/Clinical reason/).fill('Unresponsive in the ER, need allergy history');
    } },
  { name: 'admin', org: 'org1', user: { label: 'Ada Okafor' }, after: async (p) => {
      await p.waitForSelector('.ring .node', { timeout: 60_000 });
    } },
];

const browser = await chromium.launch();
for (const [vp, size] of [['desktop', { width: 1280, height: 900 }], ['mobile', { width: 390, height: 844 }]]) {
  for (const s of shots) {
    const page = await browser.newPage({ viewport: size, deviceScaleFactor: vp === 'mobile' ? 2 : 1 });
    if (s.user) await signIn(page, s.org, s.user);
    else await page.goto(base);
    if (s.after) await s.after(page);
    await page.waitForTimeout(600);
    await page.screenshot({ path: path.join(out, `${s.name}-${vp}.png`), fullPage: vp === 'desktop' });
    console.log(`${s.name}-${vp}.png`);
    await page.close();
  }
}
await browser.close();

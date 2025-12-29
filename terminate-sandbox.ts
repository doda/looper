import { ModalClient } from 'modal';
async function main() {
  const sandboxId = process.argv[2];
  const projectName = process.argv[3];
  if (!sandboxId || !projectName) {
    console.error('Usage: npx tsx terminate-sandbox.ts <sandbox-id> <project-name>');
    process.exit(1);
  }

  const appName = `looper-${projectName}`;
  const client = new ModalClient();
  const app = await client.apps.fromName(appName, { createIfMissing: false });

  for await (const sb of client.sandboxes.list({ appId: app.appId })) {
    if (sb.sandboxId === sandboxId) {
      await sb.terminate();
      console.log('Terminated:', sandboxId);
      return;
    }
  }
  console.log('Sandbox not found:', sandboxId);
}
main();

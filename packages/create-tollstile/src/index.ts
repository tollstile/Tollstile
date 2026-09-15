import { basename, resolve } from 'node:path';
import process from 'node:process';
import { scaffold } from './scaffold';

const target = process.argv[2] ?? 'my-paid-api';
const directory = resolve(process.cwd(), target);
const name = basename(directory);

const result = await scaffold(directory, name);

switch (result.status) {
  case 'invalid_name':
    console.error(result.reason);
    process.exitCode = 1;
    break;
  case 'not_empty':
    console.error(`${target} already exists and is not empty. Choose another directory name.`);
    process.exitCode = 1;
    break;
  case 'created': {
    const runner = packageManager();
    console.log(`\nCreated ${name} with a paid route and a test agent.\n`);
    console.log(`  cd ${target}`);
    console.log(`  ${runner} install`);
    console.log(`  ${runner} run dev`);
    console.log(`  ${runner} run agent   # in another terminal\n`);
    break;
  }
}

function packageManager(): string {
  const agent = process.env.npm_config_user_agent ?? '';
  if (agent.startsWith('pnpm')) return 'pnpm';
  if (agent.startsWith('yarn')) return 'yarn';
  if (agent.startsWith('bun')) return 'bun';
  return 'npm';
}

#!/usr/bin/env npx tsx
import { spawn } from 'child_process';

console.log('Testing spawn with different configurations...\n');

async function testSpawn(name: string, args: string[], options: any): Promise<void> {
  return new Promise((resolve) => {
    console.log(`Test: ${name}`);
    console.log(`  Args: ${JSON.stringify(args)}`);

    const start = Date.now();
    const proc = spawn('claude', args, options);

    let stdout = '';
    let stderr = '';

    proc.stdout?.on('data', (d) => { stdout += d.toString(); });
    proc.stderr?.on('data', (d) => { stderr += d.toString(); });

    const timeout = setTimeout(() => {
      console.log(`  TIMEOUT after 15s`);
      proc.kill('SIGTERM');
    }, 15000);

    proc.on('close', (code) => {
      clearTimeout(timeout);
      const duration = ((Date.now() - start) / 1000).toFixed(1);
      console.log(`  Exit: ${code} in ${duration}s`);
      console.log(`  Stdout: ${stdout.substring(0, 100) || '(empty)'}`);
      if (stderr) console.log(`  Stderr: ${stderr.substring(0, 100)}`);
      console.log('');
      resolve();
    });

    proc.on('error', (err) => {
      clearTimeout(timeout);
      console.log(`  Error: ${err.message}\n`);
      resolve();
    });
  });
}

async function main() {
  // Test 1: Basic spawn
  await testSpawn('Basic spawn', ['--print', '--max-turns', '2', 'Say hi'], {});

  // Test 2: With cwd
  await testSpawn('With cwd', ['--print', '--max-turns', '2', 'Say hi'], {
    cwd: '/home/sprite/claude-work',
  });

  // Test 3: With CI env
  await testSpawn('With CI=true', ['--print', '--max-turns', '2', 'Say hi'], {
    cwd: '/home/sprite/claude-work',
    env: { ...process.env, CI: 'true' },
  });

  // Test 4: Without CI
  await testSpawn('Without CI', ['--print', '--max-turns', '2', 'Say hi'], {
    cwd: '/home/sprite/claude-work',
    env: { ...process.env },
  });

  // Test 5: With stdio inherit
  console.log('Test: With stdio inherit');
  await new Promise<void>((resolve) => {
    const proc = spawn('claude', ['--print', '--max-turns', '2', 'Say hi'], {
      cwd: '/home/sprite/claude-work',
      stdio: 'inherit',
    });
    const timeout = setTimeout(() => { proc.kill(); }, 15000);
    proc.on('close', () => { clearTimeout(timeout); console.log(''); resolve(); });
  });
}

main().catch(console.error);

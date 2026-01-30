#!/usr/bin/env npx tsx
/**
 * Test runner for CLinear-Code
 * Run with: npx tsx test-runner.ts [testName]
 */

import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';
import { buildPrompt, parseClaudeOutput } from './src/claude/executor.js';
import { LocalComputeProvider } from './src/compute/local.js';
import { config } from './src/config.js';
import type { IssueContext } from './src/linear/types.js';

const TESTS = {
  async promptGeneration() {
    console.log('TEST: Prompt Generation\n');

    const ctx: IssueContext = {
      issue: {
        id: '1',
        identifier: 'TEST-1',
        title: 'Create a hello file',
        description: 'Create hello.txt with "Hello World"',
        url: 'https://linear.app/test/TEST-1',
        labels: [],
        teamKey: 'TEST',
      },
      comments: [],
      triggerComment: {
        id: 'c1',
        body: '@Claude create hello.txt',
        author: 'Tester',
        instruction: 'Create hello.txt with Hello World inside',
      },
    };

    const prompt = buildPrompt(ctx);
    console.log('--- Prompt (no repo) ---');
    console.log(prompt);
    console.log(`--- Length: ${prompt.length} chars ---\n`);

    return { success: true };
  },

  async outputParsing() {
    console.log('TEST: Output Parsing\n');

    const testCases = [
      {
        name: 'Valid success JSON',
        input: 'Did some work.\n```json\n{"success": true, "summary": "Created file"}\n```\nDone.',
        expected: { success: true },
      },
      {
        name: 'Valid failure JSON',
        input: '```json\n{"success": false, "error": "Could not find file"}\n```',
        expected: { success: false },
      },
      {
        name: 'PR URL in output',
        input: 'Created PR at https://github.com/owner/repo/pull/123',
        expected: { success: true, prUrl: 'https://github.com/owner/repo/pull/123' },
      },
      {
        name: 'No JSON found',
        input: 'I did some stuff but forgot the JSON',
        expected: { success: false },
      },
    ];

    for (const tc of testCases) {
      const result = parseClaudeOutput(tc.input);
      const passed = result.success === tc.expected.success;
      console.log(`  ${passed ? '✓' : '✗'} ${tc.name}: success=${result.success}`);
    }
    console.log('');
    return { success: true };
  },

  async directClaude() {
    console.log('TEST: Direct Claude CLI\n');

    const workDir = path.join(config.WORK_DIR, 'test-direct');
    await fs.mkdir(workDir, { recursive: true });

    const prompt = `Create a file called test.txt containing "Hello from test". Then output:
\`\`\`json
{"success": true, "summary": "Created test.txt"}
\`\`\``;

    console.log(`  Work dir: ${workDir}`);
    console.log(`  Prompt: ${prompt.substring(0, 50)}...`);
    console.log('  Running claude...\n');

    return new Promise<{ success: boolean; output?: string; error?: string }>((resolve) => {
      const args = ['--print', '--dangerously-skip-permissions', '--max-turns', '5', prompt];

      const proc = spawn('claude', args, {
        cwd: workDir,
        env: { ...process.env, CI: 'true' },
        stdio: ['ignore', 'pipe', 'pipe'],  // stdin must be ignored
      });

      let stdout = '';
      const startTime = Date.now();

      proc.stdout.on('data', (d) => {
        stdout += d.toString();
        process.stdout.write(d);
      });

      const timeout = setTimeout(() => {
        proc.kill('SIGTERM');
        resolve({ success: false, error: 'Timeout after 60s' });
      }, 60000);

      proc.on('close', async (code) => {
        clearTimeout(timeout);
        const duration = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`\n  Completed in ${duration}s (exit ${code})`);

        try {
          const content = await fs.readFile(path.join(workDir, 'test.txt'), 'utf-8');
          console.log(`  ✓ test.txt created: "${content.trim()}"`);
        } catch {
          console.log('  ✗ test.txt not created');
        }

        const result = parseClaudeOutput(stdout);
        console.log(`  Parsed result: ${JSON.stringify(result)}`);
        await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
        resolve({ success: result.success, output: stdout });
      });
    });
  },

  async localProvider() {
    console.log('TEST: LocalComputeProvider (full integration)\n');

    const ctx: IssueContext = {
      issue: {
        id: 'test-provider-1',
        identifier: 'TEST-2',
        title: 'Create greeting file',
        description: 'Create a file called greeting.txt with a friendly greeting',
        url: 'https://linear.app/test/TEST-2',
        labels: ['test'],
        teamKey: 'TEST',
      },
      comments: [],
      triggerComment: {
        id: 'c1',
        body: '@Claude create the greeting file',
        author: 'Tester',
        instruction: 'Create greeting.txt with "Hello, World!" inside',
      },
      // No repo - standalone mode
    };

    console.log(`  Issue: ${ctx.issue.identifier} - ${ctx.issue.title}`);
    console.log(`  Instruction: ${ctx.triggerComment.instruction}`);
    console.log('  Running LocalComputeProvider...\n');

    const provider = new LocalComputeProvider();
    const startTime = Date.now();
    const result = await provider.executeTask(ctx);
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);

    console.log(`\n  Completed in ${duration}s`);
    console.log(`  Result: ${JSON.stringify(result, null, 2)}`);

    return { success: result.success };
  },
};

async function main() {
  console.log('='.repeat(60));
  console.log('CLinear-Code Test Runner');
  console.log('='.repeat(60));
  console.log(`Config: WORK_DIR=${config.WORK_DIR}, MAX_TURNS=${config.CLAUDE_MAX_TURNS}\n`);

  const testName = process.argv[2];

  if (testName && testName in TESTS) {
    const result = await TESTS[testName as keyof typeof TESTS]();
    console.log(`\nResult: ${result.success ? 'PASSED' : 'FAILED'}`);
  } else if (testName) {
    console.log(`Unknown test: ${testName}`);
    console.log(`Available: ${Object.keys(TESTS).join(', ')}`);
  } else {
    // Run all tests
    const results: Record<string, boolean> = {};
    for (const [name, test] of Object.entries(TESTS)) {
      console.log(`\n${'='.repeat(60)}`);
      try {
        const result = await test();
        results[name] = result.success;
        console.log(`${name}: ${result.success ? 'PASSED' : 'FAILED'}`);
      } catch (err) {
        results[name] = false;
        console.log(`${name}: ERROR - ${err}`);
      }
    }
    console.log(`\n${'='.repeat(60)}`);
    console.log('SUMMARY:');
    for (const [name, passed] of Object.entries(results)) {
      console.log(`  ${passed ? '✓' : '✗'} ${name}`);
    }
  }
}

main().catch(console.error);

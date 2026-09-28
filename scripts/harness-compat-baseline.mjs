#!/usr/bin/env node
/**
 * harness-compat-baseline.mjs —— harness 适配基线的读写（`.github/harness-baseline.json`）。
 *
 * 基线的语义：**只有「完全适配全绿」的 (harness 版本 × 插件 commit) 对才配当基线**。
 * 由 `.github/workflows/harness-compat.yml` 在全部步骤通过后调用 `record` 写入；
 * 任何一步失败的工作流根本走不到 `record`，所以基线天然停在上一个全绿对上。
 *
 * 两个子命令（都只用 node: 内置模块）：
 *   · `check   --harness <ver> --sha <sha> [--force]`
 *       目标对已全绿入基线 ⇒ 输出 `should_run=false`（轮询秒过）；否则 `should_run=true`。
 *       判定结果写进 $GITHUB_OUTPUT（存在时），并打印在日志里。`check` 永远退出 0：
 *       「跳过」是结论，不是错误。
 *   · `record  --harness <ver> --sha <sha> [--dist-tag <tag>] [--node <n>] [--runner <os>]`
 *       把当前对写进基线文件；**同一对已在基线里则不改动**（幂等，避免时间戳造成空转提交）。
 *       工作流用 `git status --porcelain` 决定是否提交。
 *
 * 失败与重试的闭环：新 harness 版本测试失败 ⇒ 工作流红、基线不变 ⇒ 下一次轮询
 * `check` 仍判定 should_run=true ⇒ 持续红直到修复（"出问题就需要报错"）。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const BASELINE = join(ROOT, '.github', 'harness-baseline.json');
const HARNESS_PKG = '@deepseek-ai/dsh';

function parseArgs(argv) {
  const out = { force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--force') { out.force = true; continue; }
    const key = a.replace(/^--/, '');
    const val = argv[i + 1];
    if (val === undefined || val.startsWith('--')) throw new Error(`参数 ${a} 缺少取值`);
    out[key] = val;
    i++;
  }
  return out;
}

function readBaseline() {
  try { return JSON.parse(readFileSync(BASELINE, 'utf8')); } catch { return null; }
}

function requirePair(args) {
  if (!args.harness || !args.sha) throw new Error('需要 --harness <版本> 与 --sha <插件 commit>');
  return { target: String(args.harness), sha: String(args.sha) };
}

function check(args) {
  const { target, sha } = requirePair(args);
  let shouldRun = true;
  let why;
  if (args.force) {
    why = '--force 指定强制重跑';
  } else {
    const bl = readBaseline();
    if (!bl) {
      why = '基线文件不存在（首轮）';
    } else if (bl.status !== 'pass') {
      why = `基线 status=${bl.status}（只认 pass）`;
    } else if (bl.harness?.version !== target) {
      why = `harness ${bl.harness?.version ?? '（无）'} → 目标 ${target}`;
    } else if (bl.plugin?.commit !== sha) {
      why = `插件 HEAD ${String(bl.plugin?.commit ?? '').slice(0, 7)} → ${sha.slice(0, 7)}`;
    } else {
      shouldRun = false;
      why = `基线已覆盖 ${target} × ${sha.slice(0, 7)}`;
    }
  }
  console.log(`harness-compat check：${why} ⇒ should_run=${shouldRun}`);
  if (process.env.GITHUB_OUTPUT) {
    writeFileSync(process.env.GITHUB_OUTPUT, `should_run=${shouldRun}\n`, { flag: 'a' });
  }
}

function record(args) {
  const { target, sha } = requirePair(args);
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const bl = readBaseline();
  if (bl && bl.status === 'pass' && bl.harness?.version === target && bl.plugin?.commit === sha) {
    console.log(`harness-compat record：${target} × ${sha.slice(0, 7)} 已在基线，不改动`);
    return;
  }
  const doc = {
    harness: { package: HARNESS_PKG, distTag: args['dist-tag'] || 'latest', version: target },
    plugin: { commit: sha, version: pkg.version || '' },
    node: args.node || '',
    runner: args.runner || '',
    runId: process.env.GITHUB_RUN_ID || '',
    status: 'pass',
    passedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  };
  writeFileSync(BASELINE, JSON.stringify(doc, null, 2) + '\n');
  console.log(`harness-compat record：${target} × ${sha.slice(0, 7)} 写入基线`);
}

const cmd = process.argv[2];
const rest = process.argv.slice(3);
try {
  const args = parseArgs(rest);
  if (cmd === 'check') check(args);
  else if (cmd === 'record') record(args);
  else throw new Error(`未知子命令：${cmd || '（空）'}（可用：check / record）`);
} catch (err) {
  console.error(`harness-compat-baseline：${err.message}`);
  process.exit(1);
}

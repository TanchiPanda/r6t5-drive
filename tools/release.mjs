#!/usr/bin/env node
// R6T5 Drive 发布脚本（零依赖，Node 22 ESM，仅用内置 fetch / fs / child_process）。
//
// 流程：读 VERSION + git 历史 → 在 GitHub 仓库创建 Release issue → 在该 issue 下创建发布评论
//       → 把 issueNumber / commentId / commentUrl / publishedAt / notes 原子写回 latest.json。
//
// 用法：
//   GITHUB_TOKEN=<PAT> node tools/release.mjs            # 真实发版（issue 与评论都必须返回 201 才写 latest.json）
//   node tools/release.mjs --dry-run                     # 不发网络请求，只打印将要创建的内容与 latest.json
//
// PAT 只从环境变量 GITHUB_TOKEN 读取，绝不写入仓库任何文件。

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERSION_FILE = path.join(ROOT, 'VERSION');
const LATEST_FILE = path.join(ROOT, 'latest.json');

const REPO_OWNER = 'TanchiPanda';
const REPO_NAME = 'r6t5-drive';
const ISSUES_URL = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/issues`;

const UPGRADE_COMMAND = 'docker compose pull && docker compose up -d';
const ROLLBACK_HINT = 'docker compose down && git checkout <上一个版本号或 tag> && docker compose up -d';

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');

function readText(file) {
  return fs.readFileSync(file, 'utf8').trim();
}

function readLatest() {
  const fallback = {
    version: '',
    issueNumber: null,
    commentId: null,
    commentUrl: '',
    publishedAt: null,
    upgradeCommand: UPGRADE_COMMAND,
    notes: '',
  };
  if (!fs.existsSync(LATEST_FILE)) return fallback;
  try {
    const parsed = JSON.parse(fs.readFileSync(LATEST_FILE, 'utf8'));
    return { ...fallback, ...parsed };
  } catch {
    return fallback;
  }
}

function git(args) {
  return execFileSync('git', args, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

// 尝试定位上一个发布对应的提交：tag `v<prev>`、`<prev>` 本身，或提交信息含 `Release <prev>`。
function resolveBaseRef(prevVersion) {
  if (!prevVersion) return null;
  for (const ref of [`v${prevVersion}`, prevVersion]) {
    try {
      return git(['rev-parse', '--verify', ref]).trim();
    } catch {
      /* 继续尝试下一个 */
    }
  }
  try {
    return git(['rev-list', '--max-count=1', '--grep', `Release ${prevVersion}`]).trim() || null;
  } catch {
    return null;
  }
}

// 真实读取 git 历史生成变更摘要；不写死文案。
function collectChangelog(currentVersion) {
  const prev = readLatest().version;
  const base = prev && prev !== currentVersion ? resolveBaseRef(prev) : null;
  let lines;
  try {
    lines = base
      ? git(['log', '--oneline', `${base}..HEAD`])
      : git(['log', '--oneline', '-20']);
  } catch {
    lines = git(['log', '--oneline', '-20']);
  }
  return lines
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((line) => {
      const sp = line.indexOf(' ');
      return { hash: line.slice(0, sp), subject: line.slice(sp + 1).trim() };
    });
}

function truncate(s, n) {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function formatCommitList(commits) {
  if (!commits.length) return '- （本次发布未取到提交记录）';
  return commits.map((c) => `- \`${c.hash}\` ${c.subject}`).join('\n');
}

function buildIssueBody(version, publishedAt, commits) {
  return [
    `## Release \`${version}\``,
    '',
    `- 版本号：\`${version}\``,
    `- 构建时间：${publishedAt}`,
    `- 升级命令：\`${UPGRADE_COMMAND}\``,
    '',
    '### 变更摘要',
    '',
    formatCommitList(commits),
    '',
    '> 本 issue 下的唯一一条评论承载发布说明（变更要点、升级命令、回滚提示）；',
    '> `latest.json` 通过 `issueNumber` + `commentId` 指回本发布，控制台据此展示更新提示。',
    '',
  ].join('\n');
}

function buildCommentBody(version, publishedAt, commits) {
  return [
    `## 发布说明 \`${version}\``,
    '',
    `- 版本：\`${version}\``,
    `- 发布时间：${publishedAt}`,
    '',
    '### 本次变更要点',
    '',
    formatCommitList(commits),
    '',
    '### 升级命令',
    '',
    `\`${UPGRADE_COMMAND}\``,
    '',
    '### 回滚',
    '',
    `\`${ROLLBACK_HINT}\``,
    '',
  ].join('\n');
}

async function githubFetch(url, options, token) {
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

function bodyPreview(body) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return text.slice(0, 500);
}

// 先在内存里构造好完整对象，再写 .tmp 并 rename，避免写坏已有 latest.json。
function atomicWriteLatest(obj) {
  const tmp = `${LATEST_FILE}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, LATEST_FILE);
}

async function main() {
  const version = readText(VERSION_FILE);
  const publishedAt = new Date().toISOString();
  const commits = collectChangelog(version);
  const notes = commits[0] ? truncate(commits[0].subject, 120) : '发布构建';

  const title = `Release ${version}`;
  const issueBody = buildIssueBody(version, publishedAt, commits);
  const commentBody = buildCommentBody(version, publishedAt, commits);

  if (DRY_RUN) {
    console.log('=== [dry-run] 将创建的 issue ===');
    console.log(`标题：${title}`);
    console.log('正文：\n' + issueBody);
    console.log('\n=== [dry-run] 将创建的评论（挂在该 issue 下）===');
    console.log(commentBody);
    const target = {
      version,
      issueNumber: null,
      commentId: null,
      commentUrl: '',
      publishedAt,
      upgradeCommand: UPGRADE_COMMAND,
      notes,
    };
    console.log('\n=== [dry-run] 将写入 latest.json ===');
    console.log(JSON.stringify(target, null, 2) + '\n');
    console.log('（dry-run：未发送任何网络请求，退出码 0）');
    process.exit(0);
  }

  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    console.error('错误：缺少环境变量 GITHUB_TOKEN（PAT，scope: repo）。');
    console.error('用法：GITHUB_TOKEN=<token> node tools/release.mjs');
    process.exit(1);
  }

  // 1) 创建 issue
  let issue;
  try {
    issue = await githubFetch(ISSUES_URL, { method: 'POST', body: JSON.stringify({ title, body: issueBody }) }, token);
  } catch (err) {
    console.error('创建 issue 时网络错误：', err.message);
    process.exit(1);
  }
  if (issue.status !== 201) {
    console.error(`创建 issue 失败：HTTP ${issue.status}`);
    console.error(bodyPreview(issue.body));
    console.error('latest.json 未写入。');
    process.exit(1);
  }
  const issueNumber = issue.body.number;
  const issueUrl = issue.body.html_url;

  // 2) 在 issue 下创建发布评论
  let comment;
  const commentsUrl = `${ISSUES_URL}/${issueNumber}/comments`;
  try {
    comment = await githubFetch(commentsUrl, { method: 'POST', body: JSON.stringify({ body: commentBody }) }, token);
  } catch (err) {
    console.error('创建评论时网络错误：', err.message);
    console.error(`注意：issue #${issueNumber} 已创建（${issueUrl}），评论失败，latest.json 未写入。`);
    process.exit(1);
  }
  if (comment.status !== 201) {
    console.error(`创建评论失败：HTTP ${comment.status}`);
    console.error(bodyPreview(comment.body));
    console.error(`注意：issue #${issueNumber} 已创建（${issueUrl}），latest.json 未写入。`);
    process.exit(1);
  }

  // 3) 两次请求都成功（201）后，才原子写回 latest.json
  const next = {
    version,
    issueNumber,
    commentId: comment.body.id,
    commentUrl: comment.body.html_url,
    publishedAt,
    upgradeCommand: UPGRADE_COMMAND,
    notes,
  };
  atomicWriteLatest(next);

  console.log('发布完成');
  console.log(`Issue: ${issueUrl}`);
  console.log(`评论: ${comment.body.html_url}`);
  console.log(`升级命令: ${UPGRADE_COMMAND}`);
  console.log('提醒：记得提交 latest.json 与 VERSION 并推送到远端。');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

import fs from 'node:fs/promises';

const token = process.env.GITHUB_TOKEN;
const repo = process.env.GITHUB_REPOSITORY;
const eventPath = process.env.GITHUB_EVENT_PATH;
const explicitCommentId = process.env.COMMENT_ID;
const branchNameInput = process.env.BRANCH_NAME;

if (!token) throw new Error('GITHUB_TOKEN is required to run update-comment-link.ts');
if (!repo) throw new Error('GITHUB_REPOSITORY is required to run update-comment-link.ts');
if (!eventPath) throw new Error('GITHUB_EVENT_PATH is required to run update-comment-link.ts');

const eventPayload = JSON.parse(await fs.readFile(eventPath, 'utf8'));
const commentId = explicitCommentId || String(eventPayload.comment?.id ?? '');
const commentBody = typeof branchNameInput === 'string' ? branchNameInput : eventPayload.comment?.body ?? '';
const issueTitle = eventPayload.issue?.title ?? '';

if (!commentId) {
  console.log('No comment ID found in workflow environment or event payload. Nothing to update.');
  process.exit(0);
}

const branchName = normalizeBranchName(extractBranchName(commentBody) ?? extractBranchName(issueTitle));
if (!branchName) {
  console.log('No branch name found in issue/comment body. Skipping branch compare update.');
  process.exit(0);
}

const apiBase = `https://api.github.com/repos/${repo}`;
const headers = {
  Authorization: `Bearer ${token}`,
  Accept: 'application/vnd.github+json',
  'User-Agent': 'update-comment-link-action',
};

await run();

async function run(): Promise<void> {
  console.log(`Repository: ${repo}`);
  console.log(`Comment ID: ${commentId}`);
  console.log(`Branch candidate: ${branchName}`);

  const defaultBranch = await getDefaultBranch();
  console.log(`Repository default branch: ${defaultBranch}`);

  const branchExists = await doesBranchExist(branchName);
  if (!branchExists) {
    console.log(`Branch ${branchName} does not exist on remote. Skipping compare link update.`);
    return;
  }

  const compareResult = await getCompare(defaultBranch, branchName);
  if (!compareResult) {
    console.log(`No compare result for ${defaultBranch}...${branchName}. Skipping update.`);
    return;
  }

  const compareUrl = `https://github.com/${repo}/compare/${encodeURIComponent(defaultBranch)}...${encodeURIComponent(branchName)}`;
  const currentComment = eventPayload.comment ?? await fetchGitHub(`/issues/comments/${commentId}`);
  const currentBody = currentComment?.body ?? '';
  const updatedBody = updateCommentBody(currentBody, compareUrl);

  if (updatedBody === currentBody) {
    console.log('Comment body already contains the expected branch compare link. No update needed.');
    return;
  }

  await patchComment(commentId, updatedBody);
  console.log(`Updated comment ${commentId} with branch compare link.`);
}

function normalizeBranchName(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.trim().replace(/^refs\/heads\//i, '').replace(/^origin\//i, '');
}

function extractBranchName(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const patterns = [
    /branch(?:[-_ ]name)?[:=]\s*([^\s]+)/i,
    /compare\/(?:[^\.]+)\.\.\.([^\s]+)/i,
    /(^|\s)([\w\-\/]+issue[-_]\d+[\w\-]*)/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return match[1];
  }
  return undefined;
}

function updateCommentBody(body: string, compareUrl: string): string {
  const markerStart = '<!-- branch-compare-link: start -->';
  const markerEnd = '<!-- branch-compare-link: end -->';
  const newLinkBlock = `${markerStart}\nBranch compare link: ${compareUrl}\n${markerEnd}`;

  if (body.includes(markerStart) && body.includes(markerEnd)) {
    return body.replace(new RegExp(`${escapeRegExp(markerStart)}[\s\S]*?${escapeRegExp(markerEnd)}`), newLinkBlock);
  }

  return [body.trim(), '', newLinkBlock].filter(Boolean).join('\n');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function fetchGitHub(path: string, init?: RequestInit): Promise<any> {
  const response = await fetch(`${apiBase}${path}`, { headers, ...init });
  if (response.ok) {
    return response.json();
  }

  const responseText = await response.text();
  if (response.status === 404) {
    return null;
  }

  throw new Error(`GitHub API request failed (${response.status}): ${responseText}`);
}

async function getDefaultBranch(): Promise<string> {
  const repoData = await fetchGitHub('');
  return repoData?.default_branch ?? 'main';
}

async function doesBranchExist(branch: string): Promise<boolean> {
  const branchData = await fetchGitHub(`/branches/${encodeURIComponent(branch)}`);
  return branchData !== null;
}

async function getCompare(base: string, head: string): Promise<any> {
  const compareData = await fetchGitHub(`/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`);
  if (!compareData) {
    console.log(`Compare API returned 404 for ${base}...${head}.`);
  }
  return compareData;
}

async function patchComment(commentIdValue: string, body: string): Promise<void> {
  await fetchGitHub(`/issues/comments/${commentIdValue}`, {
    method: 'PATCH',
    body: JSON.stringify({ body }),
  });
}

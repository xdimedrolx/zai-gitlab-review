const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const ZAI_API_URL = 'https://api.z.ai/api/coding/paas/v4/chat/completions';
const COMMENT_MARKER = '<!-- zai-code-review -->';
const MAX_RESPONSE_SIZE = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 300_000;

// ---------------------------------------------------------------------------
// Pure helpers (ported verbatim from the original GitHub Action)
// ---------------------------------------------------------------------------

function matchesPattern(filename, pattern) {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\x00')
    .replace(/\*/g, '[^/]*')
    .replace(/\x00/g, '.*');
  const regex = new RegExp(`^${escaped}$`);
  const basename = filename.split('/').pop();
  return regex.test(filename) || regex.test(basename);
}

function filterFiles(files, excludePatterns) {
  if (!excludePatterns || excludePatterns.length === 0) {
    return files;
  }
  return files.filter(f => !excludePatterns.some(p => matchesPattern(f.filename, p)));
}

// Read a changed file's full current content from the checked-out repo (CWD).
// Returns {text} on success, or {note} describing why content was omitted.
function readFileContent(filename, maxChars) {
  try {
    const root = process.cwd();
    const full = path.resolve(root, filename);
    // Guard against path traversal outside the repo root.
    if (full !== root && !full.startsWith(root + path.sep)) return { note: 'outside repo' };
    const stat = fs.statSync(full);
    if (!stat.isFile()) return { note: 'not a file' };
    const buf = fs.readFileSync(full);
    if (buf.includes(0)) return { note: 'binary' };
    const text = buf.toString('utf8');
    if (maxChars > 0 && text.length > maxChars) return { note: `too large (${text.length} chars)` };
    return { text };
  } catch {
    return { note: 'unavailable' };
  }
}

function buildPrompt(files, { maxDiffChars = 0, maxContextChars = 0 } = {}) {
  const patchableFiles = files.filter(f => f.patch);
  const sections = [];
  const skippedDiff = [];
  const skippedContent = [];
  let diffChars = 0;
  let contentChars = 0;

  for (const f of patchableFiles) {
    const diffEntry = `\`\`\`diff\n${f.patch}\n\`\`\``;
    if (maxDiffChars > 0 && diffChars + diffEntry.length > maxDiffChars) {
      skippedDiff.push(f.filename);
      continue;
    }
    diffChars += diffEntry.length;

    let section = `### ${f.filename} (${f.status})\n\n**Diff:**\n${diffEntry}`;

    if (typeof f.content === 'string') {
      if (maxContextChars > 0 && contentChars + f.content.length > maxContextChars) {
        skippedContent.push(f.filename);
      } else {
        contentChars += f.content.length;
        section += `\n\n**Full file (current):**\n\`\`\`\n${f.content}\n\`\`\``;
      }
    } else if (f.contentNote) {
      section += `\n\n_(full file omitted: ${f.contentNote})_`;
    }

    sections.push(section);
  }

  let body = sections.join('\n\n');

  if (skippedDiff.length > 0) {
    body += `\n\n> **Note:** files excluded because the diff exceeded \`MAX_DIFF_CHARS\`:\n${skippedDiff.map(f => `> - ${f}`).join('\n')}`;
  }
  if (skippedContent.length > 0) {
    body += `\n\n> **Note:** full content omitted (over \`MAX_CONTEXT_CHARS\`), diff only:\n${skippedContent.map(f => `> - ${f}`).join('\n')}`;
  }

  return `Please review the following merge request. For each changed file you are given the diff (what changed) and, where available, the full current file content for context. Review the CHANGES shown in the diffs — use the full files only as context to judge them. Do not nitpick pre-existing code unrelated to the diff. Focus on bugs, logic errors, security issues, and meaningful improvements. Skip trivial style comments.\n\n${body}`;
}

// Map a GitLab diff entry to the {filename, patch, status} shape the helpers expect.
function mapGitlabDiff(d) {
  let status = 'modified';
  if (d.new_file) status = 'added';
  else if (d.deleted_file) status = 'removed';
  else if (d.renamed_file) status = 'renamed';
  return { filename: d.new_path || d.old_path, patch: d.diff, status };
}

// ---------------------------------------------------------------------------
// Z.ai API (ported verbatim)
// ---------------------------------------------------------------------------

function callZaiApi(apiKey, model, systemPrompt, prompt) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: prompt },
      ],
    });

    const url = new URL(ZAI_API_URL);
    const options = {
      hostname: url.hostname,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => {
        data += chunk;
        if (data.length > MAX_RESPONSE_SIZE) {
          req.destroy(new Error('Z.ai API response exceeded size limit.'));
        }
      });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          let parsed;
          try {
            parsed = JSON.parse(data);
          } catch {
            reject(new Error('Z.ai API returned invalid JSON.'));
            return;
          }
          const content = parsed.choices?.[0]?.message?.content;
          if (!content) {
            reject(new Error('Z.ai API returned an empty response.'));
          } else {
            resolve(content);
          }
        } else {
          reject(new Error(`Z.ai API error ${res.statusCode}: ${data.slice(0, 200)}`));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error('Z.ai API request timed out.'));
    });
    req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// GitLab REST (replaces octokit). Base URL from CI_API_V4_URL so this works on
// gitlab.com and self-hosted with zero config. Auth via PRIVATE-TOKEN header.
// ---------------------------------------------------------------------------

function gitlabRequest(apiBase, token, method, path, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(apiBase.replace(/\/$/, '') + path);
    const payload = body != null ? JSON.stringify(body) : null;
    const headers = { 'PRIVATE-TOKEN': token, 'Accept': 'application/json' };
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
    const transport = url.protocol === 'http:' ? http : https;
    const options = {
      hostname: url.hostname,
      port: url.port || undefined,
      path: url.pathname + url.search,
      method,
      headers,
    };

    const req = transport.request(options, res => {
      let data = '';
      res.on('data', chunk => {
        data += chunk;
        if (data.length > MAX_RESPONSE_SIZE) {
          req.destroy(new Error('GitLab API response exceeded size limit.'));
        }
      });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          let parsed = null;
          if (data.length > 0) {
            try {
              parsed = JSON.parse(data);
            } catch {
              reject(new Error('GitLab API returned invalid JSON.'));
              return;
            }
          }
          resolve({ status: res.statusCode, headers: res.headers, body: parsed });
        } else {
          reject(new Error(`GitLab API error ${res.statusCode} on ${method} ${path}: ${data.slice(0, 200)}`));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error('GitLab API request timed out.'));
    });
    if (payload) req.write(payload);
    req.end();
  });
}

// Walk paginated GitLab list endpoints (?per_page=100&page=N) until short page.
async function gitlabPaginate(apiBase, token, basePath) {
  const sep = basePath.includes('?') ? '&' : '?';
  const out = [];
  let page = 1;
  while (true) {
    const { body } = await gitlabRequest(
      apiBase, token, 'GET', `${basePath}${sep}per_page=100&page=${page}`,
    );
    const items = Array.isArray(body) ? body : [];
    out.push(...items);
    if (items.length < 100) break;
    page++;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Input handling (replaces @actions/core getInput)
// ---------------------------------------------------------------------------

function getInput(name, { required = false, fallback = '' } = {}) {
  const raw = process.env[name];
  const value = raw != null ? raw.trim() : '';
  if (!value) {
    if (required) {
      throw new Error(`Missing required input: ${name}`);
    }
    return fallback;
  }
  return value;
}

const DEFAULTS = {
  ZAI_MODEL: 'glm-5.2',
  ZAI_SYSTEM_PROMPT: 'You are an expert code reviewer. Review the provided code changes and give clear, actionable feedback.',
  ZAI_REVIEWER_NAME: 'Z.ai Code Review',
  EXCLUDE_PATTERNS: '*.lock,package-lock.json,yarn.lock,pnpm-lock.yaml',
  MAX_DIFF_CHARS: '0',
  INCLUDE_FILE_CONTENT: 'true',
  MAX_FILE_CONTENT_CHARS: '30000',
  MAX_CONTEXT_CHARS: '200000',
};

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

async function run() {
  const apiKey = getInput('ZAI_API_KEY', { required: true });
  const model = getInput('ZAI_MODEL', { fallback: DEFAULTS.ZAI_MODEL });
  const systemPrompt = getInput('ZAI_SYSTEM_PROMPT', { fallback: DEFAULTS.ZAI_SYSTEM_PROMPT });
  const reviewerName = getInput('ZAI_REVIEWER_NAME', { fallback: DEFAULTS.ZAI_REVIEWER_NAME });
  const excludePatterns = getInput('EXCLUDE_PATTERNS', { fallback: DEFAULTS.EXCLUDE_PATTERNS })
    .split(',')
    .map(p => p.trim())
    .filter(p => p.length > 0);
  const maxDiffChars = parseInt(getInput('MAX_DIFF_CHARS', { fallback: DEFAULTS.MAX_DIFF_CHARS }), 10) || 0;
  const includeContent = getInput('INCLUDE_FILE_CONTENT', { fallback: DEFAULTS.INCLUDE_FILE_CONTENT }) !== 'false';
  const maxFileContentChars = parseInt(getInput('MAX_FILE_CONTENT_CHARS', { fallback: DEFAULTS.MAX_FILE_CONTENT_CHARS }), 10) || 0;
  const maxContextChars = parseInt(getInput('MAX_CONTEXT_CHARS', { fallback: DEFAULTS.MAX_CONTEXT_CHARS }), 10) || 0;
  const token = getInput('GITLAB_TOKEN', { required: true });

  const apiBase = getInput('CI_API_V4_URL', { required: true });
  const projectId = encodeURIComponent(getInput('CI_PROJECT_ID', { required: true }));
  const mrIid = getInput('CI_MERGE_REQUEST_IID');

  if (!mrIid) {
    console.log('No CI_MERGE_REQUEST_IID found; this job only runs on merge request pipelines. Skipping.');
    return;
  }

  const mrBase = `/projects/${projectId}/merge_requests/${mrIid}`;

  console.log(`Fetching changed files for MR !${mrIid}...`);
  const rawDiffs = await gitlabPaginate(apiBase, token, `${mrBase}/diffs`);
  const files = rawDiffs.map(mapGitlabDiff);

  const filteredFiles = filterFiles(files, excludePatterns);

  if (excludePatterns.length > 0) {
    const excluded = files.length - filteredFiles.length;
    if (excluded > 0) {
      console.log(`Excluded ${excluded} file(s) matching EXCLUDE_PATTERNS.`);
    }
  }

  if (!filteredFiles.some(f => f.patch)) {
    console.log('No patchable changes found after filtering. Skipping review.');
    return;
  }

  if (includeContent) {
    let withContent = 0;
    for (const f of filteredFiles) {
      if (!f.patch || f.status === 'removed') continue;
      const r = readFileContent(f.filename, maxFileContentChars);
      if (r.text != null) {
        f.content = r.text;
        withContent++;
      } else if (r.note) {
        f.contentNote = r.note;
      }
    }
    console.log(`Attached full content for ${withContent} file(s).`);
  }

  const prompt = buildPrompt(filteredFiles, { maxDiffChars, maxContextChars });

  console.log(`Sending ${filteredFiles.length} file(s) to Z.ai for review...`);
  const review = await callZaiApi(apiKey, model, systemPrompt, prompt);
  const body = `## ${reviewerName}\n\n${review}\n\n${COMMENT_MARKER}`;

  const notes = await gitlabPaginate(apiBase, token, `${mrBase}/notes`);
  const existing = notes.find(n => typeof n.body === 'string' && n.body.includes(COMMENT_MARKER));

  if (existing) {
    await gitlabRequest(apiBase, token, 'PUT', `${mrBase}/notes/${existing.id}`, { body });
    console.log('Review comment updated.');
  } else {
    await gitlabRequest(apiBase, token, 'POST', `${mrBase}/notes`, { body });
    console.log('Review comment posted.');
  }
}

module.exports = {
  matchesPattern,
  filterFiles,
  buildPrompt,
  mapGitlabDiff,
  readFileContent,
  getInput,
  run,
};

// Run only when executed directly (not when imported by tests).
if (require.main === module) {
  run().catch(err => {
    console.error(err.message);
    process.exit(1);
  });
}

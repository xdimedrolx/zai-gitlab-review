const http = require('http');
const https = require('https');

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

function buildPrompt(files, maxDiffChars) {
  const patchableFiles = files.filter(f => f.patch);
  const includedDiffs = [];
  const skippedFiles = [];
  let totalChars = 0;

  for (const f of patchableFiles) {
    const entry = `### ${f.filename} (${f.status})\n\`\`\`diff\n${f.patch}\n\`\`\``;
    if (maxDiffChars > 0 && totalChars + entry.length > maxDiffChars) {
      skippedFiles.push(f.filename);
    } else {
      includedDiffs.push(entry);
      totalChars += entry.length;
    }
  }

  let diffs = includedDiffs.join('\n\n');

  if (skippedFiles.length > 0) {
    diffs += `\n\n> **Note:** The following files were excluded because the diff exceeded the \`MAX_DIFF_CHARS\` limit:\n${skippedFiles.map(f => `> - ${f}`).join('\n')}`;
  }

  return `Please review the following merge request changes and provide concise, constructive feedback. Focus on bugs, logic errors, security issues, and meaningful improvements. Skip trivial style comments.\n\n${diffs}`;
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

  const prompt = buildPrompt(filteredFiles, maxDiffChars);

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

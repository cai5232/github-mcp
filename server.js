import express from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const app = express();
app.use(express.json());

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, DELETE');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, mcp-session-id');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.path}`);
  next();
});

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_OWNER = process.env.GITHUB_OWNER;
const PORT = process.env.PORT || 3000;

async function gh(path, options = {}) {
  const url = `https://api.github.com${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      'Authorization': `Bearer ${GITHUB_TOKEN}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      ...(options.headers || {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  if (res.status === 204) return null;
  const text = await res.text();
  if (!text) return null;
  const data = JSON.parse(text);
  if (!res.ok) throw new Error(data.message || `GitHub API error: ${res.status}`);
  return data;
}

function getOwner(args) {
  return args?.owner || GITHUB_OWNER;
}

async function commitFiles(repo, message, files, ownerName) {
  const o = ownerName || GITHUB_OWNER;
  const ref = await gh(`/repos/${o}/${repo}/git/ref/heads/main`);
  const baseSha = ref.object.sha;
  const commit = await gh(`/repos/${o}/${repo}/git/commits/${baseSha}`);
  const baseTreeSha = commit.tree.sha;
  const treeItems = await Promise.all(files.map(async (f) => {
    const blob = await gh(`/repos/${o}/${repo}/git/blobs`, {
      method: 'POST',
      body: { content: f.content, encoding: 'utf-8' }
    });
    return { path: f.path, mode: '100644', type: 'blob', sha: blob.sha };
  }));
  const tree = await gh(`/repos/${o}/${repo}/git/trees`, {
    method: 'POST',
    body: { base_tree: baseTreeSha, tree: treeItems }
  });
  const newCommit = await gh(`/repos/${o}/${repo}/git/commits`, {
    method: 'POST',
    body: { message, tree: tree.sha, parents: [baseSha] }
  });
  await gh(`/repos/${o}/${repo}/git/refs/heads/main`, {
    method: 'PATCH',
    body: { sha: newCommit.sha }
  });
  return newCommit;
}

const tools = [
  {
    name: 'create_repo',
    description: '创建一个新的 GitHub 仓库',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '仓库名' },
        description: { type: 'string', description: '仓库描述（可选）' },
        is_private: { type: 'boolean', description: '是否私有，默认 true' }
      },
      required: ['name']
    }
  },
  {
    name: 'list_repos',
    description: '列出用户名下所有仓库',
    inputSchema: {
      type: 'object',
      properties: {
        per_page: { type: 'number', description: '每页数量，默认 30' },
        page: { type: 'number', description: '页码，默认 1' }
      }
    }
  },
  {
    name: 'list_files',
    description: '查看仓库目录结构',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: '仓库名' },
        path: { type: 'string', description: '目录路径，默认根目录' },
        recursive: { type: 'boolean', description: '是否递归列出所有文件，默认 false' },
        branch: { type: 'string', description: '分支名，默认 main' }
      },
      required: ['repo']
    }
  },
  {
    name: 'get_file',
    description: '读取仓库中某个文件的完整内容',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: '仓库名' },
        path: { type: 'string', description: '文件路径' },
        branch: { type: 'string', description: '分支名，默认 main' }
      },
      required: ['repo', 'path']
    }
  },
  {
    name: 'push_files',
    description: '批量推送文件到仓库（单次 commit）',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: '仓库名' },
        message: { type: 'string', description: 'commit 信息' },
        files: {
          type: 'array',
          description: '文件列表',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string' },
              content: { type: 'string' }
            },
            required: ['path', 'content']
          }
        }
      },
      required: ['repo', 'message', 'files']
    }
  },
  {
    name: 'patch_file',
    description: '局部修改文件（查找+替换）',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: '仓库名' },
        path: { type: 'string', description: '文件路径' },
        message: { type: 'string', description: 'commit 信息' },
        old_str: { type: 'string', description: '要替换的内容（必须唯一）' },
        new_str: { type: 'string', description: '替换后的内容，留空则删除' },
        branch: { type: 'string', description: '分支名，默认 main' }
      },
      required: ['repo', 'path', 'message', 'old_str']
    }
  },
  {
    name: 'delete_files',
    description: '删除仓库中的文件',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: '仓库名' },
        message: { type: 'string', description: 'commit 信息' },
        paths: {
          type: 'array',
          description: '要删除的文件路径列表',
          items: { type: 'string' }
        }
      },
      required: ['repo', 'message', 'paths']
    }
  },
  {
    name: 'delete_repo',
    description: '删除整个仓库（需二次确认）',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: '仓库名' },
        confirm: { type: 'string', description: '必须与 repo 一致才会执行删除' }
      },
      required: ['repo', 'confirm']
    }
  }
];

async function handleTool(name, args) {
  const o = getOwner(args);

  switch (name) {
    case 'create_repo': {
      const data = await gh('/user/repos', {
        method: 'POST',
        body: {
          name: args.name,
          description: args.description || '',
          private: args.is_private !== false
        }
      });
      return `仓库已创建\n名称：${data.name}\nURL：${data.html_url}\n克隆地址：${data.clone_url}`;
    }

    case 'list_repos': {
      const per_page = args.per_page || 30;
      const page = args.page || 1;
      const data = await gh(`/user/repos?per_page=${per_page}&page=${page}&sort=updated`);
      const list = data.map(r => `${r.private ? '🔒' : '🌐'} ${r.name} — ${r.html_url} (更新：${r.updated_at})`);
      return `共 ${list.length} 个仓库：\n${list.join('\n')}`;
    }

    case 'list_files': {
      const branch = args.branch || 'main';
      const path = args.path || '';
      if (args.recursive) {
        const data = await gh(`/repos/${o}/${args.repo}/git/trees/${branch}?recursive=1`);
        const files = data.tree.filter(i => i.type === 'blob').map(i => i.path);
        return files.join('\n');
      } else {
        const data = await gh(`/repos/${o}/${args.repo}/contents/${path}?ref=${branch}`);
        const items = Array.isArray(data) ? data : [data];
        return items.map(i => `${i.type === 'dir' ? '📁' : '📄'} ${i.name}`).join('\n');
      }
    }

    case 'get_file': {
      const branch = args.branch || 'main';
      const data = await gh(`/repos/${o}/${args.repo}/contents/${args.path}?ref=${branch}`);
      return Buffer.from(data.content, 'base64').toString('utf-8');
    }

    case 'push_files': {
      const commit = await commitFiles(args.repo, args.message, args.files, o);
      return `已推送 ${args.files.length} 个文件\ncommit：${commit.sha}\n信息：${args.message}`;
    }

    case 'patch_file': {
      const branch = args.branch || 'main';
      const data = await gh(`/repos/${o}/${args.repo}/contents/${args.path}?ref=${branch}`);
      const original = Buffer.from(data.content, 'base64').toString('utf-8');
      const count = original.split(args.old_str).length -

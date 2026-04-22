import { useState } from 'react';
import { FileCode, ChevronRight, ChevronDown, FolderOpen, Folder, Code2 } from 'lucide-react';
import type { Pipeline } from '../types';

interface FileTreePanelProps {
  pipeline: Pipeline | null;
}

interface TreeNode {
  name: string;
  path: string;
  content?: string;
  children?: Record<string, TreeNode>;
  isDir: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSafeGeneratedFilePath(path: string): boolean {
  if (!path || path.startsWith('/') || path.includes('\\')) return false;
  const parts = path.split('/');
  return parts.every((part) => part !== '' && part !== '.' && part !== '..');
}

function looksLikeGeneratedFile(path: string): boolean {
  return path.includes('/') || path.includes('.') || path === 'Dockerfile' || path === 'Makefile';
}

function getGeneratedFiles(output: unknown): Record<string, string> {
  if (!isRecord(output)) return {};
  const candidate = isRecord(output.files) ? output.files : output;
  const files: Record<string, string> = {};
  for (const [path, content] of Object.entries(candidate)) {
    if (
      typeof content === 'string' &&
      isSafeGeneratedFilePath(path) &&
      looksLikeGeneratedFile(path)
    ) {
      files[path] = content;
    }
  }
  return files;
}

function buildTree(files: Record<string, string>): Record<string, TreeNode> {
  const root: Record<string, TreeNode> = {};
  for (const [path, content] of Object.entries(files)) {
    const parts = path.split('/');
    let current = root;
    parts.forEach((part, i) => {
      if (!current[part]) {
        current[part] = {
          name: part,
          path: parts.slice(0, i + 1).join('/'),
          isDir: i < parts.length - 1,
          children: i < parts.length - 1 ? {} : undefined,
          content: i === parts.length - 1 ? content : undefined,
        };
      }
      if (i < parts.length - 1) {
        current = current[part].children!;
      }
    });
  }
  return root;
}

function getLanguage(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    py: 'python', js: 'javascript', ts: 'typescript',
    tsx: 'tsx', jsx: 'jsx', go: 'go', rs: 'rust',
    json: 'json', yaml: 'yaml', yml: 'yaml',
    md: 'markdown', html: 'html', css: 'css',
    sh: 'bash', dockerfile: 'dockerfile',
  };
  return map[ext] ?? 'plaintext';
}

interface TreeItemProps {
  node: TreeNode;
  depth: number;
  onSelect: (node: TreeNode) => void;
  selected: string | null;
}

function TreeItem({ node, depth, onSelect, selected }: TreeItemProps) {
  const [open, setOpen] = useState(depth === 0);

  if (node.isDir) {
    return (
      <div>
        <button
          onClick={() => setOpen(!open)}
          className="flex items-center gap-1 w-full text-left px-2 py-1 text-xs text-forge-muted hover:text-forge-text hover:bg-white/5 rounded transition-colors"
          style={{ paddingLeft: `${8 + depth * 12}px` }}
        >
          {open ? (
            <><ChevronDown className="w-3 h-3 shrink-0" /><FolderOpen className="w-3 h-3 shrink-0 text-amber-400" /></>
          ) : (
            <><ChevronRight className="w-3 h-3 shrink-0" /><Folder className="w-3 h-3 shrink-0 text-amber-400/70" /></>
          )}
          <span className="truncate">{node.name}</span>
        </button>
        {open && node.children && Object.values(node.children).map((child) => (
          <TreeItem key={child.path} node={child} depth={depth + 1} onSelect={onSelect} selected={selected} />
        ))}
      </div>
    );
  }

  const isSelected = selected === node.path;
  return (
    <button
      onClick={() => onSelect(node)}
      className={`flex items-center gap-1.5 w-full text-left px-2 py-1 text-xs rounded transition-colors truncate ${
        isSelected
          ? 'bg-indigo-500/15 text-indigo-300 border-l border-indigo-500'
          : 'text-forge-muted hover:text-forge-text hover:bg-white/5'
      }`}
      style={{ paddingLeft: `${8 + depth * 12}px` }}
    >
      <FileCode className="w-3 h-3 shrink-0" />
      <span className="truncate">{node.name}</span>
    </button>
  );
}

export default function FileTreePanel({ pipeline }: FileTreePanelProps) {
  const [selectedNode, setSelectedNode] = useState<TreeNode | null>(null);

  // Extract generated files from the codegen agent output
  const codegenAgent = pipeline?.agents.find((a) => a.agent === 'codegen');
  const generatedFiles = getGeneratedFiles(codegenAgent?.output);
  const hasFiles = Object.keys(generatedFiles).length > 0;

  const tree = hasFiles ? buildTree(generatedFiles) : {};

  if (!pipeline || !hasFiles) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-2 text-forge-muted">
        <Code2 className="w-8 h-8 opacity-30" />
        <p className="text-xs text-center px-4">Generated files will appear here after codegen</p>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Tree header */}
      <div className="px-3 py-2 border-b border-forge-border shrink-0">
        <span className="text-xs font-semibold text-forge-muted uppercase tracking-widest">Files</span>
        <span className="ml-2 text-xs text-forge-muted/60">{Object.keys(generatedFiles).length}</span>
      </div>

      {/* Tree */}
      <div className="flex-1 overflow-y-auto p-1 min-h-0">
        {Object.values(tree).map((node) => (
          <TreeItem
            key={node.path}
            node={node}
            depth={0}
            onSelect={setSelectedNode}
            selected={selectedNode?.path ?? null}
          />
        ))}
      </div>

      {/* Code viewer */}
      {selectedNode && selectedNode.content !== undefined && (
        <div className="flex flex-col border-t border-forge-border" style={{ height: '55%' }}>
          <div className="flex items-center gap-2 px-3 py-1.5 bg-forge-surface-solid shrink-0">
            <FileCode className="w-3 h-3 text-indigo-400 shrink-0" />
            <span className="text-xs text-forge-muted truncate">{selectedNode.path}</span>
            <span className="ml-auto text-xs text-forge-muted/50">{getLanguage(selectedNode.name)}</span>
          </div>
          <pre className="flex-1 overflow-auto text-xs p-3 font-mono leading-relaxed text-forge-text/90 bg-forge-bg/60">
            <code>{selectedNode.content}</code>
          </pre>
        </div>
      )}
    </div>
  );
}

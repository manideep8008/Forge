import { useRef, useEffect, useState } from 'react';
import {
  Send, Loader2, User, Bot, CheckCircle2, XCircle,
  AlertTriangle, ChevronDown, ChevronUp, History, Trash2,
  GitFork, MessageSquare,
} from 'lucide-react';
import type { Pipeline, AgentOutput } from '../types';
import HITLGate from './HITLGate';
import type { HITLDecision } from '../types';

interface ChatPanelProps {
  pipeline: Pipeline | null;
  connected: boolean;
  onSubmit: (text: string) => void;
  onModify: (pipelineId: string, message: string) => Promise<boolean>;
  submitting: boolean;
  pipelines: Array<{ id: string; status: string; name?: string; description?: string; input_text?: string; parent_pipeline_id?: string | null }>;
  onSelectPipeline: (id: string) => void;
  onDeletePipeline: (id: string) => void;
  onForkPipeline?: (id: string) => Promise<void>;
  onToggleComments?: () => void;
  showComments?: boolean;
}

const AGENT_ICONS: Record<string, string> = {
  requirements: '📋',
  architect: '🏗️',
  codegen: '💻',
  review: '🔍',
  test: '🧪',
  hitl: '👤',
  cicd: '🚀',
  deploy: '🚀',
  monitor: '📡',
};

const STATUS_DOT: Record<string, string> = {
  completed: 'bg-emerald-400',
  failed: 'bg-red-400',
  running: 'bg-forge-text animate-pulse',
  pending: 'bg-forge-muted/40',
};

const SUGGESTIONS = [
  "Add Dark Mode 🌙",
  "Add User Authentication 🔒",
  "Make Mobile Responsive 📱"
];

function AgentBubble({ agent }: { agent: AgentOutput }) {
  const [expanded, setExpanded] = useState(false);
  const icon = AGENT_ICONS[agent.agent] ?? '🤖';
  const dot = STATUS_DOT[agent.status] ?? STATUS_DOT.pending;

  const summary = (() => {
    if (!agent.output) return null;
    const out = agent.output as Record<string, unknown>;
    if (agent.agent === 'requirements') return (out.title as string) ?? null;
    if (agent.agent === 'architect') {
      const decisions = out.architecture_decisions as string[] | undefined;
      return decisions?.[0] ?? null;
    }
    if (agent.agent === 'codegen') {
      const files = out.files as Record<string, string> | undefined;
      if (files) return `Generated ${Object.keys(files).length} files`;
    }
    if (agent.agent === 'review') {
      const issues = out.issues as Array<{ severity: string }> | undefined;
      if (issues) return `${issues.length} issue${issues.length !== 1 ? 's' : ''} found`;
    }
    if (agent.agent === 'test') {
      const results = out.test_results as Array<{ status: string }> | undefined;
      if (results) {
        const passed = results.filter((r) => r.status === 'passed').length;
        return `${passed}/${results.length} tests passed`;
      }
    }
    if (out.summary) return out.summary as string;
    return null;
  })();

  return (
    <div className="flex gap-2.5 animate-slide-up">
      <div className="flex flex-col items-center gap-1 pt-0.5 shrink-0">
        <div className="w-7 h-7 rounded-lg bg-forge-surface border border-forge-border flex items-center justify-center text-sm">
          {icon}
        </div>
        <div className={`w-1.5 h-1.5 rounded-full ${dot}`} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-0.5">
          <span className="text-xs font-semibold capitalize">{agent.agent}</span>
          {agent.status === 'running' && (
            <Loader2 className="w-3 h-3 text-forge-muted animate-spin" />
          )}
          {agent.status === 'completed' && (
            <CheckCircle2 className="w-3 h-3 text-emerald-400" />
          )}
          {agent.status === 'failed' && (
            <XCircle className="w-3 h-3 text-red-400" />
          )}
        </div>
        {summary && (
          <p className="text-xs text-forge-muted leading-relaxed">{summary}</p>
        )}
        {agent.agent !== 'codegen' && agent.output && (
          <button
            onClick={() => setExpanded(!expanded)}
            className="mt-1 flex items-center gap-1 text-xs text-forge-muted/60 hover:text-forge-muted transition-colors"
          >
            {expanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
            {expanded ? 'Hide details' : 'Show details'}
          </button>
        )}
        {agent.agent !== 'codegen' && expanded && agent.output && (
          <pre className="mt-2 text-xs bg-forge-bg/80 border border-forge-border rounded-lg p-2 overflow-auto max-h-48 text-forge-muted/80 leading-relaxed font-mono whitespace-pre-wrap">
            {JSON.stringify(agent.output, null, 2)}
          </pre>
        )}
        {agent.agent === 'codegen' && agent.output && (agent.output as Record<string, any>).files && (
          <div className="mt-2 flex flex-col gap-1.5">
            {Object.keys((agent.output as Record<string, any>).files).map((path) => (
              <div key={path} className="flex items-center gap-2 bg-forge-surface/80 border border-forge-border rounded-md px-2.5 py-1.5 w-fit shadow-sm">
                <span className="text-xs">📄</span>
                <span className="text-[11px] text-forge-text font-mono tracking-wide">Wrote <span className="text-forge-text-dim">{path}</span></span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default function ChatPanel({
  pipeline,
  connected,
  onSubmit,
  onModify,
  submitting,
  pipelines,
  onSelectPipeline,
  onDeletePipeline,
  onForkPipeline,
  onToggleComments,
  showComments,
}: ChatPanelProps) {
  const [input, setInput] = useState('');
  const [modifyInput, setModifyInput] = useState('');
  const [modifying, setModifying] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  const [hitlDismissed, setHitlDismissed] = useState(false);
  const isHITL = !hitlDismissed && ((pipeline?.status as string) === 'awaiting_approval' || pipeline?.current_stage === 'hitl');

  // Reset dismissed state when pipeline transitions out of awaiting_approval
  useEffect(() => {
    if (pipeline?.status !== 'awaiting_approval' && pipeline?.current_stage !== 'hitl') {
      setHitlDismissed(false);
    }
  }, [pipeline?.status, pipeline?.current_stage]);

  useEffect(() => {
    setModifying(false);
  }, [pipeline?.id]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [pipeline?.agents.length, pipeline?.status]);

  const handleSend = () => {
    const text = input.trim();
    if (!text || submitting) return;
    setInput('');
    onSubmit(text);
  };

  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      handleSend();
    }
  };

  const startModify = async (text: string) => {
    if (!pipeline?.id || modifying) return;

    setModifying(true);
    try {
      const started = await onModify(pipeline.id, text);
      if (!started) {
        setModifyInput(text);
      }
    } finally {
      setModifying(false);
    }
  };

  const handleModify = async () => {
    const text = modifyInput.trim();
    if (!text || modifying || !pipeline?.id) return;
    setModifyInput('');
    await startModify(text);
  };

  const handleModifyKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      void handleModify();
    }
  };

  return (
    <div className="h-full flex flex-col overflow-hidden bg-forge-bg/40">
      {/* Panel header */}
      <div className="px-3 py-2 border-b border-forge-border shrink-0 flex items-center justify-between">
        <span className="text-xs font-semibold text-forge-muted uppercase tracking-widest flex items-center gap-1.5">
          <Bot className="w-3.5 h-3.5" /> Chat
        </span>
        <div className="flex items-center gap-1">
          {pipeline && onForkPipeline && (
            <button
              onClick={() => { void onForkPipeline(pipeline.id); }}
              title="Fork this pipeline"
              className="flex items-center gap-1 text-xs text-forge-muted/60 hover:text-forge-text transition-colors px-1.5 py-1 rounded hover:bg-white/5"
            >
              <GitFork className="w-3 h-3" />
              Fork
            </button>
          )}
          {pipeline && onToggleComments && (
            <button
              onClick={onToggleComments}
              title="Toggle comments"
              className={`flex items-center gap-1 text-xs transition-colors px-1.5 py-1 rounded hover:bg-white/5 ${showComments ? 'text-forge-text' : 'text-forge-muted/60 hover:text-forge-text'}`}
            >
              <MessageSquare className="w-3 h-3" />
              Notes
            </button>
          )}
          <button
            onClick={() => setShowHistory(!showHistory)}
            className="flex items-center gap-1 text-xs text-forge-muted/60 hover:text-forge-muted transition-colors px-1.5 py-1 rounded hover:bg-white/5"
          >
            <History className="w-3 h-3" />
            History
          </button>
        </div>
      </div>

      {/* History drawer */}
      {showHistory && (
        <div className="border-b border-forge-border/50 bg-forge-bg/60 max-h-64 overflow-y-auto shrink-0 py-2">
          {pipelines.length === 0 ? (
            <p className="text-xs text-forge-muted p-3 text-center">No previous pipelines</p>
          ) : (
            (() => {
              const roots = pipelines.filter(p => !p.parent_pipeline_id);
              const children = pipelines.filter(p => p.parent_pipeline_id).reduce((acc, p) => {
                const parentId = p.parent_pipeline_id!;
                if (!acc[parentId]) acc[parentId] = [];
                acc[parentId].push(p);
                return acc;
              }, {} as Record<string, typeof pipelines>);

              return roots.map((p) => (
                <div key={p.id} className="mb-1">
                  {/* Parent Project */}
                  <div className="group relative flex items-center">
                    <button
                      onClick={() => { onSelectPipeline(p.id); setShowHistory(false); }}
                      className={`flex-1 text-left px-3 py-2 text-xs hover:bg-white/5 transition-colors border-l-2 ${
                        p.id === pipeline?.id ? 'bg-white/5 text-forge-text border-forge-border-bright' : 'text-forge-muted border-transparent'
                      }`}
                    >
                      <div className="font-semibold truncate pr-6">{p.name || p.input_text || `Project ${p.id.slice(0, 8)}`}</div>
                      <div className="text-forge-muted/60 mt-0.5">{p.status}</div>
                    </button>
                    <button
                      onClick={(e) => { e.stopPropagation(); onDeletePipeline(p.id); }}
                      className="absolute right-2 opacity-0 group-hover:opacity-100 p-1.5 text-forge-muted hover:text-red-400 hover:bg-red-400/10 rounded transition-all"
                      title="Delete Project"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>

                  {/* Children / Iterations */}
                  {children[p.id] && children[p.id].map(child => (
                    <div key={child.id} className="group relative flex items-center">
                      <button
                        onClick={() => { onSelectPipeline(child.id); setShowHistory(false); }}
                        className={`flex-1 text-left pl-6 pr-3 py-1.5 text-xs hover:bg-white/5 transition-colors border-l-2 relative ${
                          child.id === pipeline?.id ? 'bg-white/5 text-forge-text border-forge-border-bright' : 'text-forge-muted/80 border-transparent'
                        }`}
                      >
                        <div className="absolute left-2.5 top-0 bottom-0 border-l border-forge-border/40" />
                        <div className="absolute left-2.5 top-1/2 w-2 border-t border-forge-border/40" />
                        <div className="font-medium truncate pl-1 pr-6">↳ {child.input_text || `Iteration ${child.id.slice(0, 8)}`}</div>
                        <div className="text-forge-muted/50 mt-0.5 pl-1">{child.status}</div>
                      </button>
                      <button
                        onClick={(e) => { e.stopPropagation(); onDeletePipeline(child.id); }}
                        className="absolute right-2 opacity-0 group-hover:opacity-100 p-1 text-forge-muted hover:text-red-400 hover:bg-red-400/10 rounded transition-all"
                        title="Delete Iteration"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              ));
            })()
          )}
        </div>
      )}

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-3 space-y-4 min-h-0">
        {!pipeline ? (
          <div className="h-full flex flex-col items-center justify-center gap-3 text-center">
            <div className="w-12 h-12 rounded-2xl bg-forge-surface border border-forge-border flex items-center justify-center text-2xl">
              🔨
            </div>
            <div>
              <p className="text-sm font-semibold">What do you want to build?</p>
              <p className="text-xs text-forge-muted mt-1">Describe your app below and Forge will build it end-to-end.</p>
            </div>
          </div>
        ) : (
          <>
            {/* User prompt bubble */}
            <div className="flex gap-2.5 justify-end">
              <div className="max-w-[85%] bg-forge-surface border border-forge-border rounded-2xl rounded-tr-sm px-3 py-2">
                <p className="text-xs leading-relaxed">{pipeline.description || pipeline.input_text}</p>
              </div>
              <div className="w-7 h-7 rounded-lg bg-forge-surface border border-forge-border flex items-center justify-center shrink-0">
                <User className="w-3.5 h-3.5 text-forge-text-dim" />
              </div>
            </div>

            {/* Status thinking bubble */}
            {pipeline.status === 'pending' && (
              <div className="flex gap-2.5">
                <div className="w-7 h-7 rounded-lg bg-forge-surface border border-forge-border flex items-center justify-center text-sm shrink-0">
                  🤖
                </div>
                <div className="flex items-center gap-2 bg-forge-surface/60 border border-forge-border rounded-2xl rounded-tl-sm px-3 py-2">
                  <Loader2 className="w-3.5 h-3.5 text-forge-muted animate-spin" />
                  <span className="text-xs text-forge-muted">Analysing your request…</span>
                </div>
              </div>
            )}

            {/* Agent bubbles */}
            {pipeline.agents.map((agent, i) => (
              <AgentBubble key={`${agent.agent}-${i}`} agent={agent} />
            ))}

            {/* HITL inline gate */}
            {isHITL && (
              <div className="border border-amber-500/25 bg-amber-500/5 rounded-xl p-3 animate-slide-up">
                <div className="flex items-center gap-2 mb-2">
                  <AlertTriangle className="w-4 h-4 text-amber-400" />
                  <span className="text-xs font-semibold text-amber-400">Awaiting your approval</span>
                </div>
                <HITLGate
                  pipelineId={pipeline.id}
                  agents={pipeline.agents}
                  onClose={() => setHitlDismissed(true)}
                  onDecision={(_d: HITLDecision) => setHitlDismissed(true)}
                  compact
                />
              </div>
            )}

            {/* Pipeline complete */}
            {pipeline.status === 'completed' && (
              <div className="flex gap-2.5 animate-slide-up">
                <div className="w-7 h-7 rounded-lg bg-emerald-500/20 border border-emerald-500/30 flex items-center justify-center shrink-0">
                  <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                </div>
                <div className="bg-emerald-500/10 border border-emerald-500/20 rounded-2xl rounded-tl-sm px-3 py-2">
                  <p className="text-xs text-emerald-300 font-medium">Pipeline complete! Your app is live in the preview ✨</p>
                </div>
              </div>
            )}

            {/* Continuation input (after completion) */}
            {pipeline.status === 'completed' && (
              <div className="border border-forge-border bg-forge-surface/30 rounded-xl p-3 animate-slide-up">
                <div className="flex items-center justify-between mb-3">
                  <p className="text-xs font-semibold text-forge-text flex items-center gap-1.5">
                    <span className="text-sm">✏️</span> What would you like to change?
                  </p>
                  <div className="flex gap-1.5 flex-wrap justify-end">
                    {SUGGESTIONS.map((sug) => (
                      <button
                        key={sug}
                        onClick={() => {
                          if (modifying) return;
                          setModifyInput('');
                          void startModify(sug);
                        }}
                        disabled={modifying}
                        className="text-[10px] px-2 py-1 rounded-full bg-forge-surface text-forge-muted border border-forge-border hover:bg-forge-bg hover:border-forge-border-bright transition-colors disabled:opacity-50"
                      >
                        {sug}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="relative">
                  <textarea
                    value={modifyInput}
                    onChange={(e) => setModifyInput(e.target.value)}
                    onKeyDown={handleModifyKey}
                    placeholder="e.g. add dark mode, change button color, add a /health endpoint… (⌘↵ to send)"
                    rows={2}
                    className="w-full resize-none bg-forge-bg border border-forge-border rounded-lg px-3 py-2 pr-10 text-xs text-forge-text placeholder-forge-muted/50 focus:outline-none focus:border-forge-border-bright transition-all leading-relaxed"
                    disabled={modifying}
                  />
                  <button
                    onClick={() => { void handleModify(); }}
                    disabled={!modifyInput.trim() || modifying}
                    className="absolute bottom-2 right-2 p-1.5 rounded-lg bg-forge-surface border border-forge-border hover:bg-white/10 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
                  >
                    {modifying
                      ? <Loader2 className="w-3.5 h-3.5 text-forge-text animate-spin" />
                      : <Send className="w-3.5 h-3.5 text-forge-text" />}
                  </button>
                </div>
              </div>
            )}

            {/* Pipeline failed */}
            {pipeline.status === 'failed' && (
              <div className="flex gap-2.5 animate-slide-up">
                <div className="w-7 h-7 rounded-lg bg-red-500/20 border border-red-500/30 flex items-center justify-center shrink-0">
                  <XCircle className="w-4 h-4 text-red-400" />
                </div>
                <div className="bg-red-500/10 border border-red-500/20 rounded-2xl rounded-tl-sm px-3 py-2">
                  <p className="text-xs text-red-300 font-medium">Pipeline failed.</p>
                  {pipeline.agents.find(a => a.status === 'failed') && (
                    <p className="text-xs text-red-300/70 mt-0.5">Check the agent cards for details.</p>
                  )}
                </div>
              </div>
            )}

            {/* Running indicator */}
            {pipeline.status === 'running' && (
              <div className="flex items-center gap-2 text-xs text-forge-muted">
                <div className="flex gap-1">
                  {[0, 150, 300].map(d => (
                    <div
                      key={d}
                      className="w-1.5 h-1.5 rounded-full bg-forge-muted animate-bounce"
                      style={{ animationDelay: `${d}ms` }}
                    />
                  ))}
                </div>
                <span>
                  {pipeline.current_stage
                    ? `Running ${pipeline.current_stage}…`
                    : 'Processing…'}
                </span>
              </div>
            )}
          </>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Input bar */}
      <div className="p-3 border-t border-forge-border shrink-0">
        <div className="relative">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKey}
            placeholder="Describe what you want to build… (⌘↵ to send)"
            rows={3}
            className="w-full resize-none bg-forge-bg border border-forge-border rounded-xl px-3 py-2.5 pr-10 text-xs text-forge-text placeholder-forge-muted/50 focus:outline-none focus:border-forge-border-bright transition-all leading-relaxed"
            disabled={submitting}
          />
          <button
            onClick={handleSend}
            disabled={!input.trim() || submitting}
            className="absolute bottom-2.5 right-2.5 p-1.5 rounded-lg bg-forge-surface border border-forge-border hover:bg-white/10 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
          >
            {submitting
              ? <Loader2 className="w-3.5 h-3.5 text-forge-text animate-spin" />
              : <Send className="w-3.5 h-3.5 text-forge-text" />}
          </button>
        </div>
        <p className="text-xs text-forge-muted/40 mt-1.5 text-right">
          {pipeline && (connected ? '🟢 connected' : '🔴 reconnecting…')}
        </p>
      </div>
    </div>
  );
}

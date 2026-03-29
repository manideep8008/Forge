import { useRef, useEffect, useState } from 'react';
import {
  Send, Loader2, User, Bot, CheckCircle2, XCircle,
  AlertTriangle, ChevronDown, ChevronUp, History,
} from 'lucide-react';
import type { Pipeline, AgentOutput } from '../types';
import HITLGate from './HITLGate';
import type { HITLDecision } from '../types';

interface ChatPanelProps {
  pipeline: Pipeline | null;
  connected: boolean;
  onSubmit: (text: string) => void;
  onModify: (pipelineId: string, message: string) => void;
  submitting: boolean;
  pipelines: Array<{ id: string; status: string; name?: string; description?: string; input_text?: string }>;
  onSelectPipeline: (id: string) => void;
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
  running: 'bg-indigo-400 animate-pulse',
  pending: 'bg-forge-muted/40',
};

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
            <Loader2 className="w-3 h-3 text-indigo-400 animate-spin" />
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
        {agent.output && (
          <button
            onClick={() => setExpanded(!expanded)}
            className="mt-1 flex items-center gap-1 text-xs text-forge-muted/60 hover:text-forge-muted transition-colors"
          >
            {expanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
            {expanded ? 'Hide details' : 'Show details'}
          </button>
        )}
        {expanded && agent.output && (
          <pre className="mt-2 text-xs bg-forge-bg/80 border border-forge-border rounded-lg p-2 overflow-auto max-h-48 text-forge-muted/80 leading-relaxed font-mono whitespace-pre-wrap">
            {JSON.stringify(agent.output, null, 2)}
          </pre>
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
}: ChatPanelProps) {
  const [input, setInput] = useState('');
  const [modifyInput, setModifyInput] = useState('');
  const [modifying, setModifying] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  const isHITL = (pipeline?.status as string) === 'awaiting_approval' || pipeline?.current_stage === 'hitl';

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

  const handleModify = () => {
    const text = modifyInput.trim();
    if (!text || modifying || !pipeline?.id) return;
    setModifying(true);
    setModifyInput('');
    onModify(pipeline.id, text);
    // modifying state is reset by parent when new pipeline arrives
    setTimeout(() => setModifying(false), 2000);
  };

  const handleModifyKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleModify();
  };

  return (
    <div className="h-full flex flex-col overflow-hidden bg-forge-bg/40">
      {/* Panel header */}
      <div className="px-3 py-2 border-b border-forge-border shrink-0 flex items-center justify-between">
        <span className="text-xs font-semibold text-forge-muted uppercase tracking-widest flex items-center gap-1.5">
          <Bot className="w-3.5 h-3.5" /> Chat
        </span>
        <button
          onClick={() => setShowHistory(!showHistory)}
          className="flex items-center gap-1 text-xs text-forge-muted/60 hover:text-forge-muted transition-colors"
        >
          <History className="w-3 h-3" />
          History
        </button>
      </div>

      {/* History drawer */}
      {showHistory && (
        <div className="border-b border-forge-border/50 bg-forge-bg/60 max-h-48 overflow-y-auto shrink-0">
          {pipelines.length === 0 ? (
            <p className="text-xs text-forge-muted p-3 text-center">No previous pipelines</p>
          ) : (
            pipelines.map((p) => (
              <button
                key={p.id}
                onClick={() => { onSelectPipeline(p.id); setShowHistory(false); }}
                className={`w-full text-left px-3 py-2 text-xs hover:bg-white/5 transition-colors border-b border-forge-border/30 last:border-0 ${
                  p.id === pipeline?.id ? 'bg-indigo-500/10 text-indigo-300' : 'text-forge-muted'
                }`}
              >
                <div className="font-medium truncate">{p.name || p.input_text || `Pipeline ${p.id.slice(0, 8)}`}</div>
                <div className="text-forge-muted/60 mt-0.5">{p.status}</div>
              </button>
            ))
          )}
        </div>
      )}

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-3 space-y-4 min-h-0">
        {!pipeline ? (
          <div className="h-full flex flex-col items-center justify-center gap-3 text-center">
            <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-indigo-500/10 to-purple-500/10 border border-indigo-500/20 flex items-center justify-center text-2xl">
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
              <div className="max-w-[85%] bg-indigo-500/15 border border-indigo-500/25 rounded-2xl rounded-tr-sm px-3 py-2">
                <p className="text-xs leading-relaxed">{pipeline.description || pipeline.input_text}</p>
              </div>
              <div className="w-7 h-7 rounded-lg bg-indigo-500/20 border border-indigo-500/30 flex items-center justify-center shrink-0">
                <User className="w-3.5 h-3.5 text-indigo-400" />
              </div>
            </div>

            {/* Status thinking bubble */}
            {pipeline.status === 'pending' && (
              <div className="flex gap-2.5">
                <div className="w-7 h-7 rounded-lg bg-forge-surface border border-forge-border flex items-center justify-center text-sm shrink-0">
                  🤖
                </div>
                <div className="flex items-center gap-2 bg-forge-surface/60 border border-forge-border rounded-2xl rounded-tl-sm px-3 py-2">
                  <Loader2 className="w-3.5 h-3.5 text-indigo-400 animate-spin" />
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
                  onClose={() => {}}
                  onDecision={(_d: HITLDecision) => {}}
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

            {/* ── Continuation input (after completion) ── */}
            {pipeline.status === 'completed' && (
              <div className="border border-indigo-500/20 bg-indigo-500/5 rounded-xl p-3 animate-slide-up">
                <p className="text-xs font-semibold text-indigo-400 mb-2">✏️ What would you like to change?</p>
                <div className="relative">
                  <textarea
                    value={modifyInput}
                    onChange={(e) => setModifyInput(e.target.value)}
                    onKeyDown={handleModifyKey}
                    placeholder="e.g. add dark mode, change button color, add a /health endpoint… (⌘↵ to send)"
                    rows={2}
                    className="w-full resize-none bg-forge-bg border border-indigo-500/30 rounded-lg px-3 py-2 pr-10 text-xs text-forge-text placeholder-forge-muted/50 focus:outline-none focus:ring-2 focus:ring-indigo-500/30 transition-all leading-relaxed"
                    disabled={modifying}
                  />
                  <button
                    onClick={handleModify}
                    disabled={!modifyInput.trim() || modifying}
                    className="absolute bottom-2 right-2 p-1.5 rounded-lg bg-indigo-500/80 hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
                  >
                    {modifying
                      ? <Loader2 className="w-3.5 h-3.5 text-white animate-spin" />
                      : <Send className="w-3.5 h-3.5 text-white" />}
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
                      className="w-1.5 h-1.5 rounded-full bg-indigo-400 animate-bounce"
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
            className="w-full resize-none bg-forge-bg border border-forge-border rounded-xl px-3 py-2.5 pr-10 text-xs text-forge-text placeholder-forge-muted/50 focus:outline-none focus:ring-2 focus:ring-indigo-500/30 focus:border-indigo-500/40 transition-all leading-relaxed"
            disabled={submitting}
          />
          <button
            onClick={handleSend}
            disabled={!input.trim() || submitting}
            className="absolute bottom-2.5 right-2.5 p-1.5 rounded-lg bg-indigo-500/80 hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
          >
            {submitting
              ? <Loader2 className="w-3.5 h-3.5 text-white animate-spin" />
              : <Send className="w-3.5 h-3.5 text-white" />}
          </button>
        </div>
        <p className="text-xs text-forge-muted/40 mt-1.5 text-right">
          {pipeline && (connected ? '🟢 connected' : '🔴 reconnecting…')}
        </p>
      </div>
    </div>
  );
}

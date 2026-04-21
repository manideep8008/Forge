import { useEffect, useRef } from 'react';
import {
  CheckCircle2,
  Loader2,
  XCircle,
  Zap,
  Play,
  AlertTriangle,
  Rocket,
  FileCode2,
  Search,
  FlaskConical,
  Brain,
  LayoutDashboard,
  Tag,
} from 'lucide-react';
import type { PipelineEvent } from '../types';

interface ActivityFeedProps {
  events: PipelineEvent[];
}

/** Human-readable labels for event types. */
function eventMeta(evt: PipelineEvent): { icon: React.ReactNode; color: string; title: string } {
  const t = evt.type;
  const stage = evt.data?.stage ?? evt.stage;

  // Stage started
  if (t === 'stage_started') {
    const stageIcons: Record<string, React.ReactNode> = {
      requirements: <Brain className="w-3.5 h-3.5" />,
      architect: <LayoutDashboard className="w-3.5 h-3.5" />,
      codegen: <FileCode2 className="w-3.5 h-3.5" />,
      review: <Search className="w-3.5 h-3.5" />,
      test: <FlaskConical className="w-3.5 h-3.5" />,
      deploy: <Rocket className="w-3.5 h-3.5" />,
    };
    return {
      icon: stageIcons[stage as string] ?? <Play className="w-3.5 h-3.5" />,
      color: 'text-indigo-400 bg-indigo-400/10 border-indigo-400/20',
      title: `${capitalize(stage as string)} started`,
    };
  }

  // Stage / agent completed
  if (t.includes('completed') || t === 'stage_completed') {
    return {
      icon: <CheckCircle2 className="w-3.5 h-3.5" />,
      color: 'text-emerald-400 bg-emerald-400/10 border-emerald-400/20',
      title: `${capitalize(extractAgent(t, stage))} completed`,
    };
  }

  // Stage failed
  if (t === 'stage_failed' || t === 'pipeline_failed' || t === 'pipeline.halted') {
    return {
      icon: <XCircle className="w-3.5 h-3.5" />,
      color: 'text-red-400 bg-red-400/10 border-red-400/20',
      title: `${capitalize(extractAgent(t, stage))} failed`,
    };
  }

  // Intent classified
  if (t === 'pipeline.intent_classified') {
    return {
      icon: <Tag className="w-3.5 h-3.5" />,
      color: 'text-violet-400 bg-violet-400/10 border-violet-400/20',
      title: 'Intent classified',
    };
  }

  // Pipeline started
  if (t === 'pipeline_started' || t === 'pipeline.started') {
    return {
      icon: <Zap className="w-3.5 h-3.5" />,
      color: 'text-amber-400 bg-amber-400/10 border-amber-400/20',
      title: 'Pipeline started',
    };
  }

  // HITL required
  if (t === 'hitl_required') {
    return {
      icon: <AlertTriangle className="w-3.5 h-3.5" />,
      color: 'text-amber-400 bg-amber-400/10 border-amber-400/20',
      title: 'Approval required',
    };
  }

  // Streaming / generic
  return {
    icon: <Loader2 className="w-3.5 h-3.5 animate-spin" />,
    color: 'text-indigo-400 bg-indigo-400/10 border-indigo-400/20',
    title: humanize(t),
  };
}

function capitalize(s: string | undefined): string {
  if (!s) return 'Unknown';
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function extractAgent(eventType: string, stage: unknown): string {
  // "agent.codegen.completed" → "Codegen"
  const parts = eventType.split('.');
  if (parts[0] === 'agent' && parts.length >= 2) return parts[1];
  if (typeof stage === 'string' && stage) return stage;
  if (parts[0] === 'pipeline') return 'Pipeline';
  return eventType;
}

function humanize(s: string): string {
  return s
    .replace(/[._]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function timeAgo(timestamp: string): string {
  const now = Date.now();
  const then = new Date(timestamp).getTime();
  const diff = Math.max(0, Math.floor((now - then) / 1000));
  if (diff < 5) return 'just now';
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  return `${Math.floor(diff / 3600)}h ago`;
}

export default function ActivityFeed({ events }: ActivityFeedProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  // Auto‑scroll to bottom when new events arrive
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [events.length]);

  if (events.length === 0) {
    return (
      <div className="flex items-center justify-center py-8 text-forge-muted/50 text-xs">
        <Loader2 className="w-3.5 h-3.5 animate-spin mr-2" />
        Waiting for pipeline events…
      </div>
    );
  }

  // Display in chronological order (newest at bottom for auto-scroll)
  return (
    <div className="space-y-0">
      {events.map((evt, i) => {
        const { icon, color, title } = eventMeta(evt);
        const message = typeof evt.data?.message === 'string' ? evt.data.message : undefined;
        const intentType =
          evt.data?.intent_type == null ? undefined : String(evt.data.intent_type);
        const fileNames = Array.isArray(evt.data?.file_names)
          ? evt.data.file_names.filter((name): name is string => typeof name === 'string')
          : [];
        const rawTokensUsed = evt.data?.tokens_used;
        const tokensUsed =
          typeof rawTokensUsed === 'number'
            ? rawTokensUsed
            : typeof rawTokensUsed === 'string'
              ? Number(rawTokensUsed)
              : undefined;

        return (
          <div key={i} className="flex items-start gap-3 group relative">
            {/* Timeline connector */}
            <div className="flex flex-col items-center shrink-0">
              <div className={`p-1.5 rounded-lg border ${color} transition-all duration-200 group-hover:scale-110`}>
                {icon}
              </div>
              {i < events.length - 1 && (
                <div className="w-[1.5px] flex-1 min-h-[16px] bg-forge-border/50 my-0.5" />
              )}
            </div>

            {/* Content */}
            <div className="flex-1 pb-3 min-w-0">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-xs font-semibold text-forge-text">{title}</span>
                <span className="text-[10px] text-forge-muted/50 shrink-0 tabular-nums">
                  {timeAgo(evt.timestamp)}
                </span>
              </div>
              {message && (
                <p className="text-[11px] text-forge-muted mt-0.5 leading-relaxed truncate">
                  {message}
                </p>
              )}
              {/* Show extra details for certain events */}
              {intentType && !message && (
                <p className="text-[11px] text-forge-muted mt-0.5">
                  Intent: <span className="text-violet-400 font-mono">{intentType}</span>
                </p>
              )}
              {fileNames.length > 0 && (
                <div className="flex flex-wrap gap-1 mt-1">
                  {fileNames.slice(0, 4).map((f) => (
                    <span key={f} className="text-[10px] font-mono px-1.5 py-0.5 bg-emerald-400/5 text-emerald-400/80 rounded border border-emerald-400/10">
                      {f.split('/').pop()}
                    </span>
                  ))}
                  {fileNames.length > 4 && (
                    <span className="text-[10px] text-forge-muted/50">
                      +{fileNames.length - 4} more
                    </span>
                  )}
                </div>
              )}
              {tokensUsed != null && Number.isFinite(tokensUsed) && (
                <span className="inline-block text-[10px] text-forge-muted/40 mt-0.5">
                  {tokensUsed.toLocaleString()} tokens
                </span>
              )}
            </div>
          </div>
        );
      })}
      <div ref={bottomRef} />
    </div>
  );
}

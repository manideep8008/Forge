import { useState } from 'react';
import ReactDiffViewer, { DiffMethod } from 'react-diff-viewer-continued';
import { ChevronDown, ChevronRight, FileCode2 } from 'lucide-react';

interface DiffViewerProps {
  filename: string;
  oldCode: string;
  newCode: string;
}

const diffStyles = {
  variables: {
    dark: {
      diffViewerBackground: '#0f172a',
      diffViewerColor: '#e2e8f0',
      addedBackground: '#064e3b20',
      addedColor: '#6ee7b7',
      removedBackground: '#7f1d1d20',
      removedColor: '#fca5a5',
      wordAddedBackground: '#065f4630',
      wordRemovedBackground: '#991b1b30',
      addedGutterBackground: '#064e3b30',
      removedGutterBackground: '#7f1d1d30',
      gutterBackground: '#1e293b',
      gutterBackgroundDark: '#1e293b',
      highlightBackground: '#1e3a5f',
      highlightGutterBackground: '#1e3a5f',
      codeFoldGutterBackground: '#1e293b',
      codeFoldBackground: '#1e293b',
      emptyLineBackground: '#0f172a',
      gutterColor: '#475569',
      addedGutterColor: '#6ee7b7',
      removedGutterColor: '#fca5a5',
      codeFoldContentColor: '#94a3b8',
      diffViewerTitleBackground: '#1e293b',
      diffViewerTitleColor: '#e2e8f0',
      diffViewerTitleBorderColor: '#334155',
    },
  },
  line: {
    padding: '2px 10px',
    fontSize: '12px',
    fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
  },
  gutter: {
    padding: '2px 10px',
    fontSize: '11px',
    minWidth: '40px',
  },
  contentText: {
    fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
    fontSize: '12px',
    lineHeight: '1.5',
  },
};

export default function DiffViewer({ filename, oldCode, newCode }: DiffViewerProps) {
  const [expanded, setExpanded] = useState(true);

  return (
    <div className="border border-forge-border rounded-lg overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-2 bg-slate-800/50 hover:bg-slate-800
          text-xs font-mono transition-colors"
      >
        {expanded ? (
          <ChevronDown className="w-3.5 h-3.5 text-forge-muted" />
        ) : (
          <ChevronRight className="w-3.5 h-3.5 text-forge-muted" />
        )}
        <FileCode2 className="w-3.5 h-3.5 text-forge-accent" />
        <span className="text-forge-text">{filename}</span>
      </button>

      {expanded && (
        <div className="overflow-x-auto">
          <ReactDiffViewer
            oldValue={oldCode}
            newValue={newCode}
            splitView={true}
            useDarkTheme={true}
            compareMethod={DiffMethod.WORDS}
            styles={diffStyles}
            leftTitle="Before"
            rightTitle="After"
          />
        </div>
      )}
    </div>
  );
}

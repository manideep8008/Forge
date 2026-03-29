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
      diffViewerBackground: '#0a0e1a',
      diffViewerColor: '#e2e8f0',
      addedBackground: '#064e3b15',
      addedColor: '#6ee7b7',
      removedBackground: '#7f1d1d15',
      removedColor: '#fca5a5',
      wordAddedBackground: '#065f4625',
      wordRemovedBackground: '#991b1b25',
      addedGutterBackground: '#064e3b20',
      removedGutterBackground: '#7f1d1d20',
      gutterBackground: '#0d1226',
      gutterBackgroundDark: '#0d1226',
      highlightBackground: '#1e3a5f',
      highlightGutterBackground: '#1e3a5f',
      codeFoldGutterBackground: '#0d1226',
      codeFoldBackground: '#0d1226',
      emptyLineBackground: '#0a0e1a',
      gutterColor: '#475569',
      addedGutterColor: '#6ee7b7',
      removedGutterColor: '#fca5a5',
      codeFoldContentColor: '#7c85a6',
      diffViewerTitleBackground: '#0d1226',
      diffViewerTitleColor: '#e2e8f0',
      diffViewerTitleBorderColor: 'rgba(56, 68, 100, 0.4)',
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
    <div className="border border-forge-border rounded-xl overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3.5 py-2.5 bg-forge-bg-alt hover:bg-white/[0.02]
          text-xs font-mono transition-colors"
      >
        <span className="text-forge-muted/60">
          {expanded ? (
            <ChevronDown className="w-3.5 h-3.5" />
          ) : (
            <ChevronRight className="w-3.5 h-3.5" />
          )}
        </span>
        <FileCode2 className="w-3.5 h-3.5 text-indigo-400" />
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

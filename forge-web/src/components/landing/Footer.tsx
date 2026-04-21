import { Hammer } from 'lucide-react';

export default function Footer() {
  return (
    <footer className="border-t border-forge-border py-8 px-4">
      <div className="max-w-6xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-4">
        <div className="flex items-center gap-2">
          <div className="p-1.5 bg-forge-surface border border-forge-border rounded-lg">
            <Hammer className="w-3.5 h-3.5 text-forge-text" />
          </div>
          <span className="font-bold text-sm tracking-tight text-forge-text">Forge</span>
        </div>
        <p className="text-xs text-forge-muted">
          © {new Date().getFullYear()} Forge. All rights reserved.
        </p>
      </div>
    </footer>
  );
}

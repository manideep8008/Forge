import { Link } from 'react-router-dom';
import { ArrowRight, Zap } from 'lucide-react';

export default function HeroSection() {
  return (
    <section className="relative flex flex-col items-center text-center px-4 pt-24 pb-20 overflow-hidden">
      {/* Background glow */}
      <div className="absolute inset-0 pointer-events-none">
        <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[600px] h-[400px] bg-white/[0.03] rounded-full blur-3xl" />
      </div>

      <div className="relative max-w-3xl mx-auto">
        <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full border border-forge-border bg-forge-surface text-xs text-forge-muted mb-8">
          <Zap className="w-3 h-3" />
          AI-powered software development
        </div>

        <h1 className="text-4xl sm:text-5xl lg:text-6xl font-bold tracking-tight text-forge-text leading-tight mb-6">
          Build Software with AI,
          <br />
          <span className="text-white/60">Ship with Confidence</span>
        </h1>

        <p className="text-base sm:text-lg text-forge-muted max-w-xl mx-auto mb-10 leading-relaxed">
          Forge orchestrates AI agents to generate, review, and test your code — with human-in-the-loop checkpoints so you stay in control.
        </p>

        <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
          <Link
            to="/register"
            className="btn-primary flex items-center gap-2 px-6 py-2.5 rounded-lg font-medium text-sm w-full sm:w-auto justify-center"
          >
            Get Started Free
            <ArrowRight className="w-4 h-4" />
          </Link>
          <a
            href="#features"
            className="text-sm text-forge-muted hover:text-forge-text transition-colors px-6 py-2.5 border border-forge-border rounded-lg w-full sm:w-auto text-center hover:border-forge-border-bright"
          >
            See How It Works
          </a>
        </div>
      </div>

      {/* Terminal mockup */}
      <div className="relative mt-16 w-full max-w-2xl mx-auto">
        <div className="card p-4 text-left font-mono text-xs leading-relaxed">
          <div className="flex gap-1.5 mb-3">
            <span className="w-2.5 h-2.5 rounded-full bg-red-500/60" />
            <span className="w-2.5 h-2.5 rounded-full bg-yellow-500/60" />
            <span className="w-2.5 h-2.5 rounded-full bg-green-500/60" />
          </div>
          <p className="text-forge-muted">$ forge run "Build a REST API with auth"</p>
          <p className="text-green-400/80 mt-1">✓ Requirements agent complete</p>
          <p className="text-green-400/80">✓ Architecture plan generated</p>
          <p className="text-yellow-400/80">◐ Code generation in progress…</p>
          <p className="text-forge-muted/50 mt-1">  → Writing src/handlers/auth.go</p>
          <p className="text-forge-muted/50">  → Writing src/middleware/jwt.go</p>
          <p className="text-forge-muted/30 animate-pulse">  → Writing tests…</p>
        </div>
      </div>
    </section>
  );
}

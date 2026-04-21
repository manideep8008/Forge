import { Bot, ShieldCheck, Eye, Network, LayoutTemplate, Users } from 'lucide-react';

const features = [
  {
    icon: Bot,
    title: 'AI Code Generation',
    description: 'Multi-agent pipelines generate production-ready code from plain English requirements.',
  },
  {
    icon: ShieldCheck,
    title: 'Human-in-the-Loop',
    description: 'Review and approve at critical checkpoints before the pipeline continues.',
  },
  {
    icon: Eye,
    title: 'Live Preview',
    description: 'See your application rendered in real time as agents write and refine the code.',
  },
  {
    icon: Network,
    title: 'Multi-Agent Orchestration',
    description: 'Specialized agents for requirements, architecture, code generation, and testing work in concert.',
  },
  {
    icon: LayoutTemplate,
    title: 'Templates & Workspaces',
    description: 'Start fast with battle-tested pipeline templates or build your own reusable workflows.',
  },
  {
    icon: Users,
    title: 'Team Collaboration',
    description: 'Share workspaces, comment on pipeline stages, and fork pipelines as a starting point.',
  },
];

export default function FeaturesSection() {
  return (
    <section id="features" className="py-20 px-4">
      <div className="max-w-6xl mx-auto">
        <div className="text-center mb-14">
          <h2 className="text-2xl sm:text-3xl font-bold tracking-tight text-forge-text mb-3">
            Everything you need to ship faster
          </h2>
          <p className="text-forge-muted text-sm sm:text-base max-w-lg mx-auto">
            Forge handles the heavy lifting so your team can focus on what matters.
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {features.map(({ icon: Icon, title, description }) => (
            <div key={title} className="card p-5">
              <div className="w-8 h-8 rounded-lg bg-forge-bg border border-forge-border flex items-center justify-center mb-4">
                <Icon className="w-4 h-4 text-forge-text" />
              </div>
              <h3 className="font-semibold text-sm text-forge-text mb-1.5">{title}</h3>
              <p className="text-xs text-forge-muted leading-relaxed">{description}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

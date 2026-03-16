import { useState } from 'react';
import { Routes, Route, useNavigate } from 'react-router-dom';
import { Hammer } from 'lucide-react';
import ProjectSidebar from './components/ProjectSidebar';
import PipelineView from './components/PipelineView';
import NewPipelineModal from './components/NewPipelineModal';

function WelcomeView() {
  return (
    <div className="flex-1 flex items-center justify-center">
      <div className="text-center space-y-4">
        <Hammer className="w-16 h-16 text-forge-accent mx-auto" />
        <h2 className="text-2xl font-bold text-forge-text">Welcome to Forge</h2>
        <p className="text-forge-muted max-w-md">
          Select a pipeline from the sidebar or create a new one to get started.
        </p>
      </div>
    </div>
  );
}

export default function App() {
  const [showNewPipeline, setShowNewPipeline] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const navigate = useNavigate();

  const handlePipelineCreated = (id: string) => {
    setShowNewPipeline(false);
    setRefreshKey((k) => k + 1);
    navigate(`/pipeline/${id}`);
  };

  return (
    <div className="flex h-screen overflow-hidden">
      <ProjectSidebar
        onNewPipeline={() => setShowNewPipeline(true)}
        refreshKey={refreshKey}
      />

      <main className="flex-1 flex flex-col overflow-hidden">
        <Routes>
          <Route path="/" element={<WelcomeView />} />
          <Route path="/pipeline/:id" element={<PipelineView />} />
        </Routes>
      </main>

      {showNewPipeline && (
        <NewPipelineModal
          onClose={() => setShowNewPipeline(false)}
          onCreated={handlePipelineCreated}
        />
      )}
    </div>
  );
}

import { useParams } from 'react-router-dom';
import { Routes, Route } from 'react-router-dom';
import IDELayout from './components/IDELayout';
import LoginPage from './pages/LoginPage';
import RegisterPage from './pages/RegisterPage';
import LandingPage from './pages/LandingPage';
import WorkspacesPage from './pages/WorkspacesPage';
import TemplatesPage from './pages/TemplatesPage';
import SchedulesPage from './pages/SchedulesPage';
import ProtectedRoute from './components/ProtectedRoute';

function PipelineRoute() {
  const { id } = useParams<{ id: string }>();
  return <IDELayout initialPipelineId={id} />;
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<LandingPage />} />
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />
      <Route path="/app" element={<ProtectedRoute><IDELayout /></ProtectedRoute>} />
      <Route path="/pipeline/:id" element={<ProtectedRoute><PipelineRoute /></ProtectedRoute>} />
      <Route path="/workspaces" element={<ProtectedRoute><WorkspacesPage /></ProtectedRoute>} />
      <Route path="/templates" element={<ProtectedRoute><TemplatesPage /></ProtectedRoute>} />
      <Route path="/schedules" element={<ProtectedRoute><SchedulesPage /></ProtectedRoute>} />
    </Routes>
  );
}

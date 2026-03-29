import { useParams } from 'react-router-dom';
import { Routes, Route } from 'react-router-dom';
import IDELayout from './components/IDELayout';

function PipelineRoute() {
  const { id } = useParams<{ id: string }>();
  return <IDELayout initialPipelineId={id} />;
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<IDELayout />} />
      <Route path="/pipeline/:id" element={<PipelineRoute />} />
    </Routes>
  );
}

import { Link } from 'react-router-dom';
import { Hammer } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';

export default function Navbar() {
  const { user } = useAuth();

  return (
    <nav className="sticky top-0 z-50 border-b border-forge-border bg-forge-bg/80 backdrop-blur-xl">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 h-14 flex items-center justify-between">
        <Link to="/" className="flex items-center gap-2.5">
          <div className="p-1.5 bg-forge-surface border border-forge-border rounded-lg">
            <Hammer className="w-4 h-4 text-forge-text" />
          </div>
          <span className="font-bold text-base tracking-tight text-forge-text">Forge</span>
        </Link>

        <div className="flex items-center gap-2">
          <a
            href="#features"
            className="hidden sm:block text-sm text-forge-muted hover:text-forge-text transition-colors px-3 py-1.5"
          >
            Features
          </a>
          {user ? (
            <Link
              to="/app"
              className="btn-primary text-sm px-4 py-1.5 rounded-lg font-medium"
            >
              Go to App
            </Link>
          ) : (
            <>
              <Link
                to="/login"
                className="text-sm text-forge-muted hover:text-forge-text transition-colors px-3 py-1.5"
              >
                Sign In
              </Link>
              <Link
                to="/register"
                className="btn-primary text-sm px-4 py-1.5 rounded-lg font-medium"
              >
                Get Started
              </Link>
            </>
          )}
        </div>
      </div>
    </nav>
  );
}

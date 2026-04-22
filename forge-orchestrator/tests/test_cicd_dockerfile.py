import json
import os
import sys
import types

os.environ.setdefault("INTERNAL_API_KEY", "test-internal-key")

try:
    import structlog  # noqa: F401
except ModuleNotFoundError:
    logger = types.SimpleNamespace(
        debug=lambda *args, **kwargs: None,
        info=lambda *args, **kwargs: None,
        warning=lambda *args, **kwargs: None,
        error=lambda *args, **kwargs: None,
    )
    sys.modules["structlog"] = types.SimpleNamespace(get_logger=lambda: logger)

from agents.cicd import NPM_INSTALL_COMMAND, _generate_dockerfile_node


def test_frontend_dockerfile_installs_deps_before_build(tmp_path):
    files = {
        "package.json": json.dumps(
            {
                "scripts": {"build": "vite build"},
                "dependencies": {"react": "^18.2.0", "react-dom": "^18.2.0"},
                "devDependencies": {"vite": "^5.0.0", "@vitejs/plugin-react": "^4.2.0"},
            }
        ),
        "index.html": "<div id=\"root\"></div>",
        "src/main.jsx": "import React from 'react';",
    }

    dockerfile = _generate_dockerfile_node(files, str(tmp_path), "27605")

    assert NPM_INSTALL_COMMAND in dockerfile
    assert "npm install --workspaces" not in dockerfile
    assert "RUN npm install || true" not in dockerfile
    assert "http://127.0.0.1:27605/health" in dockerfile
    assert "http://localhost:27605" not in dockerfile


def test_backend_dockerfile_does_not_silence_install_failures(tmp_path):
    files = {
        "package.json": json.dumps(
            {
                "main": "server.js",
                "dependencies": {"express": "^4.18.0"},
            }
        ),
        "server.js": "require('express')().listen(process.env.PORT)",
    }

    dockerfile = _generate_dockerfile_node(files, str(tmp_path), "9000")

    assert NPM_INSTALL_COMMAND in dockerfile
    assert "npm install --workspaces" not in dockerfile
    assert "RUN npm install || true" not in dockerfile
    assert "http://127.0.0.1:9000/health" in dockerfile
    assert "http://localhost:9000" not in dockerfile


def test_monorepo_dockerfile_installs_client_and_server_deps(tmp_path):
    (tmp_path / "client").mkdir()
    (tmp_path / "server").mkdir()
    files = {
        "client/package.json": json.dumps(
            {
                "scripts": {"build": "vite build"},
                "dependencies": {"react": "^18.2.0"},
                "devDependencies": {"vite": "^5.0.0"},
            }
        ),
        "client/src/main.jsx": "import React from 'react';",
        "server/package.json": json.dumps(
            {
                "main": "server.js",
                "dependencies": {"express": "^4.18.0"},
            }
        ),
        "server/server.js": "require('express')().listen(process.env.PORT)",
    }

    dockerfile = _generate_dockerfile_node(files, str(tmp_path), "3001")

    assert dockerfile.count(NPM_INSTALL_COMMAND) == 2
    assert "RUN npm install || true" not in dockerfile
    assert "http://127.0.0.1:3001/health" in dockerfile
    assert "http://localhost:3001" not in dockerfile

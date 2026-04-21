"""Routers package — re-exports all API routers."""
from routers.workspaces import router as workspaces
from routers.comments import router as comments
from routers.templates import router as templates

__all__ = ["workspaces", "comments", "templates"]

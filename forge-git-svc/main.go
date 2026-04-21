package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"
	"github.com/rs/zerolog"
	"github.com/rs/zerolog/log"
)

const (
	workspaceDir = "/workspace"
	redisStream  = "agent.events"
)

var rdb *redis.Client

func main() {
	zerolog.TimeFieldFormat = zerolog.TimeFormatUnix
	log.Logger = zerolog.New(zerolog.ConsoleWriter{Out: os.Stdout, TimeFormat: time.RFC3339}).
		With().Timestamp().Caller().Logger()

	redisAddr := envOrDefault("REDIS_ADDR", "redis:6379")
	rdb = redis.NewClient(&redis.Options{Addr: redisAddr})

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := rdb.Ping(ctx).Err(); err != nil {
		log.Warn().Err(err).Str("addr", redisAddr).Msg("redis not reachable at startup; events will fail until available")
	} else {
		log.Info().Str("addr", redisAddr).Msg("connected to redis")
	}

	r := chi.NewRouter()
	r.Use(middleware.RequestID)
	r.Use(middleware.RealIP)
	r.Use(middleware.Recoverer)
	r.Use(requestLogger)

	r.Get("/health", healthHandler)

	r.Route("/git", func(r chi.Router) {
		r.Post("/branch", createBranchHandler)
		r.Post("/commit", commitHandler)
		r.Post("/pr", createPRHandler)
		r.Get("/diff/{branch}", diffHandler)
		r.Post("/merge", mergeHandler)
	})

	srv := &http.Server{
		Addr:         ":8081",
		Handler:      r,
		ReadTimeout:  30 * time.Second,
		WriteTimeout: 60 * time.Second,
	}

	go func() {
		log.Info().Str("addr", srv.Addr).Msg("forge-git-svc starting")
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatal().Err(err).Msg("server failed")
		}
	}()

	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit
	log.Info().Msg("shutting down")

	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer shutdownCancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		log.Fatal().Err(err).Msg("server forced to shutdown")
	}
	log.Info().Msg("server stopped")
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

func healthHandler(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok", "service": "forge-git-svc"})
}

// POST /git/branch
type branchRequest struct {
	PipelineID string `json:"pipeline_id"`
	Slug       string `json:"slug"`
}

func createBranchHandler(w http.ResponseWriter, r *http.Request) {
	var req branchRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if req.PipelineID == "" || req.Slug == "" {
		writeError(w, http.StatusBadRequest, "pipeline_id and slug are required")
		return
	}

	branch := fmt.Sprintf("feat/%s-%s", req.PipelineID, req.Slug)
	log.Info().Str("pipeline_id", req.PipelineID).Str("branch", branch).Msg("creating branch")

	if out, err := gitExec("checkout", "-b", branch); err != nil {
		log.Error().Err(err).Str("output", out).Msg("git checkout -b failed")
		writeError(w, http.StatusInternalServerError, fmt.Sprintf("git error: %s", out))
		return
	}

	publishEvent(r.Context(), "git.branch.created", map[string]string{
		"pipeline_id": req.PipelineID,
		"branch":      branch,
	})

	writeJSON(w, http.StatusCreated, map[string]string{"branch": branch, "status": "created"})
}

// POST /git/commit
type commitRequest struct {
	PipelineID string            `json:"pipeline_id"`
	Files      map[string]string `json:"files"`
	Message    string            `json:"message"`
}

func commitHandler(w http.ResponseWriter, r *http.Request) {
	var req commitRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if req.PipelineID == "" || req.Message == "" || len(req.Files) == 0 {
		writeError(w, http.StatusBadRequest, "pipeline_id, files, and message are required")
		return
	}

	log.Info().Str("pipeline_id", req.PipelineID).Int("file_count", len(req.Files)).Msg("committing files")

	// Write files to workspace (with path traversal protection)
	realWorkspace, _ := filepath.EvalSymlinks(workspaceDir)
	for relPath, content := range req.Files {
		absPath := filepath.Join(workspaceDir, relPath)
		realPath, _ := filepath.EvalSymlinks(filepath.Dir(absPath))
		if realPath == "" {
			realPath = filepath.Clean(absPath)
		}
		if !strings.HasPrefix(filepath.Clean(absPath), realWorkspace) {
			log.Warn().Str("path", relPath).Msg("path traversal blocked")
			writeError(w, http.StatusBadRequest, "invalid file path")
			return
		}
		if err := os.MkdirAll(filepath.Dir(absPath), 0o755); err != nil {
			log.Error().Err(err).Str("path", absPath).Msg("failed to create directory")
			writeError(w, http.StatusInternalServerError, "failed to write file")
			return
		}
		if err := os.WriteFile(absPath, []byte(content), 0o644); err != nil {
			log.Error().Err(err).Str("path", absPath).Msg("failed to write file")
			writeError(w, http.StatusInternalServerError, "failed to write file")
			return
		}
	}

	// Stage all files
	if out, err := gitExec("add", "-A"); err != nil {
		log.Error().Err(err).Str("output", out).Msg("git add failed")
		writeError(w, http.StatusInternalServerError, fmt.Sprintf("git add error: %s", out))
		return
	}

	// Commit
	if out, err := gitExec("commit", "-m", req.Message); err != nil {
		log.Error().Err(err).Str("output", out).Msg("git commit failed")
		writeError(w, http.StatusInternalServerError, fmt.Sprintf("git commit error: %s", out))
		return
	}

	// Push — failure is non-fatal (no remote configured in dev) but we surface it clearly
	if out, err := gitExec("push", "--set-upstream", "origin", "HEAD"); err != nil {
		log.Error().Err(err).Str("output", out).Msg("git push failed — no remote configured; code only exists in the local workspace volume")
	}

	publishEvent(r.Context(), "git.commit.created", map[string]string{
		"pipeline_id": req.PipelineID,
		"message":     req.Message,
	})

	writeJSON(w, http.StatusCreated, map[string]string{"status": "committed", "message": req.Message})
}

// POST /git/pr
type prRequest struct {
	PipelineID  string `json:"pipeline_id"`
	Title       string `json:"title"`
	Description string `json:"description"`
	Branch      string `json:"branch"`
}

func createPRHandler(w http.ResponseWriter, r *http.Request) {
	var req prRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if req.PipelineID == "" || req.Title == "" || req.Branch == "" {
		writeError(w, http.StatusBadRequest, "pipeline_id, title, and branch are required")
		return
	}

	prID := uuid.New().String()[:8]
	prURL := fmt.Sprintf("https://forge.local/pr/%s", prID)

	log.Info().
		Str("pipeline_id", req.PipelineID).
		Str("title", req.Title).
		Str("branch", req.Branch).
		Str("pr_url", prURL).
		Msg("pull request created (stub)")

	publishEvent(r.Context(), "git.pr.created", map[string]string{
		"pipeline_id": req.PipelineID,
		"title":       req.Title,
		"branch":      req.Branch,
		"pr_url":      prURL,
	})

	writeJSON(w, http.StatusCreated, map[string]string{
		"status": "created",
		"pr_id":  prID,
		"pr_url": prURL,
	})
}

// GET /git/diff/{branch}
func diffHandler(w http.ResponseWriter, r *http.Request) {
	branch := chi.URLParam(r, "branch")
	if branch == "" {
		writeError(w, http.StatusBadRequest, "branch is required")
		return
	}

	log.Info().Str("branch", branch).Msg("generating diff")

	diffRef := fmt.Sprintf("main..%s", branch)
	out, err := gitExec("diff", diffRef)
	if err != nil {
		log.Error().Err(err).Str("output", out).Msg("git diff failed")
		writeError(w, http.StatusInternalServerError, fmt.Sprintf("git diff error: %s", out))
		return
	}

	publishEvent(r.Context(), "git.diff.requested", map[string]string{
		"branch": branch,
	})

	writeJSON(w, http.StatusOK, map[string]string{"branch": branch, "diff": out})
}

// POST /git/merge
type mergeRequest struct {
	PipelineID string `json:"pipeline_id"`
	Branch     string `json:"branch"`
}

func mergeHandler(w http.ResponseWriter, r *http.Request) {
	var req mergeRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if req.PipelineID == "" || req.Branch == "" {
		writeError(w, http.StatusBadRequest, "pipeline_id and branch are required")
		return
	}

	log.Info().
		Str("pipeline_id", req.PipelineID).
		Str("branch", req.Branch).
		Msg("merge completed (stub)")

	publishEvent(r.Context(), "git.merge.completed", map[string]string{
		"pipeline_id": req.PipelineID,
		"branch":      req.Branch,
	})

	writeJSON(w, http.StatusOK, map[string]string{"status": "merged", "branch": req.Branch})
}

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

func gitExec(args ...string) (string, error) {
	cmd := exec.Command("git", args...)
	cmd.Dir = workspaceDir
	out, err := cmd.CombinedOutput()
	return strings.TrimSpace(string(out)), err
}

// ---------------------------------------------------------------------------
// Redis event publishing
// ---------------------------------------------------------------------------

func publishEvent(ctx context.Context, eventType string, data map[string]string) {
	fields := map[string]interface{}{
		"event_type": eventType,
		"timestamp":  time.Now().UTC().Format(time.RFC3339),
		"event_id":   uuid.New().String(),
	}
	for k, v := range data {
		fields[k] = v
	}

	if err := rdb.XAdd(ctx, &redis.XAddArgs{
		Stream: redisStream,
		Values: fields,
	}).Err(); err != nil {
		log.Error().Err(err).Str("event_type", eventType).Msg("failed to publish event to redis")
		return
	}
	log.Debug().Str("event_type", eventType).Msg("event published")
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

func writeJSON(w http.ResponseWriter, status int, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(v); err != nil {
		log.Error().Err(err).Msg("failed to encode response")
	}
}

func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]string{"error": message})
}

func requestLogger(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		ww := middleware.NewWrapResponseWriter(w, r.ProtoMajor)
		next.ServeHTTP(ww, r)
		log.Info().
			Str("method", r.Method).
			Str("path", r.URL.Path).
			Int("status", ww.Status()).
			Dur("latency", time.Since(start)).
			Msg("request")
	})
}

func envOrDefault(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

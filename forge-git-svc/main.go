package main

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"regexp"
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
	workspaceDir          = "/workspace"
	redisStream           = "agent.events"
	internalAPIKeyHeader  = "X-Internal-API-Key"
	contentSecurityPolicy = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
)

var rdb *redis.Client
var safeGitRefParamPattern = regexp.MustCompile(`^[a-zA-Z0-9._/-]{1,100}$`)

func main() {
	zerolog.TimeFieldFormat = zerolog.TimeFormatUnix
	log.Logger = zerolog.New(zerolog.ConsoleWriter{Out: os.Stdout, TimeFormat: time.RFC3339}).
		With().Timestamp().Caller().Logger()

	internalAPIKey := os.Getenv("INTERNAL_API_KEY")
	if internalAPIKey == "" {
		log.Fatal().Msg("INTERNAL_API_KEY environment variable is not set — refusing to start")
	}

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
	r.Use(securityHeaders)
	r.Use(requireInternalAPIKey(internalAPIKey))
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
	if !isSafeGitRefParam(req.PipelineID) {
		writeError(w, http.StatusBadRequest, "invalid pipeline_id")
		return
	}
	if !isSafeGitRefParam(req.Slug) {
		writeError(w, http.StatusBadRequest, "invalid slug")
		return
	}

	branch := fmt.Sprintf("feat/%s-%s", req.PipelineID, req.Slug)
	log.Info().Str("pipeline_id", req.PipelineID).Str("branch", branch).Msg("creating branch")

	if out, err := gitExec("checkout", "-b", branch, "--"); err != nil {
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
	realWorkspace, err := filepath.EvalSymlinks(workspaceDir)
	if err != nil {
		log.Error().Err(err).Str("path", workspaceDir).Msg("failed to resolve workspace")
		writeError(w, http.StatusInternalServerError, "workspace unavailable")
		return
	}
	realWorkspace = filepath.Clean(realWorkspace)
	pathSeparator := string(os.PathSeparator)
	workspacePrefix := realWorkspace + pathSeparator

	for relPath, content := range req.Files {
		cleanAbs, err := filepath.Abs(filepath.Join(realWorkspace, relPath))
		if err != nil {
			log.Warn().Err(err).Str("path", relPath).Msg("invalid file path")
			writeError(w, http.StatusBadRequest, "invalid file path")
			return
		}
		cleanAbs = filepath.Clean(cleanAbs)
		if !strings.HasPrefix(cleanAbs+pathSeparator, workspacePrefix) {
			log.Warn().Str("path", relPath).Msg("path traversal blocked")
			writeError(w, http.StatusBadRequest, "invalid file path")
			return
		}

		existingParent := filepath.Dir(cleanAbs)
		for {
			if _, err := os.Lstat(existingParent); err == nil {
				break
			} else if os.IsNotExist(err) {
				parent := filepath.Dir(existingParent)
				if parent == existingParent {
					log.Warn().Str("path", relPath).Msg("path traversal blocked")
					writeError(w, http.StatusBadRequest, "invalid file path")
					return
				}
				existingParent = parent
			} else {
				log.Error().Err(err).Str("path", existingParent).Msg("failed to inspect path")
				writeError(w, http.StatusInternalServerError, "failed to write file")
				return
			}
		}

		realParent, err := filepath.EvalSymlinks(existingParent)
		if err != nil {
			log.Error().Err(err).Str("path", existingParent).Msg("failed to resolve path")
			writeError(w, http.StatusInternalServerError, "failed to write file")
			return
		}
		realParent = filepath.Clean(realParent)
		if !strings.HasPrefix(realParent+pathSeparator, workspacePrefix) {
			log.Warn().Str("path", relPath).Msg("path traversal blocked")
			writeError(w, http.StatusBadRequest, "invalid file path")
			return
		}

		if err := os.MkdirAll(filepath.Dir(cleanAbs), 0o755); err != nil {
			log.Error().Err(err).Str("path", cleanAbs).Msg("failed to create directory")
			writeError(w, http.StatusInternalServerError, "failed to write file")
			return
		}
		if err := os.WriteFile(cleanAbs, []byte(content), 0o644); err != nil {
			log.Error().Err(err).Str("path", cleanAbs).Msg("failed to write file")
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
	if !isSafeGitRefParam(branch) {
		writeError(w, http.StatusBadRequest, "invalid branch")
		return
	}

	log.Info().Str("branch", branch).Msg("generating diff")

	diffRef := fmt.Sprintf("main..%s", branch)
	out, err := gitExec("diff", diffRef, "--")
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

func isSafeGitRefParam(value string) bool {
	return safeGitRefParamPattern.MatchString(value) && !strings.HasPrefix(value, "-")
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

func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Content-Security-Policy", contentSecurityPolicy)
		w.Header().Set("Referrer-Policy", "no-referrer")
		next.ServeHTTP(w, r)
	})
}

func requireInternalAPIKey(expected string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			provided := r.Header.Get(internalAPIKeyHeader)
			if subtle.ConstantTimeCompare([]byte(provided), []byte(expected)) != 1 {
				writeError(w, http.StatusUnauthorized, "internal service authentication required")
				return
			}
			next.ServeHTTP(w, r)
		})
	}
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

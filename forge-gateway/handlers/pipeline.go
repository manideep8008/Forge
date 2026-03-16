package handlers

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/rs/zerolog/log"
)

var orchestratorURL = envOrDefault("ORCHESTRATOR_URL", "http://orchestrator:8081")

// ---------- request / response types ----------

// CreatePipelineRequest is the payload for POST /api/pipeline.
type CreatePipelineRequest struct {
	RepoURL     string `json:"repo_url"`
	Branch      string `json:"branch"`
	Prompt      string `json:"prompt"`
	Description string `json:"description"`
	CallbackURL string `json:"callback_url,omitempty"`
}

// PipelineResponse is a generic envelope returned to callers.
type PipelineResponse struct {
	ID        string `json:"id,omitempty"`
	Status    string `json:"status,omitempty"`
	Message   string `json:"message,omitempty"`
	Diff      string `json:"diff,omitempty"`
	CreatedAt string `json:"created_at,omitempty"`
}

// ---------- handlers ----------

// CreatePipeline forwards the request body to the orchestrator service.
// POST /api/pipeline
func CreatePipeline(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(r.Body)
	if err != nil {
		jsonError(w, "failed to read request body", http.StatusBadRequest)
		return
	}
	defer r.Body.Close()

	// Validate JSON.
	var req CreatePipelineRequest
	if err := json.Unmarshal(body, &req); err != nil {
		jsonError(w, "invalid JSON payload", http.StatusBadRequest)
		return
	}
	// Allow "description" as an alias for "prompt" (frontend sends description).
	if req.Prompt == "" && req.Description != "" {
		req.Prompt = req.Description
	}
	if req.Prompt == "" {
		jsonError(w, "prompt or description is required", http.StatusBadRequest)
		return
	}

	// Re-marshal with normalized fields for the orchestrator.
	normalized, _ := json.Marshal(map[string]string{
		"input_text": req.Prompt,
	})

	// Forward to orchestrator.
	url := fmt.Sprintf("%s/pipeline", orchestratorURL)
	resp, err := proxyPost(url, normalized, r)
	if err != nil {
		log.Error().Err(err).Str("url", url).Msg("orchestrator unreachable")
		jsonError(w, "orchestrator unavailable", http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	relayResponse(w, resp)
}

// GetPipelineStatus returns the current status of a pipeline.
// GET /api/pipeline/{id}/status
func GetPipelineStatus(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	url := fmt.Sprintf("%s/pipeline/%s/status", orchestratorURL, id)

	resp, err := proxyGet(url, r)
	if err != nil {
		log.Error().Err(err).Msg("orchestrator unreachable")
		jsonError(w, "orchestrator unavailable", http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	relayResponse(w, resp)
}

// GetPipelineDiff returns the generated diff for a pipeline.
// GET /api/pipeline/{id}/diff
func GetPipelineDiff(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	url := fmt.Sprintf("%s/pipeline/%s/diff", orchestratorURL, id)

	resp, err := proxyGet(url, r)
	if err != nil {
		log.Error().Err(err).Msg("orchestrator unreachable")
		jsonError(w, "orchestrator unavailable", http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	relayResponse(w, resp)
}

// ApprovePipeline sends a human-in-the-loop approval for a pipeline.
// POST /api/pipeline/{id}/approve
func ApprovePipeline(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")

	body, err := io.ReadAll(r.Body)
	if err != nil {
		jsonError(w, "failed to read request body", http.StatusBadRequest)
		return
	}
	defer r.Body.Close()

	url := fmt.Sprintf("%s/pipeline/%s/approve", orchestratorURL, id)
	resp, err := proxyPost(url, body, r)
	if err != nil {
		log.Error().Err(err).Msg("orchestrator unreachable")
		jsonError(w, "orchestrator unavailable", http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	relayResponse(w, resp)
}

// ListPipelines returns all pipelines (with optional query params for filtering).
// GET /api/pipelines
func ListPipelines(w http.ResponseWriter, r *http.Request) {
	url := fmt.Sprintf("%s/pipelines?%s", orchestratorURL, r.URL.RawQuery)

	resp, err := proxyGet(url, r)
	if err != nil {
		log.Error().Err(err).Msg("orchestrator unreachable")
		jsonError(w, "orchestrator unavailable", http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	relayResponse(w, resp)
}

// ---------- helpers ----------

var httpClient = &http.Client{Timeout: 30 * time.Second}

func proxyPost(url string, body []byte, orig *http.Request) (*http.Response, error) {
	req, err := http.NewRequestWithContext(orig.Context(), http.MethodPost, url, io.NopCloser(
		jsonReader(body),
	))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	propagateHeaders(orig, req)
	return httpClient.Do(req)
}

func proxyGet(url string, orig *http.Request) (*http.Response, error) {
	req, err := http.NewRequestWithContext(orig.Context(), http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	propagateHeaders(orig, req)
	return httpClient.Do(req)
}

func propagateHeaders(from, to *http.Request) {
	if v := from.Header.Get("X-Correlation-ID"); v != "" {
		to.Header.Set("X-Correlation-ID", v)
	}
	if v := from.Header.Get("X-Request-ID"); v != "" {
		to.Header.Set("X-Request-ID", v)
	}
	if v := from.Header.Get("Authorization"); v != "" {
		to.Header.Set("Authorization", v)
	}
}

func relayResponse(w http.ResponseWriter, resp *http.Response) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(resp.StatusCode)
	io.Copy(w, resp.Body)
}

func jsonError(w http.ResponseWriter, msg string, code int) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(map[string]string{"error": msg})
}

func jsonReader(data []byte) io.Reader {
	return io.NopCloser(bytesReader(data))
}

type bytesReaderWrapper struct{ data []byte; pos int }

func bytesReader(data []byte) *bytesReaderWrapper { return &bytesReaderWrapper{data: data} }
func (br *bytesReaderWrapper) Read(p []byte) (int, error) {
	if br.pos >= len(br.data) {
		return 0, io.EOF
	}
	n := copy(p, br.data[br.pos:])
	br.pos += n
	return n, nil
}

func envOrDefault(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

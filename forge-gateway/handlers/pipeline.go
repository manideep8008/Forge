package handlers

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"time"

	"forge-gateway/middleware"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/rs/zerolog/log"
)

// validatePipelineID checks that id is a valid UUID and writes a 400 if not.
// Returns false when the handler should stop.
func validatePipelineID(w http.ResponseWriter, id string) bool {
	if _, err := uuid.Parse(id); err != nil {
		jsonError(w, "invalid pipeline id", http.StatusBadRequest)
		return false
	}
	return true
}

var orchestratorURL = envOrDefault("ORCHESTRATOR_URL", "http://forge-orchestrator:8090")

const (
	maxCreatePipelineBodyBytes = 1 << 20
	maxPipelineActionBodyBytes = 1 << 20
	maxProxyBodyBytes          = 1 << 20
	maxRelayResponseBodyBytes  = 32 << 20
)

// ---------- request / response types ----------

// CreatePipelineRequest is the payload for POST /api/pipeline.
type CreatePipelineRequest struct {
	RepoURL     string `json:"repo_url"`
	Branch      string `json:"branch"`
	Prompt      string `json:"prompt"`
	Description string `json:"description"`
	InputText   string `json:"input_text"`
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
	r.Body = http.MaxBytesReader(w, r.Body, maxCreatePipelineBodyBytes)
	body, err := io.ReadAll(r.Body)
	if err != nil {
		var maxBytesErr *http.MaxBytesError
		if errors.As(err, &maxBytesErr) {
			jsonError(w, "request body too large", http.StatusRequestEntityTooLarge)
			return
		}
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
	// Allow "description" or "input_text" as aliases for "prompt".
	if req.Prompt == "" && req.Description != "" {
		req.Prompt = req.Description
	}
	if req.Prompt == "" && req.InputText != "" {
		req.Prompt = req.InputText
	}
	if req.Prompt == "" {
		jsonError(w, "prompt, description, or input_text is required", http.StatusBadRequest)
		return
	}

	// Re-marshal with normalized fields for the orchestrator.
	// Omit user_id from the body since the orchestrator's Pydantic model forbids extra fields
	// and extracts the user ID from the X-User-ID header instead.
	payload := map[string]string{
		"input_text": req.Prompt,
	}
	if req.RepoURL != "" {
		payload["repo_url"] = req.RepoURL
	}
	normalized, _ := json.Marshal(payload)

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
	if !validatePipelineID(w, id) {
		return
	}
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
	if !validatePipelineID(w, id) {
		return
	}
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
	if !validatePipelineID(w, id) {
		return
	}

	body, ok := readLimitedRequestBody(w, r, maxPipelineActionBodyBytes)
	if !ok {
		return
	}

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

// ListPipelines returns pipelines for the authenticated user.
// GET /api/pipelines
func ListPipelines(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r)
	q := r.URL.Query()
	if userID != "anonymous" {
		q.Set("user_id", userID)
	}
	targetURL := fmt.Sprintf("%s/pipelines?%s", orchestratorURL, url.Values(q).Encode())

	resp, err := proxyGet(targetURL, r)
	if err != nil {
		log.Error().Err(err).Msg("orchestrator unreachable")
		jsonError(w, "orchestrator unavailable", http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	relayResponse(w, resp)
}

// DeletePipeline cancels and removes a pipeline.
// DELETE /api/pipeline/{id}
func DeletePipeline(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if !validatePipelineID(w, id) {
		return
	}
	url := fmt.Sprintf("%s/pipeline/%s", orchestratorURL, id)

	resp, err := proxyDelete(url, r)
	if err != nil {
		log.Error().Err(err).Msg("orchestrator unreachable")
		jsonError(w, "orchestrator unavailable", http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	relayResponse(w, resp)
}

// CancelPipeline cancels a running pipeline.
// POST /api/pipeline/{id}/cancel
func CancelPipeline(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if !validatePipelineID(w, id) {
		return
	}
	url := fmt.Sprintf("%s/pipeline/%s/cancel", orchestratorURL, id)

	resp, err := proxyPost(url, nil, r)
	if err != nil {
		log.Error().Err(err).Msg("orchestrator unreachable")
		jsonError(w, "orchestrator unavailable", http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	relayResponse(w, resp)
}

// RetryPipeline restarts a failed pipeline.
// POST /api/pipeline/{id}/retry
func RetryPipeline(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if !validatePipelineID(w, id) {
		return
	}
	url := fmt.Sprintf("%s/pipeline/%s/retry", orchestratorURL, id)

	resp, err := proxyPost(url, nil, r)
	if err != nil {
		log.Error().Err(err).Msg("orchestrator unreachable")
		jsonError(w, "orchestrator unavailable", http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	relayResponse(w, resp)
}

// ModifyPipeline starts a new iteration pipeline that modifies an existing app.
// POST /api/pipeline/{id}/modify
func ModifyPipeline(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if !validatePipelineID(w, id) {
		return
	}

	body, ok := readLimitedRequestBody(w, r, maxPipelineActionBodyBytes)
	if !ok {
		return
	}

	url := fmt.Sprintf("%s/pipeline/%s/modify", orchestratorURL, id)
	resp, err := proxyPost(url, body, r)
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

func proxyDelete(url string, orig *http.Request) (*http.Response, error) {
	req, err := http.NewRequestWithContext(orig.Context(), http.MethodDelete, url, nil)
	if err != nil {
		return nil, err
	}
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
	// Forward the authenticated user ID so the orchestrator can enforce ownership.
	if uid := middleware.GetUserID(from); uid != "anonymous" {
		to.Header.Set("X-User-ID", uid)
	}
	addInternalAuth(to)
}

func relayResponse(w http.ResponseWriter, resp *http.Response) {
	if resp.ContentLength > maxRelayResponseBodyBytes {
		jsonError(w, "orchestrator response too large", http.StatusBadGateway)
		return
	}

	body, err := io.ReadAll(io.LimitReader(resp.Body, maxRelayResponseBodyBytes+1))
	if err != nil {
		log.Error().Err(err).Int("status_code", resp.StatusCode).Msg("failed to read orchestrator response")
		jsonError(w, "failed to read orchestrator response", http.StatusBadGateway)
		return
	}
	if int64(len(body)) > maxRelayResponseBodyBytes {
		jsonError(w, "orchestrator response too large", http.StatusBadGateway)
		return
	}

	contentType := resp.Header.Get("Content-Type")
	if contentType == "" {
		contentType = "application/json"
	}
	w.Header().Set("Content-Type", contentType)
	w.WriteHeader(resp.StatusCode)
	if _, err := w.Write(body); err != nil {
		log.Error().Err(err).Int("status_code", resp.StatusCode).Msg("failed to relay orchestrator response")
	}
}

func readLimitedRequestBody(w http.ResponseWriter, r *http.Request, maxBytes int64) ([]byte, bool) {
	r.Body = http.MaxBytesReader(w, r.Body, maxBytes)
	body, err := io.ReadAll(r.Body)
	defer r.Body.Close()
	if err != nil {
		var maxBytesErr *http.MaxBytesError
		if errors.As(err, &maxBytesErr) {
			jsonError(w, "request body too large", http.StatusRequestEntityTooLarge)
			return nil, false
		}
		jsonError(w, "failed to read request body", http.StatusBadRequest)
		return nil, false
	}
	return body, true
}

func jsonError(w http.ResponseWriter, msg string, code int) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(map[string]string{"error": msg})
}

func jsonReader(data []byte) io.Reader {
	return bytes.NewReader(data)
}

func envOrDefault(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

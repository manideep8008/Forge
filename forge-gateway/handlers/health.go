package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
	"github.com/rs/zerolog/log"
)

// ServiceHealth represents the health of one downstream dependency.
type ServiceHealth struct {
	Name    string `json:"name"`
	Status  string `json:"status"` // "healthy" | "unhealthy"
	Latency string `json:"latency,omitempty"`
	Error   string `json:"error,omitempty"`
}

// HealthResponse is the aggregated health check response.
type HealthResponse struct {
	Status   string          `json:"status"` // "healthy" | "degraded" | "unhealthy"
	Services []ServiceHealth `json:"services"`
}

// Health returns a handler that aggregates the health of downstream services
// (Redis, orchestrator, git-svc, docker-svc).
func Health(rdb *redis.Client) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
		defer cancel()

		services := []struct {
			name string
			fn   func(context.Context) error
		}{
			{"redis", func(c context.Context) error { return rdb.Ping(c).Err() }},
			{"orchestrator", httpHealthCheck(envOrDefault("ORCHESTRATOR_URL", "http://orchestrator:8081"))},
			{"git-svc", httpHealthCheck(envOrDefault("GIT_SVC_URL", "http://git-svc:8082"))},
			{"docker-svc", httpHealthCheck(envOrDefault("DOCKER_SVC_URL", "http://docker-svc:8083"))},
		}

		results := make([]ServiceHealth, len(services))
		var wg sync.WaitGroup

		for i, svc := range services {
			wg.Add(1)
			go func(idx int, name string, check func(context.Context) error) {
				defer wg.Done()
				start := time.Now()
				err := check(ctx)
				latency := time.Since(start)

				sh := ServiceHealth{
					Name:    name,
					Status:  "healthy",
					Latency: latency.String(),
				}
				if err != nil {
					sh.Status = "unhealthy"
					sh.Error = err.Error()
					log.Warn().Str("service", name).Err(err).Msg("health check failed")
				}
				results[idx] = sh
			}(i, svc.name, svc.fn)
		}
		wg.Wait()

		// Aggregate status.
		overall := "healthy"
		unhealthyCount := 0
		for _, s := range results {
			if s.Status == "unhealthy" {
				unhealthyCount++
			}
		}
		if unhealthyCount > 0 && unhealthyCount < len(results) {
			overall = "degraded"
		} else if unhealthyCount == len(results) {
			overall = "unhealthy"
		}

		resp := HealthResponse{Status: overall, Services: results}

		w.Header().Set("Content-Type", "application/json")
		if overall == "unhealthy" {
			w.WriteHeader(http.StatusServiceUnavailable)
		} else {
			w.WriteHeader(http.StatusOK)
		}
		json.NewEncoder(w).Encode(resp)
	}
}

func httpHealthCheck(baseURL string) func(context.Context) error {
	return func(ctx context.Context) error {
		url := fmt.Sprintf("%s/health", baseURL)
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
		if err != nil {
			return err
		}
		addInternalAuth(req)
		client := &http.Client{Timeout: 3 * time.Second}
		resp, err := client.Do(req)
		if err != nil {
			return err
		}
		defer resp.Body.Close()
		if resp.StatusCode >= 400 {
			return fmt.Errorf("status %d", resp.StatusCode)
		}
		return nil
	}
}

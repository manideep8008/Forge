package main

import (
	"archive/tar"
	"bufio"
	"bytes"
	"context"
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"
	"time"

	"github.com/docker/docker/api/types"
	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/image"
	"github.com/docker/docker/client"
	"github.com/docker/docker/pkg/stdcopy"
	"github.com/docker/go-connections/nat"
	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"
	"github.com/rs/zerolog"
)

// ---------------------------------------------------------------------------
// Request / Response types
// ---------------------------------------------------------------------------

type BuildRequest struct {
	PipelineID  string `json:"pipeline_id"`
	Tag         string `json:"tag"`
	ContextPath string `json:"context_path"`
}

type BuildResponse struct {
	Image   string `json:"image"`
	BuildID string `json:"build_id"`
}

type DeployRequest struct {
	PipelineID string `json:"pipeline_id"`
	Image      string `json:"image"`
	Port       string `json:"port"`
}

type DeployResponse struct {
	URL         string `json:"url"`
	ContainerID string `json:"container_id"`
}

type RollbackRequest struct {
	PipelineID    string `json:"pipeline_id"`
	PreviousImage string `json:"previous_image"`
	Port          string `json:"port"`
}

type RollbackResponse struct {
	URL         string `json:"url"`
	ContainerID string `json:"container_id"`
	Message     string `json:"message"`
}

type HealthResponse struct {
	Healthy        bool    `json:"healthy"`
	ErrorRate      float64 `json:"error_rate"`
	ResponseTimeMs int64   `json:"response_time_ms"`
	CPUPercent     float64 `json:"cpu_percent"`
	MemoryMB       float64 `json:"memory_mb"`
}

type CleanupResponse struct {
	Removed int    `json:"removed"`
	Message string `json:"message"`
}

const (
	internalAPIKeyHeader  = "X-Internal-API-Key"
	workspaceContextRoot  = "/workspace"
	contentSecurityPolicy = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
)

var dockerTagPattern = regexp.MustCompile(`^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$`)

func previewHealthcheckCommand(port string) string {
	return fmt.Sprintf("wget -qO- http://127.0.0.1:%s/health || wget -qO- http://127.0.0.1:%s/ || exit 1", port, port)
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

type Server struct {
	docker *client.Client
	redis  *redis.Client
	log    zerolog.Logger
}

func NewServer() (*Server, error) {
	dockerClient, err := client.NewClientWithOpts(client.FromEnv, client.WithAPIVersionNegotiation())
	if err != nil {
		return nil, fmt.Errorf("docker client: %w", err)
	}

	// Prefer REDIS_ADDR (host:port) over REDIS_URL (redis://host:port).
	redisAddr := os.Getenv("REDIS_ADDR")
	if redisAddr == "" {
		redisAddr = os.Getenv("REDIS_URL")
	}
	if redisAddr == "" {
		redisAddr = "localhost:6379"
	}
	// Strip redis:// prefix if present so go-redis gets a plain host:port.
	redisAddr = strings.TrimPrefix(redisAddr, "redis://")

	rdb := redis.NewClient(&redis.Options{Addr: redisAddr})

	logger := zerolog.New(zerolog.ConsoleWriter{Out: os.Stdout, TimeFormat: time.RFC3339}).
		With().
		Timestamp().
		Str("service", "forge-docker-svc").
		Logger()

	return &Server{docker: dockerClient, redis: rdb, log: logger}, nil
}

// publishEvent sends a structured event to the Redis agent.events stream.
func (s *Server) publishEvent(ctx context.Context, eventType, pipelineID string, payload map[string]interface{}) {
	data, _ := json.Marshal(payload)
	err := s.redis.XAdd(ctx, &redis.XAddArgs{
		Stream: "agent.events",
		Values: map[string]interface{}{
			"type":        eventType,
			"pipeline_id": pipelineID,
			"payload":     string(data),
			"timestamp":   time.Now().UTC().Format(time.RFC3339),
		},
	}).Err()
	if err != nil {
		s.log.Warn().Err(err).Str("event", eventType).Msg("failed to publish event to Redis")
	}
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "ok", "service": "forge-docker-svc"})
}

// POST /docker/build
func (s *Server) handleBuild(w http.ResponseWriter, r *http.Request) {
	var req BuildRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		s.writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	if req.PipelineID == "" || req.ContextPath == "" {
		s.writeError(w, http.StatusBadRequest, "pipeline_id and context_path are required")
		return
	}

	pipelineID, err := normalizePipelineID(req.PipelineID)
	if err != nil {
		s.writeError(w, http.StatusBadRequest, "pipeline_id must be a valid UUID")
		return
	}
	req.PipelineID = pipelineID

	imageTag := fmt.Sprintf("forge-%s:latest", req.PipelineID)
	if req.Tag != "" {
		if err := validateForgeImageTag(req.PipelineID, req.Tag); err != nil {
			s.writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		imageTag = req.Tag
	}

	contextPath, err := cleanWorkspaceContextPath(req.ContextPath)
	if err != nil {
		s.writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	req.ContextPath = contextPath

	buildID := uuid.New().String()
	s.log.Info().
		Str("pipeline_id", req.PipelineID).
		Str("image", imageTag).
		Str("build_id", buildID).
		Str("context_path", req.ContextPath).
		Msg("starting Docker build")

	ctx := r.Context()

	// Create a tar archive of the build context directory.
	tarBuf, err := createTar(req.ContextPath)
	if err != nil {
		s.log.Error().Err(err).Msg("failed to create build context tar")
		s.writeError(w, http.StatusInternalServerError, "failed to read build context: "+err.Error())
		return
	}

	resp, err := s.docker.ImageBuild(ctx, tarBuf, types.ImageBuildOptions{
		Tags:       []string{imageTag},
		Dockerfile: "Dockerfile",
		Remove:     true,
	})
	if err != nil {
		s.log.Error().Err(err).Msg("Docker build failed")
		s.writeError(w, http.StatusInternalServerError, "docker build failed: "+err.Error())
		return
	}
	defer resp.Body.Close()

	// Read build output and check for errors in the stream.
	var lastErr string
	decoder := json.NewDecoder(resp.Body)
	for {
		var msg struct {
			Stream string `json:"stream"`
			Error  string `json:"error"`
		}
		if err := decoder.Decode(&msg); err != nil {
			break
		}
		if msg.Error != "" {
			lastErr = msg.Error
		}
	}

	if lastErr != "" {
		s.log.Error().Str("build_id", buildID).Str("error", lastErr).Msg("Docker build failed")
		s.writeError(w, http.StatusInternalServerError, "docker build failed: "+lastErr)
		return
	}

	s.publishEvent(ctx, "docker.build.completed", req.PipelineID, map[string]interface{}{
		"image":    imageTag,
		"build_id": buildID,
	})

	s.log.Info().Str("image", imageTag).Str("build_id", buildID).Msg("build completed")
	s.writeJSON(w, http.StatusOK, BuildResponse{Image: imageTag, BuildID: buildID})
}

// POST /docker/deploy
func (s *Server) handleDeploy(w http.ResponseWriter, r *http.Request) {
	var req DeployRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		s.writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	if req.PipelineID == "" || req.Image == "" || req.Port == "" {
		s.writeError(w, http.StatusBadRequest, "pipeline_id, image, and port are required")
		return
	}

	pipelineID, err := normalizePipelineID(req.PipelineID)
	if err != nil {
		s.writeError(w, http.StatusBadRequest, "pipeline_id must be a valid UUID")
		return
	}
	req.PipelineID = pipelineID

	if err := validateForgeImageTag(req.PipelineID, req.Image); err != nil {
		s.writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	ctx := r.Context()
	containerName := fmt.Sprintf("forge-%s", req.PipelineID)

	s.log.Info().
		Str("pipeline_id", req.PipelineID).
		Str("image", req.Image).
		Str("port", req.Port).
		Msg("deploying container")

	// Stop and remove existing container with the same name (best-effort).
	s.stopAndRemoveContainer(ctx, containerName)

	hostPort := req.Port
	containerPort := nat.Port(req.Port + "/tcp")

	containerCfg := &container.Config{
		Image: req.Image,
		ExposedPorts: nat.PortSet{
			containerPort: struct{}{},
		},
		Env: []string{
			fmt.Sprintf("PORT=%s", req.Port),
		},
		Labels: map[string]string{
			"forge.pipeline_id": req.PipelineID,
			"forge.managed":     "true",
		},
		Healthcheck: &container.HealthConfig{
			Test:     []string{"CMD-SHELL", previewHealthcheckCommand(req.Port)},
			Interval: 10 * time.Second,
			Timeout:  5 * time.Second,
			Retries:  3,
		},
	}

	hostCfg := &container.HostConfig{
		PortBindings: nat.PortMap{
			containerPort: []nat.PortBinding{
				{HostIP: "0.0.0.0", HostPort: hostPort},
			},
		},
		Resources: container.Resources{
			Memory:   512 * 1024 * 1024, // 512 MB
			NanoCPUs: 1_000_000_000,     // 1.0 CPU
		},
		RestartPolicy: container.RestartPolicy{Name: "unless-stopped"},
	}

	created, err := s.docker.ContainerCreate(ctx, containerCfg, hostCfg, nil, nil, containerName)
	if err != nil {
		s.log.Error().Err(err).Msg("container create failed")
		s.writeError(w, http.StatusInternalServerError, "container create failed: "+err.Error())
		return
	}

	if err := s.docker.ContainerStart(ctx, created.ID, container.StartOptions{}); err != nil {
		s.log.Error().Err(err).Msg("container start failed")
		s.writeError(w, http.StatusInternalServerError, "container start failed: "+err.Error())
		return
	}

	url := fmt.Sprintf("http://localhost:%s", hostPort)

	s.publishEvent(ctx, "docker.deploy.completed", req.PipelineID, map[string]interface{}{
		"container_id": created.ID,
		"image":        req.Image,
		"url":          url,
	})

	s.log.Info().Str("container_id", created.ID).Str("url", url).Msg("container deployed")
	s.writeJSON(w, http.StatusOK, DeployResponse{URL: url, ContainerID: created.ID})
}

// POST /docker/rollback
func (s *Server) handleRollback(w http.ResponseWriter, r *http.Request) {
	var req RollbackRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		s.writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	if req.PipelineID == "" || req.PreviousImage == "" {
		s.writeError(w, http.StatusBadRequest, "pipeline_id and previous_image are required")
		return
	}

	pipelineID, err := normalizePipelineID(req.PipelineID)
	if err != nil {
		s.writeError(w, http.StatusBadRequest, "pipeline_id must be a valid UUID")
		return
	}
	req.PipelineID = pipelineID

	if err := validateForgeImageTag(req.PipelineID, req.PreviousImage); err != nil {
		s.writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	ctx := r.Context()
	containerName := fmt.Sprintf("forge-%s", req.PipelineID)

	s.log.Info().
		Str("pipeline_id", req.PipelineID).
		Str("previous_image", req.PreviousImage).
		Msg("rolling back container")

	// Stop current container.
	s.stopAndRemoveContainer(ctx, containerName)

	// Use the port from the request, or fall back to a hash-based port
	port := req.Port
	if port == "" {
		port = "8080"
	}
	containerPort := nat.Port(port + "/tcp")

	containerCfg := &container.Config{
		Image: req.PreviousImage,
		ExposedPorts: nat.PortSet{
			containerPort: struct{}{},
		},
		Env: []string{
			fmt.Sprintf("PORT=%s", port),
		},
		Labels: map[string]string{
			"forge.pipeline_id": req.PipelineID,
			"forge.managed":     "true",
			"forge.rollback":    "true",
		},
		Healthcheck: &container.HealthConfig{
			Test:     []string{"CMD-SHELL", previewHealthcheckCommand(port)},
			Interval: 10 * time.Second,
			Timeout:  5 * time.Second,
			Retries:  3,
		},
	}

	hostCfg := &container.HostConfig{
		PortBindings: nat.PortMap{
			containerPort: []nat.PortBinding{
				{HostIP: "0.0.0.0", HostPort: port},
			},
		},
		Resources: container.Resources{
			Memory:   512 * 1024 * 1024,
			NanoCPUs: 1_000_000_000,
		},
		RestartPolicy: container.RestartPolicy{Name: "unless-stopped"},
	}

	created, err := s.docker.ContainerCreate(ctx, containerCfg, hostCfg, nil, nil, containerName)
	if err != nil {
		s.log.Error().Err(err).Msg("rollback container create failed")
		s.writeError(w, http.StatusInternalServerError, "rollback failed: "+err.Error())
		return
	}

	if err := s.docker.ContainerStart(ctx, created.ID, container.StartOptions{}); err != nil {
		s.log.Error().Err(err).Msg("rollback container start failed")
		s.writeError(w, http.StatusInternalServerError, "rollback start failed: "+err.Error())
		return
	}

	url := fmt.Sprintf("http://localhost:%s", port)

	s.publishEvent(ctx, "docker.rollback.completed", req.PipelineID, map[string]interface{}{
		"container_id":   created.ID,
		"previous_image": req.PreviousImage,
		"url":            url,
	})

	s.log.Info().Str("container_id", created.ID).Msg("rollback completed")
	s.writeJSON(w, http.StatusOK, RollbackResponse{
		URL:         url,
		ContainerID: created.ID,
		Message:     fmt.Sprintf("rolled back to %s", req.PreviousImage),
	})
}

// GET /docker/health/{id}
func (s *Server) handleContainerHealth(w http.ResponseWriter, r *http.Request) {
	containerID := chi.URLParam(r, "id")
	if containerID == "" {
		s.writeError(w, http.StatusBadRequest, "container id is required")
		return
	}

	ctx := r.Context()

	inspect, err := s.docker.ContainerInspect(ctx, containerID)
	if err != nil {
		s.log.Error().Err(err).Str("container_id", containerID).Msg("container inspect failed")
		s.writeError(w, http.StatusNotFound, "container not found: "+err.Error())
		return
	}

	healthy := inspect.State.Running
	if inspect.State.Health != nil {
		healthy = inspect.State.Health.Status == "healthy"
	}

	// Gather resource stats.
	var cpuPercent float64
	var memoryMB float64

	statsResp, err := s.docker.ContainerStatsOneShot(ctx, containerID)
	if err == nil {
		defer statsResp.Body.Close()
		var stats container.StatsResponse
		if err := json.NewDecoder(statsResp.Body).Decode(&stats); err == nil {
			// CPU percentage calculation.
			cpuDelta := float64(stats.CPUStats.CPUUsage.TotalUsage - stats.PreCPUStats.CPUUsage.TotalUsage)
			systemDelta := float64(stats.CPUStats.SystemUsage - stats.PreCPUStats.SystemUsage)
			if systemDelta > 0 && len(stats.CPUStats.CPUUsage.PercpuUsage) > 0 {
				cpuPercent = (cpuDelta / systemDelta) * float64(len(stats.CPUStats.CPUUsage.PercpuUsage)) * 100.0
			}
			memoryMB = float64(stats.MemoryStats.Usage) / 1024.0 / 1024.0
		}
	}

	resp := HealthResponse{
		Healthy:        healthy,
		ErrorRate:      0.0,
		ResponseTimeMs: 0,
		CPUPercent:     cpuPercent,
		MemoryMB:       memoryMB,
	}

	s.log.Info().Str("container_id", containerID).Bool("healthy", healthy).Msg("health check")
	s.writeJSON(w, http.StatusOK, resp)
}

// GET /docker/list — lists all forge-managed containers.
func (s *Server) handleList(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	containers, err := s.docker.ContainerList(ctx, container.ListOptions{All: true})
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, "failed to list containers: "+err.Error())
		return
	}

	type containerInfo struct {
		ID         string `json:"id"`
		Name       string `json:"name"`
		PipelineID string `json:"pipeline_id"`
		HostPort   string `json:"host_port"`
		State      string `json:"state"`
		Image      string `json:"image"`
		Created    int64  `json:"created"`
	}

	result := make([]containerInfo, 0)
	for _, c := range containers {
		if c.Labels["forge.managed"] != "true" {
			continue
		}
		hostPort := ""
		for _, p := range c.Ports {
			if p.PublicPort > 0 {
				hostPort = fmt.Sprintf("%d", p.PublicPort)
				break
			}
		}
		name := ""
		if len(c.Names) > 0 {
			name = strings.TrimPrefix(c.Names[0], "/")
		}
		result = append(result, containerInfo{
			ID:         c.ID[:12],
			Name:       name,
			PipelineID: c.Labels["forge.pipeline_id"],
			HostPort:   hostPort,
			State:      c.State,
			Image:      c.Image,
			Created:    c.Created,
		})
	}

	s.writeJSON(w, http.StatusOK, map[string]interface{}{"containers": result})
}

// DELETE /docker/cleanup/{id}
func (s *Server) handleCleanup(w http.ResponseWriter, r *http.Request) {
	pipelineID := chi.URLParam(r, "id")
	if pipelineID == "" {
		s.writeError(w, http.StatusBadRequest, "pipeline id is required")
		return
	}
	normalizedPipelineID, err := normalizePipelineID(pipelineID)
	if err != nil {
		s.writeError(w, http.StatusBadRequest, "pipeline id must be a valid UUID")
		return
	}
	pipelineID = normalizedPipelineID

	ctx := r.Context()
	s.log.Info().Str("pipeline_id", pipelineID).Msg("cleaning up containers and images")

	removed := 0

	// List all containers with the pipeline label, including stopped ones.
	containers, err := s.docker.ContainerList(ctx, container.ListOptions{
		All: true,
	})
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, "failed to list containers: "+err.Error())
		return
	}

	for _, c := range containers {
		if c.Labels["forge.pipeline_id"] == pipelineID {
			// Stop if running.
			timeout := 10
			s.docker.ContainerStop(ctx, c.ID, container.StopOptions{Timeout: &timeout})
			// Remove container.
			if err := s.docker.ContainerRemove(ctx, c.ID, container.RemoveOptions{Force: true}); err == nil {
				removed++
				s.log.Info().Str("container_id", c.ID).Msg("removed container")
			}
		}
	}

	// Remove images tagged for this pipeline.
	imageTag := fmt.Sprintf("forge-%s", pipelineID)
	images, err := s.docker.ImageList(ctx, image.ListOptions{})
	if err == nil {
		for _, img := range images {
			for _, tag := range img.RepoTags {
				if strings.HasPrefix(tag, imageTag+":") {
					_, err := s.docker.ImageRemove(ctx, img.ID, image.RemoveOptions{Force: true, PruneChildren: true})
					if err == nil {
						removed++
						s.log.Info().Str("image", tag).Msg("removed image")
					}
				}
			}
		}
	}

	s.publishEvent(ctx, "docker.cleanup.completed", pipelineID, map[string]interface{}{
		"removed": removed,
	})

	s.writeJSON(w, http.StatusOK, CleanupResponse{
		Removed: removed,
		Message: fmt.Sprintf("cleaned up %d resources for pipeline %s", removed, pipelineID),
	})
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

func (s *Server) stopAndRemoveContainer(ctx context.Context, nameOrID string) {
	timeout := 10
	s.docker.ContainerStop(ctx, nameOrID, container.StopOptions{Timeout: &timeout})
	s.docker.ContainerRemove(ctx, nameOrID, container.RemoveOptions{Force: true})
}

func (s *Server) writeJSON(w http.ResponseWriter, status int, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

func (s *Server) writeError(w http.ResponseWriter, status int, msg string) {
	s.writeJSON(w, status, map[string]string{"error": msg})
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

func normalizePipelineID(pipelineID string) (string, error) {
	parsed, err := uuid.Parse(strings.TrimSpace(pipelineID))
	if err != nil {
		return "", err
	}
	return parsed.String(), nil
}

func validateForgeImageTag(pipelineID, imageName string) error {
	normalizedPipelineID, err := normalizePipelineID(pipelineID)
	if err != nil {
		return fmt.Errorf("pipeline_id must be a valid UUID")
	}

	expectedPrefix := fmt.Sprintf("forge-%s:", normalizedPipelineID)
	imageName = strings.TrimSpace(imageName)
	if !strings.HasPrefix(imageName, expectedPrefix) {
		return fmt.Errorf("image must match %s*", expectedPrefix)
	}

	tag := strings.TrimPrefix(imageName, expectedPrefix)
	if !dockerTagPattern.MatchString(tag) {
		return fmt.Errorf("image tag must be a valid local Docker tag")
	}

	return nil
}

func requireInternalAPIKey(expected string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			provided := r.Header.Get(internalAPIKeyHeader)
			if subtle.ConstantTimeCompare([]byte(provided), []byte(expected)) != 1 {
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusUnauthorized)
				_ = json.NewEncoder(w).Encode(map[string]string{
					"error": "internal service authentication required",
				})
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

func cleanWorkspaceContextPath(contextPath string) (string, error) {
	clean := filepath.Clean(contextPath)
	if !strings.HasPrefix(clean+"/", workspaceContextRoot+"/") {
		return "", fmt.Errorf("context_path must be under %s", workspaceContextRoot)
	}
	return clean, nil
}

// createTar builds an in-memory tar archive of the given directory.
func createTar(dir string) (*bytes.Buffer, error) {
	cleanDir, err := cleanWorkspaceContextPath(dir)
	if err != nil {
		return nil, err
	}

	buf := new(bytes.Buffer)
	tw := tar.NewWriter(buf)
	defer tw.Close()

	err = filepath.Walk(cleanDir, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(cleanDir, path)
		if err != nil {
			return err
		}
		if rel == "." {
			return nil
		}

		header, err := tar.FileInfoHeader(info, "")
		if err != nil {
			return err
		}
		header.Name = rel

		if err := tw.WriteHeader(header); err != nil {
			return err
		}

		if !info.IsDir() {
			f, err := os.Open(path)
			if err != nil {
				return err
			}
			defer f.Close()
			if _, err := io.Copy(tw, f); err != nil {
				return err
			}
		}
		return nil
	})
	return buf, err
}

// ---------------------------------------------------------------------------
// TTL-based cleanup — removes forge-managed containers older than 1 hour.
// ---------------------------------------------------------------------------

func (s *Server) ttlCleanupLoop() {
	ticker := time.NewTicker(10 * time.Minute)
	defer ticker.Stop()
	for range ticker.C {
		s.cleanupOldContainers()
	}
}

func (s *Server) cleanupOldContainers() {
	ctx := context.Background()
	containers, err := s.docker.ContainerList(ctx, container.ListOptions{All: true})
	if err != nil {
		s.log.Warn().Err(err).Msg("ttl-cleanup: failed to list containers")
		return
	}

	ttl := time.Hour
	now := time.Now()
	removed := 0

	for _, c := range containers {
		if c.Labels["forge.managed"] != "true" {
			continue
		}
		created := time.Unix(c.Created, 0)
		if now.Sub(created) < ttl {
			continue
		}
		name := ""
		if len(c.Names) > 0 {
			name = strings.TrimPrefix(c.Names[0], "/")
		}
		s.log.Info().Str("container", name).Str("pipeline", c.Labels["forge.pipeline_id"]).Msg("ttl-cleanup: removing old container")
		timeout := 10
		s.docker.ContainerStop(ctx, c.ID, container.StopOptions{Timeout: &timeout})
		if err := s.docker.ContainerRemove(ctx, c.ID, container.RemoveOptions{Force: true}); err == nil {
			removed++
		}
	}

	if removed > 0 {
		s.log.Info().Int("removed", removed).Msg("ttl-cleanup: completed")
	}
}

// ---------------------------------------------------------------------------
// Test Runner
// ---------------------------------------------------------------------------

type TestRunRequest struct {
	PipelineID     string            `json:"pipeline_id"`
	GeneratedFiles map[string]string `json:"generated_files"`
	TestFiles      map[string]string `json:"test_files"`
	Language       string            `json:"language"`
	TimeoutSeconds int               `json:"timeout_seconds"`
}

type TestRunResult struct {
	TestName     string  `json:"test_name"`
	Status       string  `json:"status"` // passed | failed | skipped | error
	DurationMs   float64 `json:"duration_ms"`
	ErrorMessage string  `json:"error_message,omitempty"`
}

type TestRunResponse struct {
	Success         bool            `json:"success"`
	TestResults     []TestRunResult `json:"test_results"`
	CoveragePercent float64         `json:"coverage_percent"`
	Passed          int             `json:"passed"`
	Failed          int             `json:"failed"`
	Skipped         int             `json:"skipped"`
	Total           int             `json:"total"`
	RawOutput       string          `json:"raw_output"`
	Language        string          `json:"language"`
	Error           string          `json:"error,omitempty"`
}

// createTarFromMap builds a tar archive from an in-memory map of path→content.
func createTarFromMap(files map[string]string) (*bytes.Buffer, error) {
	buf := new(bytes.Buffer)
	tw := tar.NewWriter(buf)
	// Create parent directories first
	dirs := map[string]bool{}
	for path := range files {
		for dir := filepath.Dir(path); dir != "." && dir != "/"; dir = filepath.Dir(dir) {
			if dirs[dir] {
				break
			}
			dirs[dir] = true
			_ = tw.WriteHeader(&tar.Header{Name: dir + "/", Mode: 0755, Typeflag: tar.TypeDir})
		}
	}
	for path, content := range files {
		data := []byte(content)
		if err := tw.WriteHeader(&tar.Header{Name: path, Mode: 0644, Size: int64(len(data))}); err != nil {
			return nil, err
		}
		if _, err := tw.Write(data); err != nil {
			return nil, err
		}
	}
	tw.Close()
	return buf, nil
}

// detectTestLanguage infers language from file extensions/names.
func detectTestLanguage(files map[string]string) string {
	for name := range files {
		base := strings.ToLower(filepath.Base(name))
		ext := strings.ToLower(filepath.Ext(name))
		switch {
		case base == "package.json" || ext == ".ts" || ext == ".tsx" || ext == ".jsx":
			return "node"
		case base == "go.mod" || ext == ".go":
			return "go"
		case ext == ".py":
			return "python"
		case ext == ".js":
			return "node"
		}
	}
	return "python"
}

// testRunnerImageAndCmd returns the Docker image + shell command for the given language.
func testRunnerImageAndCmd(lang string) (string, string) {
	switch lang {
	case "go":
		return "golang:1.22-alpine",
			"go test ./... -json 2>&1"
	case "node":
		// forge-test-node:latest has React, Vite, Vitest, testing-library
		// pre-installed in /opt/forge-cache/node_modules (NODE_PATH is set).
		// npm install only downloads packages NOT in the cache — typically <5s.
		return "forge-test-node:latest",
			"cd /app && " +
				// If no package.json, create a minimal one so npm install succeeds.
				"if [ ! -f package.json ]; then " +
				"cp /opt/forge-cache/package.json package.json; " +
				"fi; " +
				// Symlink cached node_modules as fallback, then install project deps.
				"if [ ! -d node_modules ]; then " +
				"ln -s /opt/forge-cache/node_modules node_modules 2>/dev/null || true; " +
				"fi; " +
				"if [ ! -L node_modules ]; then " +
				"npm install --offline --prefer-offline --ignore-scripts --no-audit --fund=false --silent 2>/dev/null || true; " +
				"fi; " +
				// Run tests with vitest (pre-cached), or jest if found.
				"if [ -f node_modules/.bin/vitest ] || [ -f /opt/forge-cache/node_modules/.bin/vitest ]; then " +
				"npx vitest run --reporter=json 2>&1 | tee /tmp/vitest.json; " +
				"echo '---RESULTS---'; cat /tmp/vitest.json 2>/dev/null || echo '{}'; " +
				"elif [ -f node_modules/.bin/jest ]; then " +
				"npx jest --json --outputFile=/tmp/jest.json --passWithNoTests 2>&1; " +
				"echo '---RESULTS---'; cat /tmp/jest.json 2>/dev/null || echo '{}'; " +
				"else " +
				"npx vitest run --reporter=json 2>&1 | tee /tmp/vitest.json; " +
				"echo '---RESULTS---'; cat /tmp/vitest.json 2>/dev/null || echo '{}'; " +
				"fi"
	default: // python
		return "python:3.12-slim",
			"pip install pytest pytest-json-report -q 2>&1 | tail -2; " +
				"(pip install -r requirements.txt -q 2>&1 | tail -2 || true); " +
				"pytest --json-report --json-report-file=/tmp/report.json -v 2>&1; " +
				"echo '---RESULTS---'; cat /tmp/report.json 2>/dev/null || echo '{}'"
	}
}

// parsePytestReport parses our custom python test command output.
func parsePytestReport(output string) (results []TestRunResult, passed, failed, skipped int) {
	parts := strings.SplitN(output, "---RESULTS---", 2)
	if len(parts) == 2 {
		jsonStr := strings.TrimSpace(parts[1])
		var report struct {
			Tests []struct {
				NodeID   string  `json:"nodeid"`
				Outcome  string  `json:"outcome"`
				Duration float64 `json:"duration"`
				Call     *struct {
					Longrepr string `json:"longrepr"`
				} `json:"call"`
			} `json:"tests"`
		}
		if err := json.Unmarshal([]byte(jsonStr), &report); err == nil && len(report.Tests) > 0 {
			for _, t := range report.Tests {
				errMsg := ""
				if t.Call != nil && len(t.Call.Longrepr) > 0 {
					errMsg = t.Call.Longrepr
					if len(errMsg) > 300 {
						errMsg = errMsg[:300] + "..."
					}
				}
				switch t.Outcome {
				case "passed":
					passed++
				case "failed", "error":
					failed++
				case "skipped":
					skipped++
				}
				results = append(results, TestRunResult{
					TestName: t.NodeID, Status: t.Outcome,
					DurationMs: t.Duration * 1000, ErrorMessage: errMsg,
				})
			}
			return
		}
	}
	// Fallback: parse pytest verbose text
	for _, line := range strings.Split(parts[0], "\n") {
		line = strings.TrimSpace(line)
		var name, status string
		if i := strings.Index(line, " PASSED"); i > 0 {
			name, status = strings.TrimSpace(line[:i]), "passed"
			passed++
		} else if i := strings.Index(line, " FAILED"); i > 0 {
			name, status = strings.TrimSpace(line[:i]), "failed"
			failed++
		} else if i := strings.Index(line, " SKIPPED"); i > 0 {
			name, status = strings.TrimSpace(line[:i]), "skipped"
			skipped++
		}
		if name != "" && strings.Contains(name, "::") {
			if i := strings.LastIndex(name, "["); i > 0 {
				name = strings.TrimSpace(name[:i])
			}
			results = append(results, TestRunResult{TestName: name, Status: status})
		}
	}
	return
}

// parseGoTestJSON parses `go test -json` NDJSON output.
func parseGoTestJSON(output string) (results []TestRunResult, passed, failed, skipped int) {
	type ev struct {
		Action  string  `json:"Action"`
		Test    string  `json:"Test"`
		Elapsed float64 `json:"Elapsed"`
		Output  string  `json:"Output"`
	}
	errOutputs := map[string][]string{}
	scanner := bufio.NewScanner(strings.NewReader(output))
	for scanner.Scan() {
		var e ev
		if json.Unmarshal(scanner.Bytes(), &e) != nil || e.Test == "" {
			continue
		}
		switch e.Action {
		case "pass":
			passed++
			results = append(results, TestRunResult{TestName: e.Test, Status: "passed", DurationMs: e.Elapsed * 1000})
		case "fail":
			failed++
			msg := strings.Join(errOutputs[e.Test], "")
			if len(msg) > 300 {
				msg = msg[:300] + "..."
			}
			results = append(results, TestRunResult{TestName: e.Test, Status: "failed", DurationMs: e.Elapsed * 1000, ErrorMessage: msg})
		case "skip":
			skipped++
			results = append(results, TestRunResult{TestName: e.Test, Status: "skipped"})
		case "output":
			if e.Test != "" {
				errOutputs[e.Test] = append(errOutputs[e.Test], e.Output)
			}
		}
	}
	return
}

// parseJestReport parses our custom node test command output.
func parseJestReport(output string) (results []TestRunResult, passed, failed, skipped int) {
	parts := strings.SplitN(output, "---RESULTS---", 2)
	if len(parts) < 2 {
		return
	}
	var report struct {
		TestResults []struct {
			AssertionResults []struct {
				FullName        string   `json:"fullName"`
				Status          string   `json:"status"`
				Duration        float64  `json:"duration"`
				FailureMessages []string `json:"failureMessages"`
			} `json:"assertionResults"`
		} `json:"testResults"`
	}
	if json.Unmarshal([]byte(strings.TrimSpace(parts[1])), &report) != nil {
		return
	}
	for _, suite := range report.TestResults {
		for _, t := range suite.AssertionResults {
			status := t.Status
			if status == "pending" {
				status = "skipped"
			}
			msg := ""
			if len(t.FailureMessages) > 0 {
				msg = t.FailureMessages[0]
				if len(msg) > 300 {
					msg = msg[:300] + "..."
				}
			}
			switch status {
			case "passed":
				passed++
			case "failed":
				failed++
			case "skipped":
				skipped++
			}
			results = append(results, TestRunResult{TestName: t.FullName, Status: status, DurationMs: t.Duration, ErrorMessage: msg})
		}
	}
	return
}

// parseTestOutput dispatches to the right parser and builds a TestRunResponse.
func parseTestOutput(output, lang string) TestRunResponse {
	var results []TestRunResult
	var passed, failed, skipped int
	switch lang {
	case "go":
		results, passed, failed, skipped = parseGoTestJSON(output)
	case "node":
		// Try vitest format first, then jest
		results, passed, failed, skipped = parseVitestReport(output)
		if len(results) == 0 {
			results, passed, failed, skipped = parseJestReport(output)
		}
	default:
		results, passed, failed, skipped = parsePytestReport(output)
	}
	if results == nil {
		results = []TestRunResult{}
	}
	return TestRunResponse{
		Success:     failed == 0 && (passed+skipped) > 0,
		TestResults: results,
		Passed:      passed,
		Failed:      failed,
		Skipped:     skipped,
		Total:       passed + failed + skipped,
	}
}

// parseVitestReport parses vitest --reporter=json output.
func parseVitestReport(output string) (results []TestRunResult, passed, failed, skipped int) {
	// Vitest JSON reporter outputs the JSON directly to stdout
	// Try to find JSON in the output (may be mixed with log lines)
	parts := strings.SplitN(output, "---RESULTS---", 2)
	jsonStr := output
	if len(parts) == 2 {
		jsonStr = strings.TrimSpace(parts[1])
	}

	// Vitest JSON format
	var report struct {
		TestResults []struct {
			AssertionResults []struct {
				FullName        string   `json:"fullName"`
				Status          string   `json:"status"`
				Duration        float64  `json:"duration"`
				FailureMessages []string `json:"failureMessages"`
			} `json:"assertionResults"`
		} `json:"testResults"`
		// Vitest also nests under numPassedTests etc.
		NumPassedTests  int `json:"numPassedTests"`
		NumFailedTests  int `json:"numFailedTests"`
		NumTotalTests   int `json:"numTotalTests"`
		NumPendingTests int `json:"numPendingTests"`
	}

	if err := json.Unmarshal([]byte(jsonStr), &report); err != nil {
		return
	}

	for _, suite := range report.TestResults {
		for _, t := range suite.AssertionResults {
			status := t.Status
			// Vitest uses "pass"/"fail" while Jest uses "passed"/"failed"
			switch status {
			case "pass", "passed":
				status = "passed"
				passed++
			case "fail", "failed":
				status = "failed"
				failed++
			case "pending", "skipped", "skip":
				status = "skipped"
				skipped++
			}
			msg := ""
			if len(t.FailureMessages) > 0 {
				msg = t.FailureMessages[0]
				if len(msg) > 300 {
					msg = msg[:300] + "..."
				}
			}
			results = append(results, TestRunResult{
				TestName:     t.FullName,
				Status:       status,
				DurationMs:   t.Duration,
				ErrorMessage: msg,
			})
		}
	}

	// If no assertion results but we have summary counts, use those
	if len(results) == 0 && report.NumTotalTests > 0 {
		passed = report.NumPassedTests
		failed = report.NumFailedTests
		skipped = report.NumPendingTests
		for i := 0; i < passed; i++ {
			results = append(results, TestRunResult{
				TestName: fmt.Sprintf("test_%d", i+1), Status: "passed", DurationMs: 10,
			})
		}
		for i := 0; i < failed; i++ {
			results = append(results, TestRunResult{
				TestName: fmt.Sprintf("test_failed_%d", i+1), Status: "failed", DurationMs: 10,
			})
		}
	}
	return
}

// POST /docker/test — runs tests inside an isolated container.
func (s *Server) handleRunTests(w http.ResponseWriter, r *http.Request) {
	var req TestRunRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		s.writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if req.PipelineID == "" {
		s.writeError(w, http.StatusBadRequest, "pipeline_id is required")
		return
	}
	pipelineID, err := normalizePipelineID(req.PipelineID)
	if err != nil {
		s.writeError(w, http.StatusBadRequest, "pipeline_id must be a valid UUID")
		return
	}
	req.PipelineID = pipelineID

	// Merge generated + test files
	allFiles := make(map[string]string, len(req.GeneratedFiles)+len(req.TestFiles))
	for k, v := range req.GeneratedFiles {
		allFiles[k] = v
	}
	for k, v := range req.TestFiles {
		allFiles[k] = v
	}
	if len(allFiles) == 0 {
		s.writeJSON(w, http.StatusOK, TestRunResponse{Success: true, TestResults: []TestRunResult{}, Language: "unknown"})
		return
	}

	lang := req.Language
	if lang == "" {
		lang = detectTestLanguage(allFiles)
	}
	timeoutSec := req.TimeoutSeconds
	if timeoutSec <= 0 || timeoutSec > 300 {
		timeoutSec = 120
	}

	// Build tar from in-memory files (avoids bind-mount host-path issues)
	tarBuf, err := createTarFromMap(allFiles)
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, "failed to prepare test files: "+err.Error())
		return
	}

	testImage, testCmd := testRunnerImageAndCmd(lang)
	ctx := r.Context()

	// Pull image (cached after first run; ignore errors — Docker will pull on create anyway)
	pullCtx, pullCancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer pullCancel()
	if rc, err := s.docker.ImagePull(pullCtx, testImage, image.PullOptions{}); err == nil {
		io.Copy(io.Discard, rc)
		rc.Close()
	}

	// Create isolated container (no network, memory-capped)
	cName := fmt.Sprintf("forge-test-%s-%s", req.PipelineID[:8], uuid.New().String()[:8])
	created, err := s.docker.ContainerCreate(ctx, &container.Config{
		Image:      testImage,
		Cmd:        []string{"sh", "-c", testCmd},
		WorkingDir: "/app",
	}, &container.HostConfig{
		NetworkMode: "none",
		Resources:   container.Resources{Memory: 1024 * 1024 * 1024, NanoCPUs: 2_000_000_000},
	}, nil, nil, cName)
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, "failed to create test container: "+err.Error())
		return
	}
	defer s.docker.ContainerRemove(context.Background(), created.ID, container.RemoveOptions{Force: true})

	// Copy files into the container before starting
	if err := s.docker.CopyToContainer(ctx, created.ID, "/app", tarBuf, types.CopyToContainerOptions{}); err != nil {
		s.writeError(w, http.StatusInternalServerError, "failed to copy files into test container: "+err.Error())
		return
	}

	// Start the container
	if err := s.docker.ContainerStart(ctx, created.ID, container.StartOptions{}); err != nil {
		s.writeError(w, http.StatusInternalServerError, "failed to start test container: "+err.Error())
		return
	}

	// Wait with timeout
	waitCtx, waitCancel := context.WithTimeout(context.Background(), time.Duration(timeoutSec)*time.Second)
	defer waitCancel()
	timedOut := false
	statusC, errC := s.docker.ContainerWait(waitCtx, created.ID, container.WaitConditionNotRunning)
	select {
	case res := <-statusC:
		s.log.Info().Str("pipeline_id", req.PipelineID).Int64("exit_code", res.StatusCode).Msg("test container finished")
	case err := <-errC:
		s.log.Warn().Err(err).Str("pipeline_id", req.PipelineID).Msg("test container wait error")
	case <-waitCtx.Done():
		timedOut = true
		s.log.Warn().Str("pipeline_id", req.PipelineID).Msg("test execution timed out")
		s.docker.ContainerStop(context.Background(), created.ID, container.StopOptions{})
	}

	// Collect logs (stdout + stderr)
	logReader, err := s.docker.ContainerLogs(context.Background(), created.ID,
		container.LogsOptions{ShowStdout: true, ShowStderr: true})
	rawOutput := ""
	if err == nil {
		defer logReader.Close()
		var stdout, stderr bytes.Buffer
		stdcopy.StdCopy(&stdout, &stderr, logReader)
		rawOutput = stdout.String() + stderr.String()
	}

	resp := parseTestOutput(rawOutput, lang)
	resp.Language = lang
	resp.RawOutput = rawOutput
	if timedOut && resp.Total == 0 {
		resp.Success = false
		resp.Error = "test execution timed out before producing results"
	}

	s.log.Info().
		Str("pipeline_id", req.PipelineID).
		Str("lang", lang).
		Int("passed", resp.Passed).
		Int("failed", resp.Failed).
		Int("total", resp.Total).
		Msg("test execution complete")

	s.writeJSON(w, http.StatusOK, resp)
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

func main() {
	internalAPIKey := os.Getenv("INTERNAL_API_KEY")
	if internalAPIKey == "" {
		fmt.Fprintln(os.Stderr, "fatal: INTERNAL_API_KEY environment variable is not set — refusing to start")
		os.Exit(1)
	}

	srv, err := NewServer()
	if err != nil {
		fmt.Fprintf(os.Stderr, "fatal: %v\n", err)
		os.Exit(1)
	}

	r := chi.NewRouter()

	// Middleware
	r.Use(middleware.RequestID)
	r.Use(middleware.RealIP)
	r.Use(middleware.Recoverer)
	r.Use(securityHeaders)
	r.Use(requireInternalAPIKey(internalAPIKey))

	// Health
	r.Get("/health", srv.handleHealth)

	// Docker operations
	r.Route("/docker", func(r chi.Router) {
		r.Post("/build", srv.handleBuild)
		r.Post("/deploy", srv.handleDeploy)
		r.Post("/rollback", srv.handleRollback)
		r.Get("/list", srv.handleList)
		r.Get("/health/{id}", srv.handleContainerHealth)
		r.Delete("/cleanup/{id}", srv.handleCleanup)
		r.Post("/test", srv.handleRunTests)
	})

	// Start background TTL cleanup for old forge-managed containers (1-hour TTL).
	go srv.ttlCleanupLoop()

	addr := ":8082"
	srv.log.Info().Str("addr", addr).Msg("forge-docker-svc starting")

	httpSrv := &http.Server{
		Addr:         addr,
		Handler:      r,
		ReadTimeout:  30 * time.Second,
		WriteTimeout: 180 * time.Second,
	}

	go func() {
		if err := httpSrv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			srv.log.Fatal().Err(err).Msg("server exited")
		}
	}()

	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit
	srv.log.Info().Msg("shutting down")

	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer shutdownCancel()
	if err := httpSrv.Shutdown(shutdownCtx); err != nil {
		srv.log.Fatal().Err(err).Msg("server forced to shutdown")
	}
	srv.log.Info().Msg("server stopped")
}

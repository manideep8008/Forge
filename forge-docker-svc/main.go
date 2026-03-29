package main

import (
	"archive/tar"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/docker/docker/api/types"
	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/image"
	"github.com/docker/docker/client"
	"github.com/docker/go-connections/nat"
	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/google/uuid"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"github.com/redis/go-redis/v9"
	"github.com/rs/zerolog"
)

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

var (
	httpRequestsTotal = prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Name: "forge_docker_http_requests_total",
			Help: "Total HTTP requests handled by forge-docker-svc",
		},
		[]string{"method", "path", "status"},
	)
	httpRequestDuration = prometheus.NewHistogramVec(
		prometheus.HistogramOpts{
			Name:    "forge_docker_http_request_duration_seconds",
			Help:    "HTTP request duration in seconds",
			Buckets: prometheus.DefBuckets,
		},
		[]string{"method", "path"},
	)
	dockerBuildsTotal = prometheus.NewCounter(prometheus.CounterOpts{
		Name: "forge_docker_builds_total",
		Help: "Total Docker image builds",
	})
	dockerDeploysTotal = prometheus.NewCounter(prometheus.CounterOpts{
		Name: "forge_docker_deploys_total",
		Help: "Total Docker container deploys",
	})
)

func init() {
	prometheus.MustRegister(httpRequestsTotal, httpRequestDuration, dockerBuildsTotal, dockerDeploysTotal)
}

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
// Prometheus middleware
// ---------------------------------------------------------------------------

func prometheusMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		ww := middleware.NewWrapResponseWriter(w, r.ProtoMajor)
		next.ServeHTTP(ww, r)
		duration := time.Since(start).Seconds()

		path := r.URL.Path
		httpRequestsTotal.WithLabelValues(r.Method, path, fmt.Sprintf("%d", ww.Status())).Inc()
		httpRequestDuration.WithLabelValues(r.Method, path).Observe(duration)
	})
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

	imageTag := fmt.Sprintf("forge-%s:latest", req.PipelineID)
	if req.Tag != "" {
		imageTag = req.Tag
	}

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

	dockerBuildsTotal.Inc()

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
			Test:     []string{"CMD-SHELL", fmt.Sprintf("wget -qO- http://localhost:%s/health || wget -qO- http://localhost:%s/ || exit 1", req.Port, req.Port)},
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

	dockerDeploysTotal.Inc()

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
			Test:     []string{"CMD-SHELL", fmt.Sprintf("wget -qO- http://localhost:%s/health || wget -qO- http://localhost:%s/ || exit 1", port, port)},
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

// createTar builds an in-memory tar archive of the given directory.
func createTar(dir string) (*bytes.Buffer, error) {
	buf := new(bytes.Buffer)
	tw := tar.NewWriter(buf)
	defer tw.Close()

	err := filepath.Walk(dir, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(dir, path)
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
// Main
// ---------------------------------------------------------------------------

func main() {
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
	r.Use(prometheusMiddleware)

	// Prometheus metrics
	r.Handle("/metrics", promhttp.Handler())

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
	})

	// Start background TTL cleanup for old forge-managed containers (1-hour TTL).
	go srv.ttlCleanupLoop()

	addr := ":8082"
	srv.log.Info().Str("addr", addr).Msg("forge-docker-svc starting")

	httpSrv := &http.Server{
		Addr:         addr,
		Handler:      r,
		ReadTimeout:  30 * time.Second,
		WriteTimeout: 120 * time.Second,
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

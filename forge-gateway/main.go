package main

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"forge-gateway/handlers"
	"forge-gateway/middleware"
	wshub "forge-gateway/websocket"

	"github.com/go-chi/chi/v5"
	chimw "github.com/go-chi/chi/v5/middleware"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"github.com/redis/go-redis/v9"
	"github.com/rs/zerolog"
	"github.com/rs/zerolog/log"
)

func main() {
	// Structured JSON logging via zerolog.
	zerolog.TimeFieldFormat = zerolog.TimeFormatUnix
	log.Logger = zerolog.New(os.Stdout).With().Timestamp().Str("service", "forge-gateway").Logger()

	// ── Redis client ────────────────────────────────────────────────
	redisURL := envOrDefault("REDIS_URL", "redis://localhost:6379")
	opts, err := redis.ParseURL(redisURL)
	if err != nil {
		log.Fatal().Err(err).Msg("invalid REDIS_URL")
	}
	rdb := redis.NewClient(opts)
	if err := rdb.Ping(context.Background()).Err(); err != nil {
		log.Warn().Err(err).Msg("redis not reachable at startup – will retry on demand")
	}

	// ── WebSocket hub ───────────────────────────────────────────────
	hub := wshub.NewHub(rdb)
	go hub.Run()

	// ── Router ──────────────────────────────────────────────────────
	r := chi.NewRouter()

	// Global middleware chain (applied to all routes).
	r.Use(chimw.RealIP)
	r.Use(chimw.Recoverer)
	r.Use(middleware.CORSMiddleware)
	r.Use(middleware.CorrelationID)

	// Public endpoints (no auth, no response-wrapping logger).
	r.Get("/health", handlers.Health(rdb))
	r.Handle("/metrics", promhttp.Handler())

	// WebSocket – no ResponseWriter-wrapping middleware (breaks http.Hijacker).
	r.Get("/ws/pipeline/{id}", hub.ServeWS)

	// API routes with logging, auth, and rate limiting.
	r.Group(func(api chi.Router) {
		api.Use(middleware.RequestLogger)
		api.Use(middleware.JWTAuth)
		api.Use(middleware.RateLimiter(rdb))

		// Pipeline CRUD.
		api.Post("/api/pipeline", handlers.CreatePipeline)
		api.Get("/api/pipeline/{id}", handlers.GetPipelineStatus)
		api.Get("/api/pipeline/{id}/status", handlers.GetPipelineStatus)
		api.Get("/api/pipeline/{id}/diff", handlers.GetPipelineDiff)
		api.Post("/api/pipeline/{id}/approve", handlers.ApprovePipeline)
		api.Get("/api/pipelines", handlers.ListPipelines)
	})

	// ── Server ──────────────────────────────────────────────────────
	port := envOrDefault("PORT", "8080")
	srv := &http.Server{
		Addr:         ":" + port,
		Handler:      r,
		ReadTimeout:  15 * time.Second,
		WriteTimeout: 15 * time.Second,
		IdleTimeout:  60 * time.Second,
	}

	// Graceful shutdown.
	done := make(chan os.Signal, 1)
	signal.Notify(done, os.Interrupt, syscall.SIGTERM)

	go func() {
		log.Info().Str("port", port).Msg("forge-gateway listening")
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatal().Err(err).Msg("server failed")
		}
	}()

	<-done
	log.Info().Msg("shutting down")

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	hub.Shutdown()
	if err := srv.Shutdown(ctx); err != nil {
		log.Error().Err(err).Msg("server shutdown error")
	}
	_ = rdb.Close()
	fmt.Println("bye")
}

func envOrDefault(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

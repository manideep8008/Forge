package main

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"forge-gateway/database"
	"forge-gateway/handlers"
	"forge-gateway/middleware"
	wshub "forge-gateway/websocket"

	"github.com/go-chi/chi/v5"
	chimw "github.com/go-chi/chi/v5/middleware"
	"github.com/redis/go-redis/v9"
	"github.com/rs/zerolog"
	"github.com/rs/zerolog/log"
)

func main() {
	// Structured JSON logging via zerolog.
	zerolog.TimeFieldFormat = zerolog.TimeFormatUnix
	log.Logger = zerolog.New(os.Stdout).With().Timestamp().Str("service", "forge-gateway").Logger()

	// ── PostgreSQL pool ─────────────────────────────────────────────
	if err := database.Init(context.Background()); err != nil {
		log.Warn().Err(err).Msg("postgres not reachable at startup – auth endpoints will be unavailable")
	}

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

	// ── JWT secret validation ──────────────────────────────────────
	if os.Getenv("JWT_SECRET") == "" {
		log.Fatal().Msg("JWT_SECRET environment variable is not set — this is required in production")
	}
	if os.Getenv("INTERNAL_API_KEY") == "" {
		log.Fatal().Msg("INTERNAL_API_KEY environment variable is not set — internal services require shared-secret authentication")
	}

	// ── WebSocket hub ───────────────────────────────────────────────
	hub := wshub.NewHub(rdb, database.PoolContext)
	go hub.Run()

	// ── Router ──────────────────────────────────────────────────────
	r := chi.NewRouter()

	// Global middleware chain (applied to all routes).
	r.Use(chimw.RealIP)
	r.Use(chimw.Recoverer)
	r.Use(middleware.SecurityHeaders)
	r.Use(middleware.CORSMiddleware)
	r.Use(middleware.CorrelationID)

	// Public endpoints (no auth, no response-wrapping logger).
	r.Get("/health", handlers.Health(rdb))

	// Auth endpoints (unauthenticated).
	authHandler := handlers.NewAuthHandler(rdb)
	r.Post("/auth/register", authHandler.Register)
	r.Post("/auth/login", authHandler.Login)
	r.Post("/auth/refresh", authHandler.Refresh)
	r.Post("/auth/logout", authHandler.Logout)

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
		api.Delete("/api/pipeline/{id}", handlers.DeletePipeline)
		api.Post("/api/pipeline/{id}/cancel", handlers.CancelPipeline)
		api.Post("/api/pipeline/{id}/retry", handlers.RetryPipeline)
		api.Post("/api/pipeline/{id}/modify", handlers.ModifyPipeline)
		api.Post("/api/pipeline/{id}/fork", handlers.ProxyHandler())
		api.Get("/api/pipelines", handlers.ListPipelines)

		// Collaboration + intelligence features (generic proxy to orchestrator).
		api.Get("/api/pipeline/{id}/comments", handlers.ProxyHandler())
		api.Post("/api/pipeline/{id}/comments", handlers.ProxyHandler())
		api.Get("/api/workspaces", handlers.ProxyHandler())
		api.Post("/api/workspaces", handlers.ProxyHandler())
		api.Get("/api/workspaces/{id}", handlers.ProxyHandler())
		api.Post("/api/workspaces/{id}/members", handlers.ProxyHandler())
		api.Get("/api/workspaces/{id}/pipelines", handlers.ProxyHandler())
		api.Get("/api/templates", handlers.ProxyHandler())
		api.Post("/api/templates", handlers.ProxyHandler())
		api.Delete("/api/templates/{id}", handlers.ProxyHandler())
		api.Get("/api/schedules", handlers.ProxyHandler())
		api.Post("/api/schedules", handlers.ProxyHandler())
		api.Patch("/api/schedules/{id}", handlers.ProxyHandler())
		api.Delete("/api/schedules/{id}", handlers.ProxyHandler())
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
	database.Close()
	fmt.Println("bye")
}

func envOrDefault(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

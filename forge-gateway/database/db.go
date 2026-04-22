package database

import (
	"context"
	"os"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

var (
	pool *pgxpool.Pool
	mu   sync.RWMutex
)

// Init opens a connection pool to PostgreSQL. Safe to call multiple times.
// Failed attempts do not poison future calls; the next Init/Pool call retries.
func Init(ctx context.Context) error {
	_, err := ensurePool(ctx)
	return err
}

// Pool returns the shared connection pool. It lazily initializes the pool and
// reconnects if the current pool fails a ping.
func Pool() *pgxpool.Pool {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	return PoolContext(ctx)
}

// PoolContext returns the shared connection pool using the caller's context for
// initialization and ping checks. It returns nil when PostgreSQL is unavailable.
func PoolContext(ctx context.Context) *pgxpool.Pool {
	p, err := ensurePool(ctx)
	if err != nil {
		return nil
	}
	return p
}

// Close shuts down the connection pool.
func Close() {
	mu.Lock()
	defer mu.Unlock()
	if pool != nil {
		pool.Close()
		pool = nil
	}
}

func ensurePool(ctx context.Context) (*pgxpool.Pool, error) {
	if p := currentPool(); p != nil {
		err := p.Ping(ctx)
		if err == nil {
			return p, nil
		}
		if ctx.Err() != nil {
			return nil, err
		}
		resetPoolIfCurrent(p)
	}

	mu.Lock()
	defer mu.Unlock()

	if pool != nil {
		err := pool.Ping(ctx)
		if err == nil {
			return pool, nil
		}
		if ctx.Err() != nil {
			return nil, err
		}
		pool.Close()
		pool = nil
	}

	next, err := pgxpool.New(ctx, postgresDSN())
	if err != nil {
		return nil, err
	}
	if err := next.Ping(ctx); err != nil {
		next.Close()
		return nil, err
	}
	pool = next
	return pool, nil
}

func currentPool() *pgxpool.Pool {
	mu.RLock()
	defer mu.RUnlock()
	return pool
}

func resetPoolIfCurrent(stale *pgxpool.Pool) {
	mu.Lock()
	defer mu.Unlock()
	if pool == stale {
		pool.Close()
		pool = nil
	}
}

func postgresDSN() string {
	if dsn := os.Getenv("POSTGRES_URL"); dsn != "" {
		return dsn
	}
	return "postgresql://forge:forge_dev_password@localhost:5432/forge"
}

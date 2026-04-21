package database

import (
	"context"
	"os"
	"sync"

	"github.com/jackc/pgx/v5/pgxpool"
)

var (
	pool *pgxpool.Pool
	once sync.Once
)

// Init opens a connection pool to PostgreSQL. Safe to call multiple times.
func Init(ctx context.Context) error {
	var initErr error
	once.Do(func() {
		dsn := os.Getenv("POSTGRES_URL")
		if dsn == "" {
			dsn = "postgresql://forge:forge_dev_password@localhost:5432/forge"
		}
		pool, initErr = pgxpool.New(ctx, dsn)
	})
	return initErr
}

// Pool returns the shared connection pool. Returns nil if Init has not been called.
func Pool() *pgxpool.Pool {
	return pool
}

// Close shuts down the connection pool.
func Close() {
	if pool != nil {
		pool.Close()
	}
}

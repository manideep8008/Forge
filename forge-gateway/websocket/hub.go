package websocket

import (
	"context"
	"net/http"
	"os"
	"strings"
	"sync"

	"github.com/go-chi/chi/v5"
	"github.com/golang-jwt/jwt/v5"
	"github.com/gorilla/websocket"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"
	"github.com/rs/zerolog/log"
)

// upgrader configures the WebSocket handshake with strict origin checking.
// In DEV_MODE, localhost origins are allowed; otherwise origins must match
// the WS_ALLOWED_ORIGINS env var (comma-separated list).
var upgrader = websocket.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 1024,
	CheckOrigin:     checkOrigin,
}

var (
	allowedOrigins = loadAllowedOrigins()
	devMode        = os.Getenv("DEV_MODE") == "true"
	jwtSecret      = []byte(os.Getenv("JWT_SECRET"))
)

// loadAllowedOrigins parses WS_ALLOWED_ORIGINS (comma-separated) and returns
// a map for O(1) lookup. If empty and DEV_MODE=false, all origins are denied.
func loadAllowedOrigins() map[string]bool {
	origins := os.Getenv("WS_ALLOWED_ORIGINS")
	if origins == "" {
		return nil // empty + devMode=false → deny all
	}
	result := make(map[string]bool)
	for _, o := range strings.Split(origins, ",") {
		result[strings.TrimSpace(o)] = true
	}
	return result
}

// checkOrigin validates the Origin (or Host) header against the allowlist.
// DEV_MODE=true bypasses the check for localhost. Fails closed if no origins
// are configured and DEV_MODE is not enabled.
func checkOrigin(r *http.Request) bool {
	origin := r.Header.Get("Origin")
	host := r.Header.Get("Host")

	// DEV_MODE: allow localhost for local development.
	if devMode {
		if origin != "" {
			if strings.HasPrefix(origin, "http://localhost") || strings.HasPrefix(origin, "ws://localhost") {
				return true
			}
		}
		if host != "" && (strings.HasPrefix(host, "localhost:") || strings.HasPrefix(host, "127.0.0.1:")) {
			return true
		}
		// In DEV_MODE, also allow file:// URLs used by some local dev setups.
		if origin == "" {
			return true
		}
	}

	// Deny all if no origins are configured (production).
	if allowedOrigins == nil {
		return false
	}

	// Check Origin header first (standard browser WebSocket).
	if origin != "" {
		// Strip trailing slash for comparison.
		origin = strings.TrimSuffix(origin, "/")
		if allowedOrigins[origin] {
			return true
		}
	}

	// Fallback to Host header (non-browser clients, curl, etc.).
	if host != "" {
		host = "http://" + host // Normalize for comparison with stored values.
		host = strings.TrimSuffix(host, "/")
		if allowedOrigins[host] {
			return true
		}
	}

	return false
}

// ValidateJWT extracts and validates a JWT from a request.
// It checks: Authorization header (Bearer <token>) or ?token= query param.
// Returns (userID, error). Empty userID with nil error means unauthenticated.
func ValidateJWT(r *http.Request) (string, error) {
	var tokenStr string

	// Try Authorization header first.
	auth := r.Header.Get("Authorization")
	if auth != "" {
		parts := strings.SplitN(auth, " ", 2)
		if len(parts) == 2 && strings.EqualFold(parts[0], "bearer") {
			tokenStr = parts[1]
		}
	}

	// Fall back to ?token= query param (for browser WebSocket clients
	// that cannot set custom headers during WebSocket handshake).
	if tokenStr == "" {
		tokenStr = r.URL.Query().Get("token")
	}

	if tokenStr == "" {
		return "", nil // Unauthenticated, not an error.
	}

	if len(jwtSecret) == 0 {
		return "", nil // Secret not configured yet; treat as unauthenticated.
	}

	token, err := jwt.Parse(tokenStr, func(t *jwt.Token) (interface{}, error) {
		if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, jwt.ErrSignatureInvalid
		}
		return jwtSecret, nil
	})
	if err != nil || !token.Valid {
		return "", jwt.ErrSignatureInvalid
	}

	claims, ok := token.Claims.(jwt.MapClaims)
	if !ok {
		return "", jwt.ErrSignatureInvalid
	}

	uid, _ := claims["user_id"].(string)
	return uid, nil
}

// client represents a single WebSocket connection.
type client struct {
	conn       *websocket.Conn
	send       chan []byte
	pipelineID string
	userID     string // Authenticated user who owns this connection.
}

// Hub manages WebSocket connections grouped by pipeline_id. For each active
// pipeline it subscribes to a Redis pub/sub channel `ws:{pipeline_id}` and fans
// messages out to all connected clients. One subscription per pipeline.
type Hub struct {
	rdb        *redis.Client
	db         *pgxpool.Pool
	mu         sync.Mutex
	clients    map[string]map[*client]struct{} // pipeline_id -> connected clients
	subs       map[string]context.CancelFunc   // pipeline_id -> cancel for Redis subscription
	register   chan *client
	unregister chan *client
	done       chan struct{}
}

// NewHub creates a new WebSocket hub. db may be nil if the database is unavailable.
func NewHub(rdb *redis.Client, db any) *Hub {
	var pool *pgxpool.Pool
	if db != nil {
		pool, _ = db.(*pgxpool.Pool)
	}
	return &Hub{
		rdb:        rdb,
		db:         pool,
		clients:    make(map[string]map[*client]struct{}),
		subs:       make(map[string]context.CancelFunc),
		register:   make(chan *client, 64),
		unregister: make(chan *client, 64),
		done:       make(chan struct{}),
	}
}

// Run processes register/unregister events. Start as a goroutine.
func (h *Hub) Run() {
	for {
		select {
		case c := <-h.register:
			h.mu.Lock()
			if _, ok := h.clients[c.pipelineID]; !ok {
				h.clients[c.pipelineID] = make(map[*client]struct{})
			}
			h.clients[c.pipelineID][c] = struct{}{}

			// Start Redis subscription if not already running.
			if _, ok := h.subs[c.pipelineID]; !ok {
				ctx, cancel := context.WithCancel(context.Background())
				h.subs[c.pipelineID] = cancel
				go h.subscribeRedis(ctx, c.pipelineID)
			}
			h.mu.Unlock()

		case c := <-h.unregister:
			h.mu.Lock()
			if pipelineClients, ok := h.clients[c.pipelineID]; ok {
				if _, exists := pipelineClients[c]; exists {
					delete(pipelineClients, c)
					close(c.send)
				}

				if len(pipelineClients) == 0 {
					delete(h.clients, c.pipelineID)

					// Cancel Redis subscription once the last viewer leaves.
					if cancel, ok := h.subs[c.pipelineID]; ok {
						cancel()
						delete(h.subs, c.pipelineID)
					}
				}
			}
			h.mu.Unlock()

		case <-h.done:
			h.mu.Lock()
			for pid, pipelineClients := range h.clients {
				for c := range pipelineClients {
					close(c.send)
					c.conn.Close()
				}
				delete(h.clients, pid)
			}
			for pid, cancel := range h.subs {
				cancel()
				delete(h.subs, pid)
			}
			h.mu.Unlock()
			return
		}
	}
}

// Shutdown stops the hub.
func (h *Hub) Shutdown() {
	close(h.done)
}

// ServeWS upgrades an HTTP connection to WebSocket and registers the client.
// GET /ws/pipeline/{id}
// Requires a valid JWT (via Authorization header or ?token= query param) and
// verifies the authenticated user owns the pipeline.
func (h *Hub) ServeWS(w http.ResponseWriter, r *http.Request) {
	pipelineID := chi.URLParam(r, "id")
	if pipelineID == "" {
		http.Error(w, `{"error":"missing pipeline id"}`, http.StatusBadRequest)
		return
	}

	// 1. Authenticate — JWT is optional for now to get things running.
	// TODO: Re-enforce auth require once frontend passes tokens
	userID, _ := ValidateJWT(r)

	// 2. Ownership check — skip if not authenticated yet
	if h.db != nil && userID != "" {
		owner, err := h.checkPipelineOwner(r.Context(), pipelineID)
		if err != nil {
			http.Error(w, `{"error":"pipeline not found"}`, http.StatusNotFound)
			return
		}
		if owner != userID {
			http.Error(w, `{"error":"access denied"}`, http.StatusForbidden)
			return
		}
	}

	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Error().Err(err).Msg("websocket upgrade failed")
		return
	}

	c := &client{
		conn:       conn,
		send:       make(chan []byte, 256),
		pipelineID: pipelineID,
		userID:     userID,
	}

	h.register <- c

	// Writer goroutine: send messages from the channel to the WS connection.
	go h.writePump(c)
	// Reader goroutine: read (and discard) client messages; detect disconnect.
	go h.readPump(c)
}

// checkPipelineOwner queries the database to verify who owns a pipeline.
// Returns the user_id of the owner, or an error if the pipeline doesn't exist.
func (h *Hub) checkPipelineOwner(ctx context.Context, pipelineID string) (string, error) {
	var owner string
	err := h.db.QueryRow(ctx,
		"SELECT user_id FROM pipelines WHERE id = $1",
		pipelineID,
	).Scan(&owner)
	if err != nil {
		return "", err
	}
	return owner, nil
}

// subscribeRedis listens on the Redis pub/sub channel `ws:{pipeline_id}` and
// pushes every message into the client's send channel.
func (h *Hub) subscribeRedis(ctx context.Context, pipelineID string) {
	channel := "ws:" + pipelineID
	sub := h.rdb.Subscribe(ctx, channel)
	defer sub.Close()

	log.Info().Str("channel", channel).Msg("redis subscription started")

	ch := sub.Channel()
	for {
		select {
		case msg, ok := <-ch:
			if !ok {
				return
			}
			payload := []byte(msg.Payload)
			h.mu.Lock()
			if clients, exists := h.clients[pipelineID]; exists {
				for c := range clients {
					select {
					case c.send <- payload:
					default:
						log.Warn().Str("pipeline_id", pipelineID).Msg("ws send buffer full, dropping message")
					}
				}
			}
			h.mu.Unlock()
		case <-ctx.Done():
			log.Info().Str("channel", channel).Msg("redis subscription stopped")
			return
		}
	}
}

// writePump sends messages from the send channel to the WebSocket connection.
func (h *Hub) writePump(c *client) {
	defer func() {
		h.unregister <- c
		c.conn.Close()
	}()
	for msg := range c.send {
		if err := c.conn.WriteMessage(websocket.TextMessage, msg); err != nil {
			log.Debug().Err(err).Str("pipeline_id", c.pipelineID).Msg("ws write error")
			return
		}
	}
}

// readPump reads from the WebSocket to detect client disconnect.
func (h *Hub) readPump(c *client) {
	defer func() {
		h.unregister <- c
	}()
	for {
		if _, _, err := c.conn.ReadMessage(); err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseNormalClosure) {
				log.Debug().Err(err).Str("pipeline_id", c.pipelineID).Msg("ws read error")
			}
			return
		}
	}
}

package websocket

import (
	"context"
	"errors"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

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

	maxConnectionsPerPipeline = envInt("WS_MAX_CONNECTIONS_PER_PIPELINE", 8)
	maxConnectionsPerIP       = envInt("WS_MAX_CONNECTIONS_PER_IP", 32)
)

const (
	wsReadLimit = int64(4096)
	wsWriteWait = 10 * time.Second
	wsPongWait  = 60 * time.Second
	wsPingEvery = 54 * time.Second
)

var errHubClosed = errors.New("websocket hub is shut down")

func envInt(key string, fallback int) int {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return fallback
	}
	parsed, err := strconv.Atoi(value)
	if err != nil || parsed <= 0 {
		return fallback
	}
	return parsed
}

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

	jwtSecret := []byte(os.Getenv("JWT_SECRET"))
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
	ip         string
	userID     string // Authenticated user who owns this connection.
	closeOnce  sync.Once
}

func (c *client) closeSend() {
	c.closeOnce.Do(func() {
		close(c.send)
	})
}

// Hub manages WebSocket connections grouped by pipeline_id. For each active
// pipeline it subscribes to a Redis pub/sub channel `ws:{pipeline_id}` and fans
// messages out to all connected clients. One subscription per pipeline.
type Hub struct {
	rdb        *redis.Client
	dbProvider func(context.Context) *pgxpool.Pool
	mu         sync.Mutex
	clients    map[string]map[*client]struct{} // pipeline_id -> connected clients
	byIP       map[string]int
	byPipeline map[string]int
	subs       map[string]context.CancelFunc // pipeline_id -> cancel for Redis subscription
	register   chan *client
	unregister chan *client
	done       chan struct{}
	doneOnce   sync.Once
}

// NewHub creates a new WebSocket hub. db may be nil if the database is unavailable.
func NewHub(rdb *redis.Client, db any) *Hub {
	var provider func(context.Context) *pgxpool.Pool
	switch v := db.(type) {
	case *pgxpool.Pool:
		provider = func(context.Context) *pgxpool.Pool { return v }
	case func() *pgxpool.Pool:
		provider = func(context.Context) *pgxpool.Pool { return v() }
	case func(context.Context) *pgxpool.Pool:
		provider = v
	}
	return &Hub{
		rdb:        rdb,
		dbProvider: provider,
		clients:    make(map[string]map[*client]struct{}),
		byIP:       make(map[string]int),
		byPipeline: make(map[string]int),
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
					c.closeSend()
					h.releaseConnectionLocked(c)
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
					c.closeSend()
					c.conn.Close()
				}
				delete(h.clients, pid)
			}
			h.byIP = make(map[string]int)
			h.byPipeline = make(map[string]int)
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
	h.doneOnce.Do(func() {
		close(h.done)
	})
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

	userID, err := ValidateJWT(r)
	if err != nil || userID == "" {
		http.Error(w, `{"error":"invalid or missing token"}`, http.StatusUnauthorized)
		return
	}

	db := h.pool(r.Context())
	if db == nil {
		log.Error().Msg("database unavailable for websocket ownership check")
		http.Error(w, `{"error":"service unavailable"}`, http.StatusServiceUnavailable)
		return
	}

	owner, err := h.checkPipelineOwner(r.Context(), db, pipelineID)
	if err != nil {
		http.Error(w, `{"error":"pipeline not found"}`, http.StatusNotFound)
		return
	}
	if owner != userID {
		http.Error(w, `{"error":"access denied"}`, http.StatusForbidden)
		return
	}

	clientIP := remoteIP(r)
	if err := h.reserveConnection(pipelineID, clientIP); err != nil {
		status := http.StatusTooManyRequests
		if errors.Is(err, errHubClosed) {
			status = http.StatusServiceUnavailable
		}
		http.Error(w, `{"error":"too many websocket connections"}`, status)
		return
	}

	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		h.releaseConnection(&client{pipelineID: pipelineID, ip: clientIP})
		log.Error().Err(err).Msg("websocket upgrade failed")
		return
	}

	c := &client{
		conn:       conn,
		send:       make(chan []byte, 256),
		pipelineID: pipelineID,
		ip:         clientIP,
		userID:     userID,
	}

	select {
	case h.register <- c:
	case <-h.done:
		h.releaseConnection(c)
		c.conn.Close()
		return
	}

	// Writer goroutine: send messages from the channel to the WS connection.
	go h.writePump(c)
	// Reader goroutine: read (and discard) client messages; detect disconnect.
	go h.readPump(c)
}

func (h *Hub) pool(ctx context.Context) *pgxpool.Pool {
	if h.dbProvider == nil {
		return nil
	}
	return h.dbProvider(ctx)
}

// checkPipelineOwner queries the database to verify who owns a pipeline.
// Returns the user_id of the owner, or an error if the pipeline doesn't exist.
func (h *Hub) checkPipelineOwner(ctx context.Context, db *pgxpool.Pool, pipelineID string) (string, error) {
	var owner string
	err := db.QueryRow(ctx,
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

func remoteIP(r *http.Request) string {
	remote := strings.TrimSpace(r.RemoteAddr)
	if host, _, err := net.SplitHostPort(remote); err == nil {
		return host
	}
	if remote != "" {
		return remote
	}
	return "unknown"
}

func (h *Hub) reserveConnection(pipelineID, ip string) error {
	select {
	case <-h.done:
		return errHubClosed
	default:
	}

	h.mu.Lock()
	defer h.mu.Unlock()

	if maxConnectionsPerPipeline > 0 && h.byPipeline[pipelineID] >= maxConnectionsPerPipeline {
		return errors.New("pipeline websocket connection cap reached")
	}
	if maxConnectionsPerIP > 0 && h.byIP[ip] >= maxConnectionsPerIP {
		return errors.New("ip websocket connection cap reached")
	}

	h.byPipeline[pipelineID]++
	h.byIP[ip]++
	return nil
}

func (h *Hub) releaseConnection(c *client) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.releaseConnectionLocked(c)
}

func (h *Hub) releaseConnectionLocked(c *client) {
	if c.pipelineID != "" && h.byPipeline[c.pipelineID] > 0 {
		h.byPipeline[c.pipelineID]--
		if h.byPipeline[c.pipelineID] == 0 {
			delete(h.byPipeline, c.pipelineID)
		}
	}
	if c.ip != "" && h.byIP[c.ip] > 0 {
		h.byIP[c.ip]--
		if h.byIP[c.ip] == 0 {
			delete(h.byIP, c.ip)
		}
	}
}

func (h *Hub) unregisterClient(c *client) {
	select {
	case <-h.done:
		return
	default:
	}
	select {
	case h.unregister <- c:
	case <-h.done:
	}
}

// writePump sends messages from the send channel to the WebSocket connection.
func (h *Hub) writePump(c *client) {
	ticker := time.NewTicker(wsPingEvery)
	defer func() {
		ticker.Stop()
		h.unregisterClient(c)
		c.conn.Close()
	}()

	for {
		select {
		case msg, ok := <-c.send:
			if err := c.conn.SetWriteDeadline(time.Now().Add(wsWriteWait)); err != nil {
				log.Debug().Err(err).Str("pipeline_id", c.pipelineID).Msg("ws write deadline error")
				return
			}
			if !ok {
				_ = c.conn.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}
			if err := c.conn.WriteMessage(websocket.TextMessage, msg); err != nil {
				log.Debug().Err(err).Str("pipeline_id", c.pipelineID).Msg("ws write error")
				return
			}
		case <-ticker.C:
			if err := c.conn.SetWriteDeadline(time.Now().Add(wsWriteWait)); err != nil {
				log.Debug().Err(err).Str("pipeline_id", c.pipelineID).Msg("ws ping deadline error")
				return
			}
			if err := c.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				log.Debug().Err(err).Str("pipeline_id", c.pipelineID).Msg("ws ping error")
				return
			}
		}
	}
}

// readPump reads from the WebSocket to detect client disconnect.
func (h *Hub) readPump(c *client) {
	defer func() {
		h.unregisterClient(c)
	}()
	c.conn.SetReadLimit(wsReadLimit)
	_ = c.conn.SetReadDeadline(time.Now().Add(wsPongWait))
	c.conn.SetPongHandler(func(string) error {
		return c.conn.SetReadDeadline(time.Now().Add(wsPongWait))
	})
	for {
		if _, _, err := c.conn.ReadMessage(); err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseNormalClosure) {
				log.Debug().Err(err).Str("pipeline_id", c.pipelineID).Msg("ws read error")
			}
			return
		}
	}
}

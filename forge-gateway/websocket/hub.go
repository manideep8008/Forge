package websocket

import (
	"context"
	"net/http"
	"sync"

	"github.com/go-chi/chi/v5"
	"github.com/gorilla/websocket"
	"github.com/redis/go-redis/v9"
	"github.com/rs/zerolog/log"
)

// upgrader configures the WebSocket handshake. Origin checking is relaxed for
// development; tighten CheckOrigin for production.
var upgrader = websocket.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 1024,
	CheckOrigin:     func(r *http.Request) bool { return true },
}

// client represents a single WebSocket connection.
type client struct {
	conn       *websocket.Conn
	send       chan []byte
	pipelineID string
}

// Hub manages WebSocket connections grouped by pipeline_id. For each active
// pipeline it subscribes to a Redis pub/sub channel `ws:{pipeline_id}` and fans
// messages out to all connected clients. One subscription per pipeline.
type Hub struct {
	rdb        *redis.Client
	mu         sync.Mutex
	clients    map[string]*client        // pipeline_id -> client (one per pipeline)
	subs       map[string]context.CancelFunc // pipeline_id -> cancel for Redis subscription
	register   chan *client
	unregister chan *client
	done       chan struct{}
}

// NewHub creates a new WebSocket hub.
func NewHub(rdb *redis.Client) *Hub {
	return &Hub{
		rdb:        rdb,
		clients:    make(map[string]*client),
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
			// If there is already a connection for this pipeline, close it.
			if existing, ok := h.clients[c.pipelineID]; ok {
				close(existing.send)
				existing.conn.Close()
			}
			h.clients[c.pipelineID] = c

			// Start Redis subscription if not already running.
			if _, ok := h.subs[c.pipelineID]; !ok {
				ctx, cancel := context.WithCancel(context.Background())
				h.subs[c.pipelineID] = cancel
				go h.subscribeRedis(ctx, c.pipelineID)
			}
			h.mu.Unlock()

		case c := <-h.unregister:
			h.mu.Lock()
			if existing, ok := h.clients[c.pipelineID]; ok && existing == c {
				close(c.send)
				delete(h.clients, c.pipelineID)

				// Cancel Redis subscription.
				if cancel, ok := h.subs[c.pipelineID]; ok {
					cancel()
					delete(h.subs, c.pipelineID)
				}
			}
			h.mu.Unlock()

		case <-h.done:
			h.mu.Lock()
			for pid, c := range h.clients {
				close(c.send)
				c.conn.Close()
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
func (h *Hub) ServeWS(w http.ResponseWriter, r *http.Request) {
	pipelineID := chi.URLParam(r, "id")
	if pipelineID == "" {
		http.Error(w, `{"error":"missing pipeline id"}`, http.StatusBadRequest)
		return
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
	}

	h.register <- c

	// Writer goroutine: send messages from the channel to the WS connection.
	go h.writePump(c)
	// Reader goroutine: read (and discard) client messages; detect disconnect.
	go h.readPump(c)
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
			h.mu.Lock()
			c, exists := h.clients[pipelineID]
			h.mu.Unlock()
			if exists {
				select {
				case c.send <- []byte(msg.Payload):
				default:
					log.Warn().Str("pipeline_id", pipelineID).Msg("ws send buffer full, dropping message")
				}
			}
		case <-ctx.Done():
			log.Info().Str("channel", channel).Msg("redis subscription stopped")
			return
		}
	}
}

// writePump sends messages from the send channel to the WebSocket connection.
func (h *Hub) writePump(c *client) {
	defer c.conn.Close()
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
		c.conn.Close()
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

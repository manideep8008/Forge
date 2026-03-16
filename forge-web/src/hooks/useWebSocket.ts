import { useEffect, useRef, useState, useCallback } from 'react';
import type { PipelineEvent } from '../types';

interface UseWebSocketReturn {
  connected: boolean;
  events: PipelineEvent[];
  lastEvent: PipelineEvent | null;
}

export function useWebSocket(pipelineId: string | undefined): UseWebSocketReturn {
  const [connected, setConnected] = useState(false);
  const [events, setEvents] = useState<PipelineEvent[]>([]);
  const [lastEvent, setLastEvent] = useState<PipelineEvent | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectAttemptRef = useRef(0);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout>>();
  const maxReconnectAttempts = 10;

  const connect = useCallback(() => {
    if (!pipelineId) return;

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host;
    const url = `${protocol}//${host}/ws/pipeline/${pipelineId}`;

    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
      reconnectAttemptRef.current = 0;
    };

    ws.onmessage = (event) => {
      try {
        const parsed: PipelineEvent = JSON.parse(event.data);
        setEvents((prev) => [...prev, parsed]);
        setLastEvent(parsed);
      } catch {
        console.error('Failed to parse WebSocket message:', event.data);
      }
    };

    ws.onclose = () => {
      setConnected(false);
      wsRef.current = null;

      if (reconnectAttemptRef.current < maxReconnectAttempts) {
        const delay = Math.min(
          1000 * Math.pow(2, reconnectAttemptRef.current),
          30000,
        );
        reconnectAttemptRef.current += 1;
        reconnectTimeoutRef.current = setTimeout(connect, delay);
      }
    };

    ws.onerror = () => {
      ws.close();
    };
  }, [pipelineId]);

  useEffect(() => {
    if (!pipelineId) return;

    setEvents([]);
    setLastEvent(null);
    reconnectAttemptRef.current = 0;

    connect();

    return () => {
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [connect]);

  return { connected, events, lastEvent };
}

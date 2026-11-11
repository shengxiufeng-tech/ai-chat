// 订阅房间的实时事件（SSE），维护本地的房间状态

import { useEffect, useReducer, useState } from 'react';
import type { Room, RoomEvent, RunnerState } from '../../shared/types';
import { toast } from './toast';

type State = { room: Room | null; runner: RunnerState | null };

function reducer(state: State, ev: RoomEvent | { type: 'reset' }): State {
  if (ev.type === 'reset') return { room: null, runner: null };
  if (ev.type === 'snapshot') return { room: ev.room, runner: ev.runner };
  if (ev.type === 'runner') return { ...state, runner: ev.runner };
  const room = state.room;
  if (!room) return state;
  switch (ev.type) {
    case 'room':
      return { ...state, room: { ...ev.room, messages: room.messages } };
    case 'message_added':
      if (room.messages.some((m) => m.id === ev.message.id)) return state;
      return { ...state, room: { ...room, messages: [...room.messages, ev.message] } };
    case 'message_delta':
      return {
        ...state,
        room: {
          ...room,
          messages: room.messages.map((m) =>
            m.id === ev.messageId
              ? {
                  ...m,
                  content: m.content + (ev.content ?? ''),
                  reasoning: (m.reasoning ?? '') + (ev.reasoning ?? ''),
                  ...(ev.plan ? { plan: (m.plan ?? '') + ev.plan } : {}),
                }
              : m,
          ),
        },
      };
    case 'message_updated':
      return {
        ...state,
        room: { ...room, messages: room.messages.map((m) => (m.id === ev.message.id ? ev.message : m)) },
      };
    case 'message_deleted':
      return { ...state, room: { ...room, messages: room.messages.filter((m) => m.id !== ev.messageId) } };
    case 'messages_cleared':
      return { ...state, room: { ...room, messages: [] } };
    default:
      return state;
  }
}

export function useRoom(roomId: string | null) {
  const [state, dispatch] = useReducer(reducer, { room: null, runner: null });
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    dispatch({ type: 'reset' });
    if (!roomId) return;
    const es = new EventSource(`/api/rooms/${roomId}/events`);
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.onmessage = (e) => {
      const ev = JSON.parse(e.data) as RoomEvent;
      if (ev.type === 'notice') toast(ev.text, ev.level);
      else dispatch(ev);
    };
    return () => {
      es.close();
      setConnected(false);
    };
  }, [roomId]);

  return { ...state, connected };
}
